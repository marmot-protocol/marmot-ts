import { bytesToHex } from "@noble/hashes/utils.js";
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
  mlsMessageEncoder,
  processMessage,
  type ProposalRemove,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupsManager } from "../../client/groups-manager.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { testAccount } from "../helpers/test-accounts.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import {
  groupMeta,
  memoryDatabase,
  memoryGroupDatabase,
  memoryTreeStore,
  openGroup,
} from "../helpers/database.js";
import type {
  GroupMetaKey,
  MarmotDatabase,
  MarmotGroupDatabase,
} from "../../client/storage/database/types.js";
import type { DispositionedIngestResult } from "../../client/session/group-session.js";

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
      return { [RELAY]: { from: RELAY, ok: true } };
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
  storage: MarmotGroupDatabase = memoryGroupDatabase(),
) {
  return new MarmotGroup(state, {
    database: storage,
    signer: {
      getPublicKey: async () => pubkey,
      signEvent: async () => {
        throw new Error("Nostr identity signing is not used in this fixture");
      },
    },
    ciphersuite: impl,
    network: recordingNetwork(published),
  });
}

const MARKER = Uint8Array.of(1);
const isMarkerKey = (key: string) => key === "removed";

/** Records every meta key a group database writes (and lets a test intercept). */
function spyMetaWrites(
  db: MarmotGroupDatabase,
  before?: (key: GroupMetaKey) => Promise<void>,
): GroupMetaKey[] {
  const writes: GroupMetaKey[] = [];
  const transaction = db.transaction.bind(db);
  db.transaction = (fn) =>
    transaction((tx) =>
      fn({
        ...tx,
        meta: {
          ...tx.meta,
          set: async (key, value) => {
            writes.push(key);
            await before?.(key);
            return tx.meta.set(key, value);
          },
        },
      }),
    );
  return writes;
}

/** Registers a group in a client database and seeds its canonical state. */
async function seedGroup(
  database: MarmotDatabase,
  groupId: string,
  state: ClientState,
): Promise<MarmotGroupDatabase> {
  await database.account.transaction((tx) =>
    tx.groups.put({ id: groupId, status: "active", value: new Uint8Array() }),
  );
  const db = await openGroup(database, groupId);
  await db.transaction((tx) =>
    tx.meta.set("state", serializeClientState(state)),
  );
  return db;
}

/**
 * Builds a 3-member group (admin "a", "d", "e"), then has the admin commit a
 * `Remove` targeting "e" — an involuntary removal. Returns "e"'s pre-removal
 * `ClientState`, the wrapped removing-commit envelope, and the raw commit
 * message (so a test can independently compute its expected digest).
 */
