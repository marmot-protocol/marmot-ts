import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  mlsMessageEncoder,
  processMessage,
  type ProposalRemove,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupsManager } from "../../client/groups-manager.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../../core/client-state.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";

const RELAY = "wss://relay.test";

/** A mock network that records every published event and acks it. */
function recordingNetwork(published: NostrEvent[]): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async (_relays, event) => {
      published.push(event);
      return { [RELAY]: { ok: true } as PublishResponse };
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

function marmotGroup(
  state: ClientState,
  pubkey: string,
  impl: CiphersuiteImpl,
  published: NostrEvent[],
  store = new InMemoryKeyValueStore<SerializedClientState>(),
  removedMarkerStore?: GenericKeyValueStore<boolean>,
) {
  return new MarmotGroup(state, {
    store,
    signer: { getPublicKey: async () => pubkey } as EventSigner,
    ciphersuite: impl,
    network: recordingNetwork(published),
    removedMarkerStore,
  });
}

/**
 * Builds a 3-member group (admin "a", "d", "e"), then has the admin commit a
 * `Remove` targeting "e" — an involuntary removal. Returns "e"'s pre-removal
 * `ClientState`, the wrapped removing-commit envelope, and the raw commit
 * message (so a test can independently compute its expected digest).
 */
async function buildRemovalFixture() {
  const adminPubkey = "a".repeat(64);
  const dPubkey = "d".repeat(64);
  const ePubkey = "e".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };

  // 3-member group: admin "a" (leaf 0), "d" (leaf 1), "e" (leaf 2).
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(
    adminKp,
    impl,
    "Group",
    { adminPubkeys: [adminPubkey], relays: [RELAY] },
  );
  const dKp = await generateKeyPackage({
    credential: createCredential(dPubkey),
    ciphersuiteImpl: impl,
  });
  const eKp = await generateKeyPackage({
    credential: createCredential(ePubkey),
    ciphersuiteImpl: impl,
  });
  const { newState: adminEpoch1, welcome } = await createCommit({
    context: ctx,
    state: created,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: dKp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: eKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const welcomeMsg = welcome!.welcome ?? (welcome as never);
  const eEpoch1 = await joinGroup({
    context: ctx,
    welcome: welcomeMsg,
    keyPackage: eKp.publicPackage,
    privateKeys: eKp.privatePackage,
    ratchetTree: undefined,
  });

  // Admin "a" commits a Remove targeting "e" (leaf 2) — an involuntary removal.
  const removeE: ProposalRemove = {
    proposalType: defaultProposalTypes.remove,
    remove: { removed: eEpoch1.privatePath.leafIndex },
  };
  const { commit } = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [removeE],
  });
  const removeCommitEvent = await createGroupEvent({
    message: commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });

  return { impl, ePubkey, eEpoch1, adminEpoch1, removeCommitEvent, commit };
}

