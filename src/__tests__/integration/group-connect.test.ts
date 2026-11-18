import {
  unlockGiftWrap,
  type Rumor,
} from "applesauce-common/helpers/gift-wrap";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  createCommit,
  createApplicationMessage,
  encode,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GroupsManager } from "../../client/groups-manager.js";
import { fakeVerifyEvent } from "../../client/verify.js";
import {
  getNostrGroupIdHex,
  serializeClientState,
  deserializeClientState,
} from "../../core/client-state.js";
import type { NostrEvent } from "applesauce-core/helpers";
import type { Observer } from "../../client/nostr-interface.js";
import type { DispositionedIngestResult } from "../../client/session/group-session.js";

import { createApplicationMessageIntent } from "../../client/group/application-message.js";
import { MarmotClient } from "../../client/marmot-client.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { deserializeApplicationData } from "../../core/group-message.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../../core/group-message.js";
import { commitDigest } from "../../core/convergence.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  EventMemory,
  type IAsyncEventDatabase,
} from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers/filter";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { unixNow } from "../../utils/nostr.js";
import { MockNetwork } from "../helpers/mock-network.js";
import {
  memoryStorage,
  scopeStorage,
  type MemoryStorage,
} from "../../utils/storage.js";
import { GROUP_PREFIX, groupKeys } from "../../client/storage-keys.js";

const RELAYS = ["wss://mock-relay.test"];