async function buildRemovalFixture() {
  const adminAccount = testAccount(6);
  const dAccount = testAccount(9);
  const eAccount = testAccount(11);
  const adminPubkey = adminAccount.pubkey;
  const dPubkey = dAccount.pubkey;
  const ePubkey = eAccount.pubkey;
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
    signer: adminAccount.signer,
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
    signer: dAccount.signer,
    ciphersuiteImpl: impl,
  });
  const eKp = await generateKeyPackage({
    credential: createCredential(ePubkey),
    signer: eAccount.signer,
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
  if (!welcome) throw new Error("Member Add commit did not produce a Welcome");
  const welcomeMsg = welcome.welcome;
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
    // State and marker deliberately share one backend: namespace isolation is
    // the behavior under test.
    const storage = memoryGroupDatabase();
    const group = marmotGroup(eEpoch1, ePubkey, impl, [], storage);
    await group.save(true);

    for await (const _ of group.ingest([removeCommitEvent])) void _;

    const persisted = await storage.meta.get("state");
    expect(persisted).toBeDefined();
    expect(deserializeClientState(persisted!).groupActiveState.kind).toBe(
      "removedFromGroup",
    );
    expect(await storage.meta.get("removed")).toEqual(MARKER);
  });

  it("forwards persisted multi-tip removal before the public loaded event (CR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const storage = memoryDatabase();
    const groupId = bytesToHex(fixture.eEpoch1.groupContext.groupId);
    const rootTag = bytesToHex(fixture.eEpoch1.confirmationTag);
    const tree = new GroupHistoryTree(fixture.eEpoch1);
    tree.recordCommit(rootTag, fixture.canonicalCommit, fixture.removedState);
    tree.recordCommit(rootTag, fixture.competingCommit, fixture.competingState);
    const db = await seedGroup(storage, groupId, fixture.removedState);
    tree.bindStore(memoryTreeStore(db));
    await tree.flush();

    const manager = new GroupsManager({
      database: storage,
      signer: testAccount(11).signer,
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
    expect(await db.meta.get("removed")).toEqual(MARKER);
    expect(events).toEqual(["removed", "loaded"]);
  });

  it("single-flights overlapping removal realization and emits once (WR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    let releaseRead!: (value: Uint8Array | undefined) => void;
    const read = new Promise<Uint8Array | undefined>(
      (resolve) => (releaseRead = resolve),
    );
    const storage = memoryGroupDatabase();
    const get = storage.meta.get.bind(storage.meta);
    const markerReads = vi.fn(async () => read);
    storage.meta.get = (key) => (isMarkerKey(key) ? markerReads() : get(key));
    const writes = spyMetaWrites(storage);
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      storage,
    );
    const removed = vi.fn();
    group.on("removed", removed);

    const first = group.realizeRemovalIfNeeded();
    const second = group.realizeRemovalIfNeeded();
    await Promise.resolve();
    expect(markerReads).toHaveBeenCalledOnce();
    releaseRead(undefined);
    await Promise.all([first, second]);

    expect(writes.filter(isMarkerKey)).toHaveLength(1);
    expect(removed).toHaveBeenCalledOnce();
  });

  it("retries removal realization after an in-flight marker failure (WR-01)", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const storage = memoryGroupDatabase();
    const get = storage.meta.get.bind(storage.meta);
    const markerReads = vi
      .fn<() => Promise<Uint8Array | undefined>>()
      .mockRejectedValueOnce(new Error("marker unavailable"))
      .mockResolvedValueOnce(undefined);
    storage.meta.get = (key) => (isMarkerKey(key) ? markerReads() : get(key));
    const writes = spyMetaWrites(storage);
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      storage,
    );
    const removed = vi.fn();
    group.on("removed", removed);

    await expect(group.realizeRemovalIfNeeded()).rejects.toThrow(
      "marker unavailable",
    );
    await group.realizeRemovalIfNeeded();

    expect(markerReads).toHaveBeenCalledTimes(2);
    expect(writes.filter(isMarkerKey)).toHaveLength(1);
    expect(removed).toHaveBeenCalledOnce();
  });

  it("completes durable removal when an application listener throws", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const storage = memoryGroupDatabase();
    const writes = spyMetaWrites(storage);
    const markerWrites = () => writes.filter(isMarkerKey);
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      storage,
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
    expect(await storage.meta.get("removed")).toEqual(MARKER);
    expect(throwing).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();

    await expect(group.realizeRemovalIfNeeded()).resolves.toBeUndefined();
    expect(markerWrites()).toHaveLength(1);
    expect(throwing).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledOnce();
  });

  it("preserves removed listener context, order, and once semantics", async () => {
    const fixture = await buildPersistedRemovalForkFixture();
    const storage = memoryGroupDatabase();
    const group = marmotGroup(
      fixture.removedState,
      fixture.ePubkey,
      fixture.impl,
      [],
      storage,
    );
    const order: string[] = [];
    const onContext = { name: "on-context" };
    const onceContext = { name: "once-context" };

    const throwing = function (this: typeof onContext, received: MarmotGroup) {
      expect(this).toBe(onContext);
      expect(received).toBe(group);
      order.push("on");
      throw new Error("application callback failed");
    };
    group.on("removed", throwing, onContext);
    group.once(
      "removed",
      function (this: typeof onceContext, received) {
        expect(this).toBe(onceContext);
        expect(received).toBe(group);
        order.push("once");
      },
      onceContext,
    );
    group.on(
      "removed",
      function (this: typeof onContext, received) {
        expect(this).toBe(onContext);
        expect(received).toBe(group);
        order.push("observer");
      },
      onContext,
    );

    await expect(group.realizeRemovalIfNeeded()).resolves.toBeUndefined();

    expect(await storage.meta.get("removed")).toEqual(MARKER);
    expect(order).toEqual(["on", "once", "observer"]);

    group.off("removed", throwing, onContext);
    group.emit("removed", group);
    expect(order).toEqual(["on", "once", "observer", "observer"]);
  });

  it("emits `removed` and keeps the tombstone when an admin's commit removes us", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    // "e" ingests the commit that removes it.
    const ePublished: NostrEvent[] = [];
    const storage = memoryGroupDatabase();
    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, ePublished, storage);
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
    expect(await storage.meta.get("state")).toBeDefined();
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

    const storage = memoryGroupDatabase();

    // Snapshots whatever the storage holds as canonical state at the exact
    // moment the marker is written.
    let persistedAtMarkerWrite: Uint8Array | undefined;
    spyMetaWrites(storage, async (key) => {
      if (isMarkerKey(key))
        persistedAtMarkerWrite = await storage.meta.get("state");
    });

    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, [], storage);
    await eGroup.save(true);

    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;

    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;

    expect(await storage.meta.get("removed")).toEqual(MARKER);
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

    const removedResults: Extract<
      DispositionedIngestResult,
      { kind: "removed" }
    >[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      if (r.kind === "removed") removedResults.push(r);

    expect(removedResults).toHaveLength(1);
    const notifications = removedResults[0].notifications ?? [];
    const selfRemoved = notifications.find((n) => n.kind === "selfRemoved");
    expect(selfRemoved).toBeDefined();
    if (!selfRemoved)
      throw new Error("Removal omitted its selfRemoved notification");

    const expectedDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, commit)),
    );
    expect(bytesToHex(selfRemoved.commitDigest)).toBe(expectedDigest);
  });

  it("realizes removal exactly once on a first load with an unset marker, and zero times once the marker is set (D-12)", async () => {
    const { impl, ePubkey, eEpoch1, removeCommitEvent } =
      await buildRemovalFixture();

    const storage = memoryGroupDatabase();

    // A live group applies the removing commit; realization durably marks it.
    const liveGroup = marmotGroup(eEpoch1, ePubkey, impl, [], storage);
    await liveGroup.save(true);
    for await (const _ of liveGroup.ingest([removeCommitEvent])) void _;
    await liveGroup.save(true);
    expect(liveGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    const markerKey = "removed";
    expect(await storage.meta.get(markerKey)).toEqual(MARKER);
    liveGroup.dispose();

    // Simulate a process that persisted the tombstone and then exited before
    // the marker write (a crash between commit-apply and notification —
    // D-12's motivating scenario; the tombstone always precedes the marker).
    await storage.transaction((tx) => tx.meta.delete(markerKey));

    // Construction is deliberately side-effect free. The owning registry
    // attaches its forwarding listener first, then invokes this explicit
    // realization boundary so the consumer can observe the event.
    const firstLoad = await MarmotGroup.fromClientState(liveGroup.state, {
      database: storage,
      signer: testAccount(11).signer,
      network: recordingNetwork([]),
    });
    const firstRemoved = vi.fn();
    firstLoad.on("removed", firstRemoved);
    await firstLoad.realizeRemovalIfNeeded();

    expect(firstRemoved).toHaveBeenCalledOnce();
    expect(await storage.meta.get(markerKey)).toEqual(MARKER);

    // Second load, same marker store: marker is already set, so explicit
    // realization is a no-op — zero `removed` emissions.
    const secondLoad = await MarmotGroup.fromClientState(liveGroup.state, {
      database: storage,
      signer: testAccount(11).signer,
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

    const storage = memoryGroupDatabase();

    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, [], storage);
    await eGroup.save(true);

    let removedEmissions = 0;
    eGroup.on("removed", () => removedEmissions++);

    // A genuine removal: tombstone persisted, marker written, `removed` once.
    for await (const _ of eGroup.ingest([removeCommitEvent])) void _;
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await storage.meta.get("removed")).toEqual(MARKER);
    expect(removedEmissions).toBe(1);

    // Now a rewind that withdraws that removal's `selfRemoved` notification
    // while canonical state REMAINS the tombstone (it landed on another
    // branch that also removes us). Stub the session stream to yield exactly
    // the shape the engine produces at such a rewind site.
    eGroup.session.ingest = async function* () {
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
    expect(await storage.meta.get("removed")).toEqual(MARKER);
    // ...and no duplicate `removed` is emitted for what is one removal.
    expect(removedEmissions).toBe(1);
  });

  /**
   * CR-10 regression: the removal marker must be durable through the public
   * client API, not only by hand-constructing a {@link MarmotGroup}. The
   * `GroupsManager` storage reaches both the `GroupRegistry` (load path) and
   * the `GroupFactory` (create path), so the D-12 marker survives a restart
   * and a second `GroupsManager` over the same storage does not realize the
   * removal a second time.
   */
  it("persists the removal marker through GroupsManager so realization survives a restart (CR-10)", async () => {
    const { eEpoch1, removeCommitEvent } = await buildRemovalFixture();

    // Backing stores shared across the simulated restart.
    const storage = memoryDatabase();
    const signer = testAccount(11).signer;

    const managerOptions = {
      database: storage,
      signer,
      network: recordingNetwork([]),
      cryptoProvider: defaultCryptoProvider,
    };

    // --- process 1: adopt "e"'s live state, then ingest the removing commit.
    const manager1 = new GroupsManager(managerOptions);
    const group = await manager1.import(eEpoch1);
    const idHex = group.idStr;

    // Sanity: the group is live and unmarked before the removing commit.
    const meta = await groupMeta(storage, idHex);
    expect(await meta.get("removed")).toBeUndefined();

    const kinds: string[] = [];
    for await (const r of manager1.ingest(group.id, [removeCommitEvent]))
      kinds.push(r.kind);
    expect(kinds).toContain("removed");
    expect(group.state.groupActiveState.kind).toBe("removedFromGroup");

    // The marker reached the durable store through the manager — this is the
    // durability CR-10 was about.
    expect(await meta.get("removed")).toEqual(MARKER);

    // --- process 2: a fresh manager over the same stores (a "restart").
    // `MarmotGroup.fromClientState` realizes internally before returning, so
    // spy on the shared prototype to observe emissions the loader makes.
    const emitSpy = vi.spyOn(EventEmitter.prototype, "emit");
    try {
      const manager2 = new GroupsManager({
        ...managerOptions,
        network: recordingNetwork([]),
      });
      const reloaded = await manager2.get(idHex);

      // Still the tombstone...
      expect(reloaded.state.groupActiveState.kind).toBe("removedFromGroup");
      // ...but realization already happened in process 1 and the marker is
      // durable, so the load must NOT re-emit `removed`.
      const removedEmissions = emitSpy.mock.calls.filter(
        (call) => call[0] === "removed",
      ).length;
      expect(removedEmissions).toBe(0);
    } finally {
      emitSpy.mockRestore();
    }
  });
});