async function buildPersistedRemovalForkFixture() {
  const { impl, ePubkey, eEpoch1, adminEpoch1 } = await buildRemovalFixture();
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const memberSnapshot = serializeClientState(eEpoch1);
  const forkA = await createCommit({
    context: ctx,
    state: deserializeClientState(serializeClientState(adminEpoch1)),
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const forkB = await createCommit({
    context: ctx,
    state: deserializeClientState(serializeClientState(adminEpoch1)),
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const digestA = bytesToHex(
    commitDigest(encode(mlsMessageEncoder, forkA.commit)),
  );
  const digestB = bytesToHex(
    commitDigest(encode(mlsMessageEncoder, forkB.commit)),
  );
  const canonical = digestA < digestB ? forkA : forkB;
  const competing = digestA < digestB ? forkB : forkA;
  const canonicalMember = await processMessage({
    context: ctx,
    state: deserializeClientState(memberSnapshot),
    message: canonical.commit,
  });
  const competingMember = await processMessage({
    context: ctx,
    state: deserializeClientState(memberSnapshot),
    message: competing.commit,
  });
  if (
    canonicalMember.kind !== "newState" ||
    competingMember.kind !== "newState"
  )
    throw new Error("expected fork states");

  const remove = await createCommit({
    context: ctx,
    state: canonical.newState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: canonicalMember.newState.privatePath.leafIndex },
      },
    ],
  });
  const removeEvent = await createGroupEvent({
    message: remove.commit,
    state: canonical.newState,
    ciphersuite: impl,
  });
  const removedGroup = marmotGroup(canonicalMember.newState, ePubkey, impl, []);
  for await (const _ of removedGroup.ingest([removeEvent])) void _;
  const removedState = deserializeClientState(
    serializeClientState(removedGroup.state),
  );
  removedGroup.dispose();

  return {
    impl,
    ePubkey,
    eEpoch1: deserializeClientState(memberSnapshot),
    canonicalCommit: canonical.commit,
    removedState,
    competingCommit: competing.commit,
    competingState: competingMember.newState,
  };
}

describe("involuntary removal signal", () => {
  it("keeps removal markers in a group-scoped namespace on a shared backend (WR-19)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();
    const shared = new InMemoryKeyValueStore<SerializedClientState | boolean>();
    const stateStore = shared as GenericKeyValueStore<SerializedClientState>;
    const markerStore = shared as GenericKeyValueStore<boolean>;
    const group = marmotGroup(
      eEpoch1,
      ePubkey,
      impl,
      [],
      stateStore,
      markerStore,
    );
    await group.save(true);

    for await (const _ of group.ingest([removeCommitEvent])) void _;

    const persisted = await stateStore.getItem(group.idStr);
    expect(persisted).not.toBeNull();
    expect(deserializeClientState(persisted!).groupActiveState.kind).toBe(
      "removedFromGroup",
    );
    expect(await markerStore.getItem(`${group.idStr}/removed`)).toBe(true);
  });

  it("forwards persisted multi-tip removal before the public loaded event (CR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const stateStore = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const groupId = bytesToHex(fixture.eEpoch1.groupContext.groupId);
    const rootTag = bytesToHex(fixture.eEpoch1.confirmationTag);
    const tree = new GroupHistoryTree(fixture.eEpoch1);
    tree.recordCommit(rootTag, fixture.canonicalCommit, fixture.removedState);
    tree.recordCommit(rootTag, fixture.competingCommit, fixture.competingState);
    tree.bindStore(rewindStore);
    await tree.flush();
    await stateStore.setItem(
      groupId,
      serializeClientState(fixture.removedState),
    );

    const manager = new GroupsManager({
      store: stateStore,
      rewindStore,
      removedMarkerStore,
      signer: { getPublicKey: async () => fixture.ePubkey } as EventSigner,
      network: recordingNetwork([]),
      cryptoProvider: defaultCryptoProvider,
    });
    const events: string[] = [];
    const removed = vi.fn(() => events.push("removed"));
    manager.on("removed", removed);
    manager.on("loaded", () => events.push("loaded"));

    const loaded = await manager.get(groupId);

    expect(loaded.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(removed).toHaveBeenCalledOnce();
    expect(await removedMarkerStore.getItem(`${groupId}/removed`)).toBe(true);
    expect(events).toEqual(["removed", "loaded"]);
  });

  it("single-flights overlapping removal realization and emits once (WR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    let releaseRead!: (value: boolean | null) => void;
    const read = new Promise<boolean | null>(
      (resolve) => (releaseRead = resolve),
    );
    const getItem = vi.fn(async () => read);
    const setItem = vi.fn(async () => undefined);
    const removedMarkerStore: GenericKeyValueStore<boolean> = {
      getItem,
      setItem,
      removeItem: vi.fn(async () => undefined),
    };
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      undefined,
      removedMarkerStore,
    );
    const removed = vi.fn();
    group.on("removed", removed);

    const first = group.realizeRemovalIfNeeded();
    const second = group.realizeRemovalIfNeeded();
    await Promise.resolve();
    expect(getItem).toHaveBeenCalledOnce();
    releaseRead(null);
    await Promise.all([first, second]);

    expect(setItem).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("retries removal realization after an in-flight marker failure (WR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const getItem = vi
      .fn<GenericKeyValueStore<boolean>["getItem"]>()
      .mockRejectedValueOnce(new Error("marker unavailable"))
      .mockResolvedValueOnce(null);
    const setItem = vi.fn(async () => undefined);
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      undefined,
      { getItem, setItem, removeItem: vi.fn(async () => undefined) },
    );
    const removed = vi.fn();
    group.on("removed", removed);

    await expect(group.realizeRemovalIfNeeded()).rejects.toThrow(
      "marker unavailable",
    );
    await group.realizeRemovalIfNeeded();

    expect(getItem).toHaveBeenCalledTimes(2);
    expect(setItem).toHaveBeenCalledOnce();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("completes durable removal when an application listener throws", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const setItem = vi.spyOn(removedMarkerStore, "setItem");
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      undefined,
      removedMarkerStore,
    );
    Object.defineProperty(group.session, "convergenceStatus", {
      configurable: true,
      get: () => "Resolving",
    });
    const queued = group.submitIntent({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("must be cancelled"),
    });
    const queuedRejection = queued.then(
      () => undefined,
      (error: unknown) => error,
    );
    const throwing = vi.fn(() => {
      throw new Error("application callback failed");
    });
    const observer = vi.fn();
    group.on("removed", throwing);
    group.on("removed", observer);

    await expect(group.realizeRemovalIfNeeded()).resolves.toBeUndefined();
    const queuedError = await queuedRejection;
    expect(queuedError).toBeInstanceOf(Error);
    expect((queuedError as Error).message).toMatch(/removed/i);
    expect(await removedMarkerStore.getItem(`${group.idStr}/removed`)).toBe(
      true,
    );
    expect(throwing).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();

    await expect(group.realizeRemovalIfNeeded()).resolves.toBeUndefined();
    expect(setItem).toHaveBeenCalledOnce();
    expect(throwing).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
  });

  it("preserves removed listener context, order, and once semantics", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      undefined,
      removedMarkerStore,
    );
    const order: string[] = [];
    const onContext = { name: "on-context" };
    const onceContext = { name: "once-context" };

    group.on("removed", function (received) {
      expect(this).toBe(onContext);
      expect(received).toBe(group);
      order.push("on");
      throw new Error("application callback failed");
    }, onContext);
    group.once("removed", function (received) {
      expect(this).toBe(onceContext);
      expect(received).toBe(group);
      order.push("once");
    }, onceContext);
    group.on("removed", function (received) {
      expect(this).toBe(onContext);
      expect(received).toBe(group);
      order.push("observer");
    }, onContext);

    await expect(group.realizeRemovalIfNeeded()).resolves.toBeUndefined();

    expect(await removedMarkerStore.getItem(`${group.idStr}/removed`)).toBe(
      true,
    );
    expect(order).toEqual(["on", "once", "observer"]);

    group.emit("removed", group);
    expect(order).toEqual(["on", "once", "observer", "on", "observer"]);
  });

  it("emits `removed` and keeps the tombstone when an admin's commit removes us", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    // "e" ingests the commit that removes it.
    const ePublished: NostrEvent[] = [];
    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, ePublished, eStore);
    await eGroup.save(true); // persist initial state so we can assert it survives

    let removedEmitted = false;
    eGroup.on("removed", () => (removedEmitted = true));

    const kinds: string[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      kinds.push(r.kind);

    // The ingest surfaced a `removed` result and fired the event.
    expect(kinds).toContain("removed");
    expect(removedEmitted).toBe(true);

    // State is the tombstone, and it was NOT auto-destroyed: the store still
    // holds the (now removed) group state.
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await eStore.getItem(eGroup.idStr)).not.toBeNull();
  });

  /**
   * CR-05 regression: the removal marker records "realization already
   * happened", so it must never be durable ahead of the tombstone it
   * describes. `GroupSession.ingest` only reaches its trailing `save()` once
   * the generator is fully drained, so writing the marker inside the
   * `removed` branch left a window (a throwing `removed` listener, a consumer
   * that `break`s, a process exit, a rejected save) in which the marker said
   * "realized" while the persisted state was still a live-membership state.
   * On the next load `#realizeRemovalIfNeeded` bails on the state check, and
   * on re-ingest it bails on the marker check — so `removed` is never emitted
   * and queued outbound is never rejected.
   */
  it("persists the tombstone before writing the removal marker (CR-05)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const inner = new InMemoryKeyValueStore<boolean>();

    // Snapshots whatever the state store holds at the exact moment the marker
    // is written.
    let persistedAtMarkerWrite: SerializedClientState | null | undefined;
    let idHex = "";
    const removedMarkerStore: GenericKeyValueStore<boolean> = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        persistedAtMarkerWrite = await eStore.getItem(idHex);
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem(key),
    };

    const eGroup = marmotGroup(
      eEpoch1,
      ePubkey,
      impl,
      [],
      eStore,
      removedMarkerStore,
    );
    idHex = eGroup.idStr;
    await eGroup.save(true);

    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;

    expect(await inner.getItem(`${idHex}/removed`)).toBe(true);
    expect(persistedAtMarkerWrite).toBeTruthy();
    expect(
      deserializeClientState(persistedAtMarkerWrite!).groupActiveState.kind,
    ).toBe("removedFromGroup");
  });

  it("attributes a selfRemoved notification to the removing commit's own digest (D-10/D-12)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent, commit } =
      await buildRemovalFixture();

    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, []);
    await eGroup.save(true);

    const removedResults: { notifications?: { kind: string }[] }[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      if (r.kind === "removed") removedResults.push(r as never);

    expect(removedResults).toHaveLength(1);
    const notifications = removedResults[0].notifications ?? [];
    const selfRemoved = notifications.find((n) => n.kind === "selfRemoved") as
      { kind: "selfRemoved"; commitDigest: Uint8Array } | undefined;
    expect(selfRemoved).toBeDefined();

    const expectedDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, commit as MlsMessage)),
    );
    expect(bytesToHex(selfRemoved!.commitDigest)).toBe(expectedDigest);
  });

  it("realizes removal exactly once on a first load with an unset marker, and zero times once the marker is set (D-12)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();

    // Build the removed tombstone WITHOUT a marker store wired, simulating a
    // process that applied the removing commit and then exited before
    // persisting realization state (a crash between commit-apply and
    // notification — D-12's motivating scenario).
    const liveGroup = marmotGroup(eEpoch1, ePubkey, impl, [], eStore);
    await liveGroup.save(true);
    for await (const _ of liveGroup.ingest([removeCommitEvent])) void _;
    await liveGroup.save(true);
    expect(liveGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(
      await removedMarkerStore.getItem(`${liveGroup.idStr}/removed`),
    ).toBeNull();

    // Construction is deliberately side-effect free. The owning registry
    // attaches its forwarding listener first, then invokes this explicit
    // realization boundary so the consumer can observe the event.
    const firstLoad = await MarmotGroup.fromClientState(liveGroup.state, {
      store: eStore,
      removedMarkerStore,
      signer: { getPublicKey: async () => ePubkey } as EventSigner,
      network: recordingNetwork([]),
    });
    const firstRemoved = vi.fn();
    firstLoad.on("removed", firstRemoved);
    await firstLoad.realizeRemovalIfNeeded();

    expect(firstRemoved).toHaveBeenCalledOnce();
    expect(await removedMarkerStore.getItem(`${liveGroup.idStr}/removed`)).toBe(
      true,
    );

    // Second load, same marker store: marker is already set, so explicit
    // realization is a no-op — zero `removed` emissions.
    const secondLoad = await MarmotGroup.fromClientState(liveGroup.state, {
      store: eStore,
      removedMarkerStore,
      signer: { getPublicKey: async () => ePubkey } as EventSigner,
      network: recordingNetwork([]),
    });
    const secondRemoved = vi.fn();
    secondLoad.on("removed", secondRemoved);
    await secondLoad.realizeRemovalIfNeeded();

    expect(secondRemoved).not.toHaveBeenCalled();
  });

  /**
   * WR-16 regression: `#applyRemovalWithdrawal` cleared the marker on ANY
   * `stateInvalidated` carrying a withdrawn `selfRemoved`, with no check that
   * canonical state had actually left the tombstone.
   *
   * A withdrawn `selfRemoved` only means the commit that removed us was
   * superseded — not that we are a member again. A live rewind can supersede
   * removal-commit A and land on branch B which ALSO removes us. Clearing
   * unconditionally left `marker = false` while `groupActiveState.kind ===
   * "removedFromGroup"` and re-emitted nothing, so the NEXT load realized the
   * removal all over again and emitted a duplicate `removed` — violating the
   * exactly-once contract from the other side.
   */
  it("keeps the removal marker when a rewind supersedes one removal but leaves us removed (WR-16)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();

    const eGroup = marmotGroup(
      eEpoch1,
      ePubkey,
      impl,
      [],
      eStore,
      removedMarkerStore,
    );
    const idHex = eGroup.idStr;
    await eGroup.save(true);

    let removedEmissions = 0;
    eGroup.on("removed", () => removedEmissions++);

    // A genuine removal: tombstone persisted, marker written, `removed` once.
    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await removedMarkerStore.getItem(`${idHex}/removed`)).toBe(true);
    expect(removedEmissions).toBe(1);

    // Now a rewind that withdraws that removal's `selfRemoved` notification
    // while canonical state REMAINS the tombstone (it landed on another
    // branch that also removes us). Stub the session stream to yield exactly
    // the shape the engine produces at such a rewind site.
    (
      eGroup.session as unknown as {
        ingest: (events: NostrEvent[]) => AsyncGenerator<unknown>;
      }
    ).ingest = async function* () {
      yield {
        kind: "stateInvalidated",
        commitDigest: new Uint8Array(32),
        forkEpoch: 1,
        withdrawn: [{ kind: "selfRemoved", commitDigest: new Uint8Array(32) }],
        disposition: { kind: "invalidated" },
      };
    };

    for await (const _ of eGroup.ingest([])) void _;

    // Membership was never restored, so the marker must survive...
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await removedMarkerStore.getItem(`${idHex}/removed`)).toBe(true);
    // ...and no duplicate `removed` is emitted for what is one removal.
    expect(removedEmissions).toBe(1);
  });

  /**
   * CR-10 regression: `removedMarkerStore` must be reachable through the
   * public client API, not only by hand-constructing a {@link MarmotGroup}.
   * `GroupsManagerOptions` now carries it and forwards it to both the
   * `GroupRegistry` (load path) and the `GroupFactory` (create path), so the
   * D-12 marker is durable for real consumers.
   *
   * Without the plumbing, `MarmotGroup` falls back to
   * `#removalRealizedInMemory`, which is reset by process exit — so the
   * marker store stays empty and a "restart" (a second `GroupsManager` over
   * the same backing stores) realizes the removal a second time, emitting a
   * duplicate `removed`. Both assertions below fail on the unplumbed code.
   */
  it("plumbs removedMarkerStore through GroupsManager so realization survives a restart (CR-10)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    // Backing stores shared across the simulated restart.
    const stateStore = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const signer = { getPublicKey: async () => ePubkey } as EventSigner;

    const managerOptions = {
      store: stateStore,
      removedMarkerStore,
      signer,
      network: recordingNetwork([]),
      cryptoProvider: defaultCryptoProvider,
    };

    // --- process 1: adopt "e"'s live state, then ingest the removing commit.
    const manager1 = new GroupsManager(managerOptions);
    const group = await manager1.import(eEpoch1);
    const idHex = group.idStr;

    // Sanity: the group is live and unmarked before the removing commit.
    expect(await removedMarkerStore.getItem(`${idHex}/removed`)).toBeNull();

    const kinds: string[] = [];
    for await (const r of manager1.ingest(group.id, [removeCommitEvent]))
      kinds.push(r.kind);
    expect(kinds).toContain("removed");
    expect(group.state.groupActiveState.kind).toBe("removedFromGroup");

    // The marker reached the durable store through the manager — this is the
    // plumbing CR-10 was about. Unplumbed, this is still `null`.
    expect(await removedMarkerStore.getItem(`${idHex}/removed`)).toBe(true);

    // --- process 2: a fresh manager over the same stores (a "restart").
    // `MarmotGroup.fromClientState` realizes internally before returning, so
    // spy on the shared prototype to observe emissions the loader makes.
    const emitSpy = vi.spyOn(
      EventEmitter.prototype as unknown as { emit: () => boolean },
      "emit",
    );
    try {
      const manager2 = new GroupsManager({
        ...managerOptions,
        network: recordingNetwork([]),
      });
      const reloaded = await manager2.get(idHex);

      // Still the tombstone...
      expect(reloaded.state.groupActiveState.kind).toBe("removedFromGroup");
      // ...but realization already happened in process 1 and the marker is
      // durable, so the load must NOT re-emit `removed`. With the in-memory
      // fallback this fires again — a duplicate removal for the app.
      const removedEmissions = emitSpy.mock.calls.filter(
        (call) => call[0] === "removed",
      ).length;
      expect(removedEmissions).toBe(0);
    } finally {
      emitSpy.mockRestore();
    }
  });
});