/** An app-style async rumor database, kept in memory so it survives client restarts. */
class TestRumorDatabase implements IAsyncEventDatabase<Rumor> {
  readonly memory = new EventMemory<Rumor>();
  async hasEvent(id: string) {
    return this.memory.hasEvent(id);
  }
  async getEvent(id: string) {
    return this.memory.getEvent(id);
  }
  async hasReplaceable(kind: number, pubkey: string, identifier?: string) {
    return this.memory.hasReplaceable(kind, pubkey, identifier);
  }
  async getReplaceable(kind: number, pubkey: string, identifier?: string) {
    return this.memory.getReplaceable(kind, pubkey, identifier);
  }
  async getReplaceableHistory(
    kind: number,
    pubkey: string,
    identifier?: string,
  ) {
    return this.memory.getReplaceableHistory(kind, pubkey, identifier);
  }
  async getByFilters(filters: Filter | Filter[]) {
    return this.memory.getByFilters(filters);
  }
  async getTimeline(filters: Filter | Filter[]) {
    return this.memory.getTimeline(filters);
  }
  async add(event: Rumor) {
    return this.memory.add(event);
  }
  async remove(event: string | Rumor) {
    return this.memory.remove(event);
  }
  async removeByFilters(filters: Filter | Filter[]) {
    return this.memory.removeByFilters(filters);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("connection admission", () => {
  async function setup(withPeer = false) {
    const network = new MockNetwork(RELAYS);
    const observers: Partial<Observer<NostrEvent>>[] = [];
    const unsubscribes = vi.fn();
    vi.spyOn(network, "request").mockResolvedValue([]);
    const subscribed = deferred();
    vi.spyOn(network, "subscription").mockImplementation(() => ({
      subscribe(observer) {
        observers.push(observer);
        subscribed.resolve();
        return { unsubscribe: unsubscribes };
      },
    }));
    const manager = new GroupsManager({
      storage: memoryStorage(),
      signer: PrivateKeyAccount.generateNew().signer,
      network,
      verifyEvent: fakeVerifyEvent,
    });
    const group = await manager.create("queued", { relays: RELAYS });
    let peerGroup: MarmotGroup | undefined;
    if (withPeer) {
      const account = PrivateKeyAccount.generateNew();
      const peer = new MarmotClient({
        storage: memoryStorage(),
        signer: account.signer,
        network,
        clientId: "ab".repeat(32),
      });
      await peer.keyPackages.create({ relays: RELAYS });
      await manager.invite(
        group.id,
        network.events.find(
          (item) => item.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
        )!,
      );
      const welcomeRumor = await unlockGiftWrap(
        network.events.find((item) => item.kind === 1059)!,
        account.signer,
      );
      peerGroup = (await peer.joinGroupFromWelcome({ welcomeRumor })).group;
    }
    const event = (id: string): NostrEvent => ({
      id,
      pubkey: "00".repeat(32),
      sig: "00".repeat(64),
      kind: 445,
      created_at: 1,
      content: "",
      tags: [["h", getNostrGroupIdHex(group.state)]],
    });
    return {
      manager,
      group,
      network,
      observers,
      unsubscribes,
      subscribed,
      event,
      peerGroup,
    };
  }

  it("fully drains admitted generators across handles while other groups proceed", async () => {
    const { manager, group, observers, event } = await setup();
    const other = await manager.create("independent", { relays: RELAYS });
    const first = await manager.connect(group.id);
    const second = await manager.connect(group.id);
    const third = await manager.connect(other.id);
    const yielded = deferred();
    const release = deferred();
    const finished = deferred();
    const independent = deferred();
    const starts: string[] = [];
    vi.spyOn(group, "ingest").mockImplementation(async function* (events) {
      starts.push(events[0]!.id);
      if (events[0]!.id === "first") {
        yield {
          kind: "unreadable",
          event: events[0],
          errors: [new Error("stale fixture wrapper")],
          disposition: { kind: "stale", category: "stale_epoch" },
        } satisfies DispositionedIngestResult;
        yielded.resolve();
        await release.promise;
        starts.push("first-drained");
      } else finished.resolve();
    });
    vi.spyOn(other, "ingest").mockImplementation(async function* () {
      independent.resolve();
    });
    observers[0]!.next!(event("first"));
    await yielded.promise;
    observers[1]!.next!(event("second"));
    observers[2]!.next!({
      ...event("other"),
      tags: [["h", getNostrGroupIdHex(other.state)]],
    });
    await independent.promise;
    expect(starts).toEqual(["first"]);
    first.unsubscribe();
    observers[0]!.next!(event("late"));
    release.resolve();
    await finished.promise;
    expect(starts).toEqual(["first", "first-drained", "second"]);
    second.unsubscribe();
    third.unsubscribe();
  });

  it("cancels pending connectAll backfill before admission and subscription", async () => {
    const { manager, group, network, event } = await setup();
    const request = deferred<NostrEvent[]>();
    vi.spyOn(network, "request").mockReturnValue(request.promise);
    const ingest = vi.spyOn(group, "ingest");
    const listeners = group.listenerCount("disbanded");
    const handle = manager.connectAll();
    handle.unsubscribe();
    request.resolve([event("backfill")]);
    // Fence the backfill continuation without waiting on a timer.
    await request.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ingest).not.toHaveBeenCalled();
    expect(network.subscription).not.toHaveBeenCalled();
    expect(group.listenerCount("disbanded")).toBe(listeners);
    expect(group.listenerCount("ingestResult")).toBe(0);
  });

  it("recovers a failed batch and deduplicates trusted ids across handles", async () => {
    const { manager, group, observers, event } = await setup();
    const handles = [
      await manager.connect(group.id),
      await manager.connect(group.id),
    ];
    const failed = deferred();
    const finished = deferred();
    const starts: string[] = [];
    vi.spyOn(group, "ingest").mockImplementation(async function* (events) {
      starts.push(events[0]!.id);
      if (events[0]!.id === "failed") {
        failed.resolve();
        throw new Error("batch failure");
      }
      finished.resolve();
    });
    observers[0]!.next!(event("failed"));
    await failed.promise;
    observers[0]!.next!(event("same"));
    observers[1]!.next!(event("same"));
    await finished.promise;
    // A fresh backfill is an explicit fence behind both admitted callbacks.
    const fence = await manager.connect(group.id);
    expect(starts).toEqual(["failed", "same"]);
    handles.forEach((handle) => handle.unsubscribe());
    fence.unsubscribe();
  });

  it("drains queued work after disconnect and rejects later callbacks", async () => {
    const { manager, group, observers, event } = await setup();
    const handle = await manager.connect(group.id);
    const entered = deferred();
    const release = deferred();
    const done = deferred();
    const starts: string[] = [];
    vi.spyOn(group, "ingest").mockImplementation(async function* (events) {
      starts.push(events[0]!.id);
      if (events[0]!.id === "one") {
        entered.resolve();
        await release.promise;
        starts.push("drained");
      } else done.resolve();
    });
    observers[0]!.next!(event("one"));
    await entered.promise;
    observers[0]!.next!(event("two"));
    handle.unsubscribe();
    observers[0]!.next!(event("three"));
    expect(group.listenerCount("ingestResult")).toBe(1);
    release.resolve();
    await done.promise;
    const fence = await manager.connect(group.id);
    fence.unsubscribe();
    expect(starts).toEqual(["one", "drained", "two"]);
    expect(group.listenerCount("ingestResult")).toBe(0);
  });

  it("cancels direct connect backfill through AbortSignal", async () => {
    const { manager, group, network, event } = await setup();
    const requested = deferred();
    const request = deferred<NostrEvent[]>();
    vi.spyOn(network, "request").mockImplementation(() => {
      requested.resolve();
      return request.promise;
    });
    const ingest = vi.spyOn(group, "ingest");
    const controller = new AbortController();
    const connecting = manager.connect(group.id, { signal: controller.signal });
    await requested.promise;
    controller.abort();
    request.resolve([event("late")]);
    (await connecting).unsubscribe();
    expect(ingest).not.toHaveBeenCalled();
    expect(network.subscription).not.toHaveBeenCalled();
    expect(group.listenerCount("ingestResult")).toBe(0);
  });

  it.each(["connect", "connectAll"] as const)(
    "%s forwards live and settle-timer invalidations exactly once",
    async (mode) => {
      const {
        manager,
        group,
        peerGroup,
        network,
        observers,
        subscribed,
        event,
      } = await setup(true);
      let fire!: () => void;
      // The settle timer re-arms when it fires before the engine clock reaches
      // the cutoff, so the test owns the clock and passes the window first.
      let clockMs = Date.now();
      const timedGroup = new MarmotGroup(
        deserializeClientState(serializeClientState(group.state)),
        {
          storage: manager.storage,
          signer: manager.signer,
          network,
          ciphersuite: group.ciphersuite,
          now: () => clockMs,
          scheduler: {
            setTimer: (_ms, callback) => {
              fire = callback;
              return {};
            },
            clearTimer: () => {},
          },
        },
      );
      // Use the real facade, with session results controlled independently of cryptography.
      const invalidation = {
        kind: "stateInvalidated",
        commitDigest: new Uint8Array(32),
        forkEpoch: 1,
        withdrawn: [],
        disposition: { kind: "invalidated" },
      } satisfies DispositionedIngestResult;
      const ingest = vi
        .spyOn(timedGroup.session, "ingest")
        .mockImplementation(async function* () {
          yield invalidation;
        });
      vi.spyOn(timedGroup.session, "driveConvergence").mockResolvedValue([
        invalidation,
      ]);
      vi.spyOn(manager, "get").mockResolvedValue(timedGroup);
      // Registry-backed connectAll receives the same replacement through its public loaded event.
      const results: DispositionedIngestResult[] = [];
      manager.on("ingestResult", (_id, result) => {
        if (result.kind === "stateInvalidated") results.push(result);
      });
      const handle =
        mode === "connect"
          ? await manager.connect(group.id)
          : manager.connectAll();
      if (mode === "connectAll") {
        manager.unload(group.id);
        manager.emit("loaded", timedGroup);
      }
      await subscribed.promise;
      const emitted = deferred();
      timedGroup.once("ingestResult", () => emitted.resolve());
      observers.at(-1)!.next!(event("live"));
      await emitted.promise;
      expect(results).toEqual([invalidation]);
      // A real inbound commit arms the settlement callback, then the controlled
      // session driver supplies the invalidation on that timer edge.
      ingest.mockRestore();
      await peerGroup!.selfUpdate();
      for await (const result of timedGroup.ingest([network.events.at(-1)!]))
        void result;
      expect(fire).toBeTypeOf("function");
      const timerResult = deferred();
      timedGroup.once("ingestResult", () => timerResult.resolve());
      clockMs += 60_000;
      fire();
      await timerResult.promise;
      expect(results).toEqual([invalidation, invalidation]);
      handle.unsubscribe();
      expect(timedGroup.listenerCount("ingestResult")).toBe(0);
    },
  );
});

/** Resolve on the group's next applicationMessage, decoded; rejects after `ms`. */
function nextMessage(group: MarmotGroup, ms = 2000): Promise<Rumor> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    group.once("applicationMessage", (bytes: Uint8Array) => {
      clearTimeout(timer);
      resolve(deserializeApplicationData(bytes));
    });
  });
}

function chatRumor(pubkey: string, content: string): Rumor {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey,
    created_at: unixNow(),
    content,
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

describe("GroupsManager.connect / connectAll (inbound transport)", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccount: PrivateKeyAccount<any>;
  let ciphersuite: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;
  let inviteeClient: MarmotClient;
  /** The invitee's root storage, shared across restarts. */
  let memberStorage: MemoryStorage;
  let historyStore: TestRumorDatabase;
  const rumorDatabases = () => historyStore;
  /** The invitee's group-scoped view, as MarmotClient passes to groups. */
  const groupStorage = () => scopeStorage(memberStorage, GROUP_PREFIX);
  /** Reads a group's delivered-payload evidence. */
  const deliveredEvidence = async (groupId: Uint8Array) =>
    JSON.parse(
      new TextDecoder().decode(
        (await memberStorage.get(
          GROUP_PREFIX + groupKeys.delivered(bytesToHex(groupId)),
        ))!,
      ),
    );

  beforeEach(async () => {
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccount = PrivateKeyAccount.generateNew();
    ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    void ciphersuite;
    mockNetwork = new MockNetwork();

    adminClient = new MarmotClient({
      storage: memoryStorage(),
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    memberStorage = memoryStorage();
    historyStore = new TestRumorDatabase();
    inviteeClient = new MarmotClient({
      storage: memberStorage,
      rumors: rumorDatabases,
      signer: inviteeAccount.signer,
      network: mockNetwork,
      clientId: "cd".repeat(32),
    });
  });

  it.each(
    (["connect", "connectAll"] as const).flatMap((mode) =>
      (["restart", "live", "timer", "reconverge", "failure"] as const).map(
        (path) => [mode, path] as const,
      ),
    ),
  )(
    "%s retracts a real losing rumor via %s with its producing digest",
    async (mode, path) => {
      const { adminGroup, inviteeGroup } = await adminAndInvitee();
      let now = 0;
      let fire!: () => void;
      const receiver =
        path === "timer"
          ? new MarmotGroup(
              deserializeClientState(serializeClientState(inviteeGroup.state)),
              {
                storage: groupStorage(),
                rumors: rumorDatabases,
                signer: inviteeAccount.signer,
                network: mockNetwork,
                ciphersuite: inviteeGroup.ciphersuite,
                now: () => now,
                scheduler: {
                  setTimer: (_ms, callback) => {
                    fire = callback;
                    return {};
                  },
                  clearTimer: () => {},
                },
              },
            )
          : inviteeGroup;
      const context = {
        cipherSuite: adminGroup.ciphersuite,
        authService: unsafeTestingAuthenticationService,
      };
      const make = () =>
        createCommit({
          context,
          state: adminGroup.state,
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
          extraProposals: [],
        });
      const forks = await Promise.all([make(), make()]);
      forks.sort((a, b) =>
        bytesToHex(
          commitDigest(encode(mlsMessageEncoder, a.commit)),
        ).localeCompare(
          bytesToHex(commitDigest(encode(mlsMessageEncoder, b.commit))),
        ),
      );
      const [winning, losing] = forks;
      const losingEvent = await createGroupEvent({
        message: losing.commit,
        state: adminGroup.state,
        ciphersuite: adminGroup.ciphersuite,
      });
      const winningEvent = await createGroupEvent({
        message: winning.commit,
        state: adminGroup.state,
        ciphersuite: adminGroup.ciphersuite,
      });
      for await (const r of receiver.ingest([losingEvent])) void r;
      const rumor = chatRumor(
        await adminAccount.signer.getPublicKey(),
        "losing before restart",
      );
      const payload = serializeApplicationRumor(rumor);
      const app = await createApplicationMessage({
        context,
        state: losing.newState,
        message: payload,
      });
      const event = await createGroupEvent({
        message: app.message,
        state: losing.newState,
        ciphersuite: adminGroup.ciphersuite,
      });
      const accepted = [];
      for await (const r of receiver.ingest([event])) accepted.push(r);
      expect(
        accepted.some(
          (r) =>
            r.kind === "processed" && r.result.kind === "applicationMessage",
        ),
      ).toBe(true);
      expect(await receiver.history.queryRumors({})).toEqual([rumor]);
      const timeline = receiver.history.subscribe({ limit: 1 });
      expect((await timeline.next()).value).toEqual([rumor]);
      const restart = path === "restart" || path === "failure";
      if (restart) inviteeClient.groups.unload(inviteeGroup.id);
      const restarted = restart
        ? new MarmotClient({
            storage: memberStorage,
            rumors: rumorDatabases,
            signer: inviteeAccount.signer,
            network: mockNetwork,
          })
        : inviteeClient;
      const restored = restart
        ? await restarted.groups.get(inviteeGroup.id)
        : receiver;
      if (path === "timer") {
        vi.spyOn(restarted.groups, "get").mockResolvedValue(restored);
        restarted.groups.unload(inviteeGroup.id);
      }
      await timeline.return(undefined);
      const subscribedTimeline = restored.history.subscribe({ limit: 1 });
      expect((await subscribedTimeline.next()).value).toEqual([rumor]);
      const errors: Error[] = [];
      restored.on("historyError", (error) => errors.push(error));
      const failure = new Error("removal offline");
      const removal =
        path === "failure"
          ? vi.spyOn(historyStore, "remove").mockRejectedValue(failure)
          : undefined;
      const results: DispositionedIngestResult[] = [];
      const invalidated = deferred();
      restarted.groups.on("ingestResult", (_id, r) => {
        if (r.kind === "invalidated") {
          results.push(r);
          invalidated.resolve();
        }
      });
      const subscribed = deferred();
      const original = mockNetwork.subscription.bind(mockNetwork);
      vi.spyOn(mockNetwork, "subscription").mockImplementation((...args) => {
        const stream = original(...args);
        return {
          subscribe(observer) {
            const handle = stream.subscribe(observer);
            subscribed.resolve();
            return handle;
          },
        };
      });
      const handle =
        mode === "connect"
          ? await restarted.groups.connect(restored.id)
          : restarted.groups.connectAll();
      if (path === "timer" && mode === "connectAll")
        restarted.groups.emit("loaded", restored);
      await subscribed.promise;
      if (path === "reconverge") {
        restored.forkTree.recordCommit(
          bytesToHex(adminGroup.state.confirmationTag),
          winning.commit,
          winning.newState,
        );
        await restored.reconverge();
      } else {
        if (path === "timer") now = 1_000_000;
        await mockNetwork.publish(RELAYS, winningEvent);
        if (path === "timer") {
          // Fence connection admission before firing the retained-input continuation.
          const fence = await restarted.groups.connect(restored.id);
          fence.unsubscribe();
          expect(results).toEqual([]);
          expect(fire).toBeTypeOf("function");
          fire();
        }
      }
      await invalidated.promise;
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        kind: "invalidated",
        event,
        transportId: event.id,
        rumorId: rumor.id,
        payload,
        tag: bytesToHex(losing.newState.confirmationTag),
        epoch: Number(losing.newState.groupContext.epoch),
        commitDigest: commitDigest(encode(mlsMessageEncoder, losing.commit)),
      });
      handle.unsubscribe();
      let current = restored;
      if (path === "failure") {
        expect(errors).toContain(failure);
        expect(await restored.history.queryRumors({})).toEqual([rumor]);
        const saved = await deliveredEvidence(restored.id);
        expect(saved.pending[0]).toMatchObject({
          rumorId: rumor.id,
          transportId: event.id,
          commitDigest: bytesToHex(
            commitDigest(encode(mlsMessageEncoder, losing.commit)),
          ),
        });
        removal!.mockRestore();
        restarted.groups.unload(restored.id);
        const retried = new MarmotClient({
          storage: memberStorage,
          rumors: rumorDatabases,
          signer: inviteeAccount.signer,
          network: mockNetwork,
        });
        const retryGroup = await retried.groups.get(restored.id);
        current = retryGroup;
        await expect(restored.reconverge()).rejects.toThrow("Group unloaded");
        await retryGroup.reconverge();
        expect(await retryGroup.history.queryRumors({})).toEqual([]);
      } else {
        expect((await subscribedTimeline.next()).value).toEqual([]);
        expect(await historyStore.getTimeline({})).toEqual([]);
      }
      await subscribedTimeline.return(undefined);
      await current.reconverge();
      expect(results).toHaveLength(1);
    },
  );

  /** Real sibling commits and distinct sender ratchets, retaining stores for restart. */
  async function losingDeliveries(contents: string[], shared = false) {
    const { adminGroup, inviteeGroup: receiver } = await adminAndInvitee();
    const context = {
      cipherSuite: adminGroup.ciphersuite,
      authService: unsafeTestingAuthenticationService,
    };
    const sharedRumor = shared
      ? chatRumor(await adminAccount.signer.getPublicKey(), contents[0])
      : undefined;
    if (sharedRumor) {
      const app = await createApplicationMessage({
        context,
        state: adminGroup.state,
        message: serializeApplicationRumor(sharedRumor),
      });
      const event = await createGroupEvent({
        message: app.message,
        state: adminGroup.state,
        ciphersuite: adminGroup.ciphersuite,
      });
      adminGroup.state = app.newState;
      for await (const result of receiver.ingest([event])) void result;
    }
    const make = () =>
      createCommit({
        context,
        state: adminGroup.state,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
    const forks = await Promise.all([make(), make()]);
    forks.sort((a, b) =>
      bytesToHex(
        commitDigest(encode(mlsMessageEncoder, a.commit)),
      ).localeCompare(
        bytesToHex(commitDigest(encode(mlsMessageEncoder, b.commit))),
      ),
    );
    const [winning, losing] = forks;
    const wrap = (
      message: Parameters<typeof createGroupEvent>[0]["message"],
      state: typeof adminGroup.state,
    ) =>
      createGroupEvent({ message, state, ciphersuite: adminGroup.ciphersuite });
    const winningEvent = await wrap(winning.commit, adminGroup.state);
    for await (const result of receiver.ingest([
      await wrap(losing.commit, adminGroup.state),
    ]))
      void result;
    let sender = losing.newState;
    const rumors: Rumor[] = [];
    for (const content of contents) {
      const rumor =
        sharedRumor ??
        chatRumor(await adminAccount.signer.getPublicKey(), content);
      rumors.push(rumor);
      const app = await createApplicationMessage({
        context,
        state: sender,
        message: serializeApplicationRumor(rumor),
      });
      const event = await wrap(app.message, sender);
      sender = app.newState;
      const accepted: DispositionedIngestResult[] = [];
      for await (const result of receiver.ingest([event]))
        accepted.push(result);
      expect(
        accepted.some(
          (result) =>
            result.kind === "processed" &&
            result.result.kind === "applicationMessage",
        ),
      ).toBe(true);
    }
    const snapshot = () => deliveredEvidence(receiver.id);
    const restart = async () => {
      inviteeClient.groups.unload(receiver.id);
      const client = new MarmotClient({
        storage: memberStorage,
        rumors: rumorDatabases,
        signer: inviteeAccount.signer,
        network: mockNetwork,
      });
      return client.groups.get(receiver.id);
    };
    const winningDelivery = async (rumor: Rumor) => {
      const app = await createApplicationMessage({
        context,
        state: winning.newState,
        message: serializeApplicationRumor(rumor),
      });
      for await (const result of receiver.ingest([
        await wrap(app.message, winning.newState),
      ]))
        void result;
    };
    return {
      receiver,
      winningEvent,
      winningDelivery,
      rumors,
      snapshot,
      restart,
    };
  }

  it.each(["first invalidation", "before last removal"])(
    "recovers the entire losing delivery batch after interruption at %s",
    async (boundary) => {
      const { receiver, winningEvent, rumors, snapshot, restart } =
        await losingDeliveries(["one", "two", "three"]);
      expect((await snapshot()).entries).toHaveLength(3);
      const remove = historyStore.remove.bind(historyStore);
      let calls = 0;
      let pendingBeforeRemoval = 0;
      const failure = vi
        .spyOn(historyStore, "remove")
        .mockImplementation(async (key) => {
          calls++;
          if (calls > (boundary === "first invalidation" ? 1 : 2))
            throw new Error("interrupted cleanup");
          // Every obligation must already be durable before the first history removal.
          if (calls === 1)
            pendingBeforeRemoval = (await snapshot()).pending.length;
          return remove(key);
        });
      const iterator = receiver.ingest([winningEvent]);
      while (true) {
        const result = await iterator.next();
        if (result.done) throw new Error("expected invalidation");
        if (result.value.kind === "invalidated") break;
      }
      await iterator.return(undefined);
      expect(pendingBeforeRemoval).toBe(3);
      const saved = await snapshot();
      expect(saved.entries).toHaveLength(0);
      expect(saved.pending).toHaveLength(
        boundary === "first invalidation" ? 2 : 1,
      );
      expect(await receiver.history.queryRumors({})).toHaveLength(
        saved.pending.length,
      );
      expect(
        saved.pending.every((entry: { rumorId: string }) =>
          rumors.some((rumor) => rumor.id === entry.rumorId),
        ),
      ).toBe(true);
      failure.mockRestore();
      const restored = await restart();
      await restored.reconverge();
      expect(await restored.history.queryRumors({})).toEqual([]);
      expect((await snapshot()).pending).toEqual([]);
    },
  );

  it.each(["shared", "restored shared", "restored winning"])(
    "preserves canonical rumor visibility while retracting a duplicate transport (%s)",
    async (path) => {
      const {
        receiver,
        winningEvent,
        winningDelivery,
        rumors,
        snapshot,
        restart,
      } = await losingDeliveries(
        ["same inner rumor"],
        path !== "restored winning",
      );
      const removal = path.startsWith("restored")
        ? vi
            .spyOn(receiver.history, "removeMessage")
            .mockRejectedValue(new Error("offline"))
        : undefined;
      const restoration =
        path === "restored shared"
          ? vi
              .spyOn(receiver.history, "saveMessage")
              .mockRejectedValue(new Error("offline"))
          : undefined;
      const removed = vi.fn();
      receiver.history.on("removed", removed);
      const invalidated: DispositionedIngestResult[] = [];
      for await (const result of receiver.ingest([winningEvent]))
        if (result.kind === "invalidated") invalidated.push(result);
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]).toMatchObject({
        rumorId: rumors[0].id,
        transportId: expect.any(String),
      });
      if (path === "restored winning") await winningDelivery(rumors[0]);
      if (path.startsWith("restored"))
        expect((await snapshot()).pending).toHaveLength(1);
      expect(
        (await snapshot()).entries.some(
          (entry: { rumorId: string }) => entry.rumorId === rumors[0].id,
        ),
      ).toBe(true);
      removal?.mockRestore();
      restoration?.mockRestore();
      const restored = await restart();
      await restored.reconverge();
      expect(await restored.history.queryRumors({})).toEqual([rumors[0]]);
      expect((await snapshot()).pending).toEqual([]);
      expect(await receiver.history.queryRumors({})).toEqual([rumors[0]]);
      expect(removed).not.toHaveBeenCalled();
    },
  );

  it.each(["destroy", "manager destroy", "leave"])(
    "%s purges plaintext delivery and pending evidence without touching another group",
    async (path) => {
      const { receiver, winningEvent, snapshot } = await losingDeliveries([
        "private ledger content",
      ]);
      const removal = vi
        .spyOn(receiver.history, "removeMessage")
        .mockRejectedValue(new Error("offline"));
      for await (const result of receiver.ingest([winningEvent])) void result;
      expect((await snapshot()).pending).toHaveLength(1);
      removal.mockRestore();
      const unrelated = `${GROUP_PREFIX}${"ff".repeat(32)}/ingest/delivered`;
      await memberStorage.set(unrelated, new Uint8Array([42]));
      const id = bytesToHex(receiver.id);
      if (path === "leave") await inviteeClient.groups.leave(receiver.id);
      else if (path === "manager destroy")
        await inviteeClient.groups.destroy(receiver.id);
      else await receiver.destroy();
      await receiver.destroy(); // Repeat cleanup is safe.
      await receiver.save(true); // Stale references must not recreate the group.
      expect(
        await memberStorage.list(GROUP_PREFIX + groupKeys.prefix(id)),
      ).toEqual([]);
      expect(await memberStorage.get(unrelated)).toEqual(new Uint8Array([42]));
      expect(await receiver.history.queryRumors({})).toEqual([]);
      const restarted = new MarmotClient({
        storage: memberStorage,
        rumors: rumorDatabases,
        signer: inviteeAccount.signer,
        network: mockNetwork,
      });
      await expect(restarted.groups.get(receiver.id)).rejects.toThrow();
    },
  );

  it.each(["history", "delivery snapshot"])(
    "destroy fences an admitted ingest paused in a %s write",
    async (boundary) => {
      const { receiver, winningEvent, winningDelivery, rumors } =
        await losingDeliveries(["delayed private content"]);
      for await (const result of receiver.ingest([winningEvent])) void result;
      const entered = deferred();
      const release = deferred();
      if (boundary === "history") {
        const add = historyStore.add.bind(historyStore);
        vi.spyOn(historyStore, "add").mockImplementation(async (rumor) => {
          entered.resolve();
          await release.promise;
          return add(rumor);
        });
      } else {
        const delivered =
          GROUP_PREFIX + groupKeys.delivered(bytesToHex(receiver.id));
        const gate = async () => {
          entered.resolve();
          await release.promise;
        };
        const set = memberStorage.set.bind(memberStorage);
        vi.spyOn(memberStorage, "set").mockImplementation(
          async (key, value) => {
            if (key === delivered) await gate();
            return set(key, value);
          },
        );
        const batch = memberStorage.batch.bind(memberStorage);
        vi.spyOn(memberStorage, "batch").mockImplementation(async (ops) => {
          if (ops.some((op) => op.key === delivered)) await gate();
          return batch(ops);
        });
      }
      const work = winningDelivery(rumors[0]);
      await entered.promise;
      const destruction = receiver.destroy();
      release.resolve();
      await work;
      await destruction;
      expect(
        await memberStorage.list(
          GROUP_PREFIX + groupKeys.prefix(bytesToHex(receiver.id)),
        ),
      ).toEqual([]);
      expect(await receiver.history.queryRumors({})).toEqual([]);
      for await (const result of receiver.ingest([])) void result;
      await receiver.reconverge();
      expect(
        await memberStorage.list(
          GROUP_PREFIX + groupKeys.prefix(bytesToHex(receiver.id)),
        ),
      ).toEqual([]);
    },
  );

  /** Admin creates a group and the invitee joins it. */
  async function adminAndInvitee(): Promise<{
    adminGroup: MarmotGroup;
    inviteeGroup: MarmotGroup;
  }> {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    await inviteeClient.keyPackages.create({ relays: RELAYS });
    const keyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
    )!;

    const adminGroup = await adminClient.groups.create("Connect Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
    });
    await adminClient.groups.invite(adminGroup.id, keyPackageEvent);

    const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    const welcomeRumor = await unlockGiftWrap(
      giftWraps[0],
      inviteeAccount.signer,
    );
    const { group: inviteeGroup } = await inviteeClient.joinGroupFromWelcome({
      welcomeRumor,
    });
    return { adminGroup, inviteeGroup };
  }

  it("delivers live messages to a connected group", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Awaiting connect() guarantees the live subscription is installed.
    const handle = await adminClient.groups.connect(adminGroup.id);
    const received = nextMessage(adminGroup);

    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(chatRumor(inviteePubkey, "live!")),
    );

    expect((await received).content).toBe("live!");
    handle.unsubscribe();
  });

  it("backfills already-published messages on connect", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Publish BEFORE the admin connects — must be picked up by the backfill.
    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(chatRumor(inviteePubkey, "backfilled")),
    );

    const received = nextMessage(adminGroup);
    const handle = await adminClient.groups.connect(adminGroup.id);

    expect((await received).content).toBe("backfilled");
    handle.unsubscribe();
  });

  it("stops delivering after the connection is torn down", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    const handle = await adminClient.groups.connect(adminGroup.id);
    handle.unsubscribe();

    let delivered = false;
    adminGroup.once("applicationMessage", () => {
      delivered = true;
    });

    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(
        chatRumor(inviteePubkey, "after-teardown"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(delivered).toBe(false);
  });

  it("connectAll delivers to already-loaded groups and stops on unsubscribe", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    const handle = adminClient.groups.connectAll();
    // Give connectAll's async per-group connect a tick to install subscriptions.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received = nextMessage(adminGroup);
    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(
        chatRumor(inviteePubkey, "via-connectAll"),
      ),
    );
    expect((await received).content).toBe("via-connectAll");

    handle.unsubscribe();
  });
});
