/**
 * Conformance tests for {@link MarmotDatabase} adapters. Call from a vitest
 * file with a factory that returns a fresh, empty database each time.
 *
 * ```ts
 * import { runDatabaseConformance } from "./conformance.js";
 * runDatabaseConformance("my adapter", async () => myDatabase());
 * ```
 *
 * @module @category Storage
 */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { describe, expect, it } from "vitest";
import type {
  DeliveryRow,
  EffectRow,
  InviteRow,
  KeyPackageRow,
  MarmotDatabase,
  MessageRow,
  PublicationRecord,
  TreeNodeRow,
} from "../types.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function event(id: string, kind = 445, extra: Partial<NostrEvent> = {}) {
  return {
    id,
    kind,
    pubkey: ALICE,
    created_at: 100,
    content: "ciphertext",
    tags: [["h", "group"]],
    sig: "f".repeat(128),
    ...extra,
  } satisfies NostrEvent;
}

function message(
  id: string,
  createdAt: number,
  extra: Partial<MessageRow> = {},
): MessageRow {
  return {
    id,
    kind: 9,
    pubkey: ALICE,
    createdAt,
    content: `content ${id}`,
    tags: [],
    ...extra,
  };
}

function delivery(
  id: string,
  rumorId: string,
  extra: Partial<DeliveryRow> = {},
): DeliveryRow {
  return {
    id,
    rumorId,
    stateTag: "t1",
    epoch: 1,
    transportId: `tx-${id}`,
    createdAt: 1,
    ...extra,
  };
}

function treeNode(tag: string, extra: Partial<TreeNodeRow> = {}): TreeNodeRow {
  return { tag, epoch: 1, snapshot: bytes(1, 2, 3), ...extra };
}

function effect(digest: string, extra: Partial<EffectRow> = {}): EffectRow {
  return {
    digest,
    state: "pending",
    direction: "withdrawal",
    notifications: [],
    ...extra,
  };
}

function invite(id: string, extra: Partial<InviteRow> = {}): InviteRow {
  return { id, state: "received", receivedAt: 1, ...extra };
}

function keyPackage(
  ref: string,
  extra: Partial<KeyPackageRow> = {},
): KeyPackageRow {
  return {
    ref,
    publicPackage: bytes(1),
    notBefore: 1,
    used: false,
    published: [],
    consumptionReceipts: [],
    ...extra,
  };
}

/** Asserts a value is a real `Uint8Array` equal to `expected`. */
function expectBytes(value: unknown, expected: Uint8Array): void {
  expect(value).toBeInstanceOf(Uint8Array);
  expect(Array.from(value as Uint8Array)).toEqual(Array.from(expected));
}

class Rollback extends Error {}

/**
 * Registers vitest suites checking that an adapter meets the
 * {@link MarmotDatabase} contract.
 *
 * @param name - Suite name.
 * @param create - Returns a fresh, empty database.
 * @param reopen - Optional: reopens the same storage after `close()`, to check
 *   durability. Omit for non-durable adapters.
 */
export function runDatabaseConformance(
  name: string,
  create: () => Promise<MarmotDatabase>,
  reopen?: (database: MarmotDatabase) => Promise<MarmotDatabase>,
): void {
  describe(`${name}: group record`, () => {
    it("starts empty and applies partial updates (null deletes, undefined keeps)", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      expect(await db.group()).toEqual({});
      await db.transaction((tx) =>
        tx.updateGroup({ state: bytes(1, 2), removed: false }),
      );
      await db.transaction((tx) =>
        tx.updateGroup({ registryState: bytes(3), removed: true }),
      );
      let record = await db.group();
      expectBytes(record.state, bytes(1, 2));
      expectBytes(record.registryState, bytes(3));
      expect(record.removed).toBe(true);

      await db.transaction((tx) =>
        tx.updateGroup({ registryState: null, state: undefined }),
      );
      record = await db.group();
      expect(record.registryState).toBeUndefined();
      expectBytes(record.state, bytes(1, 2));
      expect(record.removed).toBe(true);
    });

    it("round-trips nested records with bytes and events", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const publication: PublicationRecord = {
        kind: "groupEvolution",
        envelope: event("e1"),
        pending: {
          kind: "commit",
          parentState: bytes(1),
          newState: bytes(2),
          commitMessage: bytes(3),
          ownCommitStamp: {
            committer: ALICE,
            priority: "ordinary",
            consumedProposalRefs: ["aa", "bb"],
          },
        },
        welcome: bytes(4),
        welcomeRecipients: [
          {
            pubkey: BOB,
            keyPackageEventId: "kp",
            keyPackageEvent: event("kp", 30443),
          },
        ],
        relays: ["wss://relay.example"],
        acknowledged: false,
        response: { "wss://relay.example": { from: "r", ok: true } },
      };
      await db.transaction((tx) =>
        tx.updateGroup({
          publication,
          checkpoint: {
            rootTag: "t0",
            members: ["t0", "t1"],
            garbage: [],
            receivers: { t0: null, t1: [1, 2] },
            projections: { t1: bytes(7, 8) },
          },
          disbandConvergence: {
            generation: 1,
            baseEpoch: 2,
            openedAtWallMs: 3,
            deadlineWallMs: 4,
            lastRelevantInputWallMs: 5,
            candidates: [
              {
                commitDigest: "d",
                actorPubkey: ALICE,
                sourceEpoch: 2,
                parentTag: "p",
                childTag: "c",
                commitMessage: bytes(5),
                resultingState: bytes(6),
              },
            ],
          },
        }),
      );
      const record = await db.group();
      expect(record.publication).toEqual(publication);
      expectBytes(record.publication!.pending.newState, bytes(2));
      expectBytes(record.publication!.welcome, bytes(4));
      expectBytes(record.checkpoint!.projections.t1, bytes(7, 8));
      expect(record.checkpoint!.receivers).toEqual({ t0: null, t1: [1, 2] });
      expectBytes(
        record.disbandConvergence!.candidates[0]!.resultingState,
        bytes(6),
      );
    });

    it("rolls back the group record and every table when the callback throws", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction((tx) => tx.updateGroup({ state: bytes(1) }));
      await expect(
        db.transaction(async (tx) => {
          await tx.updateGroup({ state: bytes(9), removed: true });
          await tx.treeNodes.put(treeNode("t1"));
          await tx.wrappers.put({ id: "w1", epoch: 1, outcome: "accepted" });
          await tx.effects.put(effect("d1"));
          await tx.backfill.put({ relay: "wss://r", cursor: 5 });
          await tx.messages.put(message("m1", 1));
          await tx.deliveries.put(delivery("d1", "m1"));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      const record = await db.group();
      expectBytes(record.state, bytes(1));
      expect(record.removed).toBeUndefined();
      expect(await db.treeNodes.get("t1")).toBeUndefined();
      expect(await db.wrappers.get("w1")).toBeUndefined();
      expect(await db.effects.get("d1")).toBeUndefined();
      expect(await db.backfill.get("wss://r")).toBeUndefined();
      expect(await db.messages.get("m1")).toBeUndefined();
      expect(await db.deliveries.countByRumor("m1")).toBe(0);
    });

    it("sees its own writes inside a transaction", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.updateGroup({ state: bytes(4) });
        expectBytes((await tx.group()).state, bytes(4));
        await tx.updateGroup({ removed: true });
        const record = await tx.group();
        expectBytes(record.state, bytes(4));
        expect(record.removed).toBe(true);
        await tx.deliveries.put(delivery("d1", "m1"));
        await tx.deliveries.put(delivery("d2", "m1"));
        expect(await tx.deliveries.countByRumor("m1")).toBe(2);
        await tx.deliveries.delete("d1");
        expect(await tx.deliveries.countByRumor("m1")).toBe(1);
        await tx.messages.put(message("m1", 1, { tags: [["e", "x"]] }));
        expect(
          (await tx.messages.query({ tags: { e: ["x"] } })).map((r) => r.id),
        ).toEqual(["m1"]);
      });
    });

    it("returns copies of stored bytes", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const value = bytes(1, 2);
      await db.transaction((tx) => tx.updateGroup({ state: value }));
      value[0] = 9;
      const read = (await db.group()).state!;
      expectBytes(read, bytes(1, 2));
      read[0] = 9;
      expectBytes((await db.group()).state, bytes(1, 2));
    });

    it("isolates groups and drops one without touching others", async () => {
      const { groups } = await create();
      const a = await groups.open("aa");
      const b = await groups.open("bb");
      await a.transaction(async (tx) => {
        await tx.updateGroup({ state: bytes(1) });
        await tx.messages.put(message("m1", 1));
      });
      await b.transaction((tx) => tx.updateGroup({ state: bytes(2) }));
      expectBytes((await a.group()).state, bytes(1));
      expect(await b.messages.get("m1")).toBeUndefined();
      await a.close();
      await groups.drop("aa");
      await groups.drop("missing");
      const reopened = await groups.open("aa");
      expect(await reopened.group()).toEqual({});
      expect(await reopened.messages.get("m1")).toBeUndefined();
      expectBytes((await b.group()).state, bytes(2));
    });

    if (reopen)
      it("keeps committed data across close and reopen", async () => {
        const database = await create();
        const db = await database.groups.open("aa");
        await db.transaction(async (tx) => {
          await tx.updateGroup({ state: bytes(1) });
          await tx.messages.put(message("m1", 1, { tags: [["e", "x"]] }));
          await tx.deliveries.put(
            delivery("d1", "m1", {
              evidence: {
                envelope: event("e1"),
                message: bytes(1),
                payload: bytes(2),
              },
            }),
          );
        });
        await db.close();
        await database.account.close();
        const restored = await reopen(database);
        const again = await restored.groups.open("aa");
        expectBytes((await again.group()).state, bytes(1));
        expect(
          (await again.messages.query({ tags: { e: ["x"] } })).map((r) => r.id),
        ).toEqual(["m1"]);
        expect(
          (await again.deliveries.withEvidence()).map((r) => r.id),
        ).toEqual(["d1"]);
      });
  });

  describe(`${name}: group tables`, () => {
    it("stores tree nodes with snapshot and commit bytes", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const full = treeNode("t1", {
        epoch: 4,
        parentTag: "t0",
        commitDigest: "dd",
        senderLeafIndex: 2,
        snapshot: bytes(9, 8, 7),
        commit: bytes(6, 5),
        ownCommitStamp: {
          committer: ALICE,
          priority: "privileged",
          consumedProposalRefs: [],
        },
      });
      await db.transaction(async (tx) => {
        await tx.treeNodes.put(treeNode("t0", { epoch: 3 }));
        await tx.treeNodes.put(full);
      });
      const read = await db.treeNodes.get("t1");
      expect(read).toEqual(full);
      expectBytes(read!.snapshot, bytes(9, 8, 7));
      expectBytes(read!.commit, bytes(6, 5));
      const root = await db.treeNodes.get("t0");
      expect(root).toEqual(treeNode("t0", { epoch: 3 }));
      expect(root!.parentTag).toBeUndefined();
      expect(root!.commit).toBeUndefined();
      await db.transaction((tx) => tx.treeNodes.delete("t0"));
      expect(await db.treeNodes.get("t0")).toBeUndefined();
      expect(await db.treeNodes.get("missing")).toBeUndefined();
    });

    it("stores wrapper outcomes and deletes below an epoch floor", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        for (const [id, epoch] of [
          ["w1", 1],
          ["w2", 2],
          ["w3", 3],
          ["w4", 1],
          ["w5", 5],
        ] as const)
          await tx.wrappers.put({ id, epoch, outcome: "accepted" });
        await tx.wrappers.put({ id: "w6", epoch: 0, outcome: "stale" });
      });
      expect(await db.wrappers.get("w6")).toEqual({
        id: "w6",
        epoch: 0,
        outcome: "stale",
      });
      await db.transaction((tx) => tx.wrappers.deleteBelow(3, ["w4"]));
      expect(await db.wrappers.get("w1")).toBeUndefined();
      expect(await db.wrappers.get("w2")).toBeUndefined();
      expect(await db.wrappers.get("w6")).toBeUndefined();
      expect(await db.wrappers.get("w3")).toBeDefined();
      expect(await db.wrappers.get("w4")).toBeDefined();
      expect(await db.wrappers.get("w5")).toBeDefined();
      await db.transaction(async (tx) => {
        await tx.wrappers.put({ id: "w3", epoch: 3, outcome: "invalidated" });
        await tx.wrappers.deleteBelow(10);
      });
      for (const id of ["w3", "w4", "w5"])
        expect(await db.wrappers.get(id)).toBeUndefined();
    });

    it("indexes effects by state", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const observed = effect("e2", {
        state: "observed",
        direction: "adoption",
        forkEpoch: 3,
        producingEpoch: 4,
        notifications: [
          { kind: "epochAdvanced", commitDigest: "e2", from: 3, to: 4 },
          { kind: "memberRemoved", commitDigest: "e2", pubkey: BOB },
        ],
      });
      await db.transaction(async (tx) => {
        await tx.effects.put(effect("e3"));
        await tx.effects.put(effect("e1"));
        await tx.effects.put(observed);
      });
      expect(
        (await db.effects.byState("pending")).map((r) => r.digest),
      ).toEqual(["e1", "e3"]);
      expect(await db.effects.byState("observed")).toEqual([observed]);
      expect(await db.effects.get("e2")).toEqual(observed);
      await db.transaction(async (tx) => {
        await tx.effects.put(effect("e1", { state: "observed" }));
        await tx.effects.delete("e3");
      });
      expect(await db.effects.byState("pending")).toEqual([]);
      expect(
        (await db.effects.byState("observed")).map((r) => r.digest),
      ).toEqual(["e1", "e2"]);
    });

    it("stores, replaces and deletes backfill rows", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.backfill.put({ relay: "wss://a", cursor: 10 });
        await tx.backfill.put({
          relay: "wss://b",
          progress: { from: 1, to: 2 },
        });
      });
      expect(await db.backfill.get("wss://a")).toEqual({
        relay: "wss://a",
        cursor: 10,
      });
      expect(await db.backfill.get("wss://b")).toEqual({
        relay: "wss://b",
        progress: { from: 1, to: 2 },
      });
      await db.transaction(async (tx) => {
        await tx.backfill.put({ relay: "wss://a", cursor: 20 });
        await tx.backfill.delete("wss://b");
      });
      expect((await db.backfill.get("wss://a"))?.cursor).toBe(20);
      expect(await db.backfill.get("wss://b")).toBeUndefined();
    });

    it("round-trips message rows", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const row = message("m1", 5, {
        kind: 1,
        pubkey: BOB,
        content: "hello",
        tags: [["e", "x", "wss://relay"], ["subject", "hi"], ["t"]],
      });
      await db.transaction((tx) => tx.messages.put(row));
      expect(await db.messages.get("m1")).toEqual(row);
      expect(await db.messages.query({ ids: ["m1"] })).toEqual([row]);
      await db.transaction((tx) => tx.messages.delete("m1"));
      expect(await db.messages.get("m1")).toBeUndefined();
      expect(await db.messages.query({})).toEqual([]);
    });

    it("queries messages newest first with id tiebreak and limit", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.messages.put(message("b", 20));
        await tx.messages.put(message("a", 20));
        await tx.messages.put(message("c", 10));
        await tx.messages.put(message("d", 30));
      });
      const ids = async (query = {}) =>
        (await db.messages.query(query)).map((row) => row.id);
      expect(await ids()).toEqual(["d", "a", "b", "c"]);
      expect(await ids({ limit: 2 })).toEqual(["d", "a"]);
      expect(await ids({ limit: 0 })).toEqual([]);
      expect(await ids({ since: 20 })).toEqual(["d", "a", "b"]);
      expect(await ids({ until: 20 })).toEqual(["a", "b", "c"]);
      expect(await ids({ since: 15, until: 25, limit: 1 })).toEqual(["a"]);
      expect(await ids({ ids: ["c", "d", "missing"] })).toEqual(["d", "c"]);
      expect(await ids({ ids: [] })).toEqual([]);
    });

    it("filters messages by kind, author and tags (AND of ORs)", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.messages.put(
          message("m1", 1, {
            kind: 9,
            pubkey: ALICE,
            tags: [
              ["e", "x"],
              ["p", "y"],
            ],
          }),
        );
        await tx.messages.put(
          message("m2", 2, { kind: 7, pubkey: BOB, tags: [["e", "x", "r"]] }),
        );
        await tx.messages.put(
          message("m3", 3, {
            kind: 9,
            pubkey: BOB,
            tags: [
              ["e", "z"],
              ["p", "y"],
              ["e", "z"],
            ],
          }),
        );
        await tx.messages.put(
          message("m4", 4, { tags: [["subject", "x"], ["e"]] }),
        );
      });
      const ids = async (query = {}) =>
        (await db.messages.query(query)).map((row) => row.id);
      expect(await ids({ kinds: [9] })).toEqual(["m4", "m3", "m1"]);
      expect(await ids({ kinds: [7, 9], limit: 2 })).toEqual(["m4", "m3"]);
      expect(await ids({ authors: [BOB] })).toEqual(["m3", "m2"]);
      expect(await ids({ tags: { e: ["x"] } })).toEqual(["m2", "m1"]);
      expect(await ids({ tags: { e: ["x", "z"] } })).toEqual([
        "m3",
        "m2",
        "m1",
      ]);
      // Duplicate tags do not duplicate results.
      expect(await ids({ tags: { e: ["z"] } })).toEqual(["m3"]);
      expect(await ids({ tags: { e: ["x"], p: ["y"] } })).toEqual(["m1"]);
      expect(await ids({ tags: { e: ["x", "z"], p: ["y"] } })).toEqual([
        "m3",
        "m1",
      ]);
      expect(await ids({ tags: { s: ["x"] } })).toEqual([]);
      expect(await ids({ tags: { e: [] } })).toEqual([]);
      expect(await ids({ kinds: [9], authors: [BOB] })).toEqual(["m3"]);
      expect(
        await ids({ kinds: [9], tags: { p: ["y"] }, since: 2, until: 3 }),
      ).toEqual(["m3"]);
      expect(await ids({ kinds: [1] })).toEqual([]);
      expect(await ids({ authors: [] })).toEqual([]);
      // Replacing a row reindexes its tags.
      await db.transaction((tx) =>
        tx.messages.put(message("m1", 1, { tags: [["e", "w"]] })),
      );
      expect(await ids({ tags: { e: ["x"] } })).toEqual(["m2"]);
      expect(await ids({ tags: { e: ["w"] } })).toEqual(["m1"]);
    });

    it("round-trips delivery evidence and indexes it sparsely", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const evidence = {
        envelope: event("e1"),
        message: bytes(1, 2),
        payload: bytes(3, 4),
        commitDigest: "cc",
      };
      await db.transaction(async (tx) => {
        await tx.deliveries.put(delivery("d2", "m1"));
        await tx.deliveries.put(delivery("d1", "m1", { evidence }));
        await tx.deliveries.put(
          delivery("d3", "m2", {
            evidence: {
              envelope: event("e3"),
              message: bytes(5),
              payload: bytes(6),
            },
          }),
        );
      });
      const byRumor = await db.deliveries.byRumor("m1");
      expect(byRumor.map((r) => r.id)).toEqual(["d1", "d2"]);
      expect(byRumor[0]).toEqual(delivery("d1", "m1", { evidence }));
      expectBytes(byRumor[0]!.evidence!.message, bytes(1, 2));
      expectBytes(byRumor[0]!.evidence!.payload, bytes(3, 4));
      expect(byRumor[1]).toEqual(delivery("d2", "m1"));
      expect(byRumor[1]!.evidence).toBeUndefined();
      expect(await db.deliveries.countByRumor("m2")).toBe(1);
      expect(await db.deliveries.countByRumor("missing")).toBe(0);
      expect(await db.deliveries.byRumor("missing")).toEqual([]);

      const withEvidence = await db.deliveries.withEvidence();
      expect(withEvidence.map((r) => r.id)).toEqual(["d1", "d3"]);
      expect(withEvidence[1]!.evidence!.commitDigest).toBeUndefined();
      expectBytes(withEvidence[1]!.evidence!.payload, bytes(6));

      // Clearing evidence removes a row from the sparse index.
      await db.transaction((tx) => tx.deliveries.put(delivery("d1", "m1")));
      expect((await db.deliveries.withEvidence()).map((r) => r.id)).toEqual([
        "d3",
      ]);
      expect(await db.deliveries.countByRumor("m1")).toBe(2);
      await db.transaction((tx) => tx.deliveries.delete("d3"));
      expect(await db.deliveries.withEvidence()).toEqual([]);
    });
  });

  describe(`${name}: account database`, () => {
    it("round-trips key packages", async () => {
      const { account } = await create();
      const full = keyPackage("k2", {
        publicPackage: bytes(2, 2),
        privatePackage: bytes(3, 3),
        identifier: "slot",
        notBefore: 5,
        published: [event("ev", 30443)],
        relays: ["wss://r"],
        consumptionReceipts: [{ groupId: "g1", keyPackageRef: "k2" }],
      });
      await account.transaction(async (tx) => {
        await tx.keyPackages.put(full);
        await tx.keyPackages.put(
          keyPackage("k1", { notBefore: 9, used: true }),
        );
      });
      expect((await account.keyPackages.all()).map((r) => r.ref)).toEqual([
        "k1",
        "k2",
      ]);
      const read = await account.keyPackages.get("k2");
      expect(read).toEqual(full);
      expectBytes(read!.publicPackage, bytes(2, 2));
      expectBytes(read!.privatePackage, bytes(3, 3));
      const minimal = await account.keyPackages.get("k1");
      expect(minimal).toEqual(keyPackage("k1", { notBefore: 9, used: true }));
      expect(minimal!.privatePackage).toBeUndefined();
      expect(minimal!.identifier).toBeUndefined();
      await account.transaction(async (tx) => {
        await tx.keyPackages.put({ ...full, privatePackage: undefined });
        await tx.keyPackages.delete("k1");
      });
      expect((await account.keyPackages.get("k2"))?.privatePackage).toBe(
        undefined,
      );
      expect(await account.keyPackages.get("k1")).toBeUndefined();
    });

    it("round-trips invite fields", async () => {
      const { account } = await create();
      const rumor = {
        id: "r1",
        kind: 444,
        pubkey: ALICE,
        created_at: 7,
        content: "welcome",
        tags: [["e", "kp"]],
      } as Rumor;
      const received = invite("w1", {
        receivedAt: 7,
        giftwrap: event("w1", 1059),
        attempted: true,
        invalid: false,
      });
      const unread = invite("r1", {
        state: "unread",
        rumorId: "r1",
        receivedAt: 7,
        rumor,
      });
      await account.transaction(async (tx) => {
        await tx.invites.put(received);
        await tx.invites.put(unread);
      });
      expect(await account.invites.get("w1")).toEqual(received);
      expect(await account.invites.get("r1")).toEqual(unread);
      expect(await account.invites.byRumor("r1")).toEqual(unread);
      await account.transaction((tx) => tx.invites.delete("w1"));
      expect(await account.invites.get("w1")).toBeUndefined();
    });

    it("indexes invites by state (oldest first) and rumor", async () => {
      const { account } = await create();
      await account.transaction(async (tx) => {
        await tx.invites.put(invite("w2", { receivedAt: 2 }));
        await tx.invites.put(invite("w1", { receivedAt: 1 }));
        await tx.invites.put(invite("w0", { receivedAt: 2 }));
        await tx.invites.put(invite("w9", { receivedAt: 10 }));
        await tx.invites.put(
          invite("w3", { state: "unread", rumorId: "r3", receivedAt: 3 }),
        );
      });
      expect(
        (await account.invites.byState("received")).map((r) => r.id),
      ).toEqual(["w1", "w0", "w2", "w9"]);
      expect((await account.invites.byRumor("r3"))?.id).toBe("w3");
      expect(await account.invites.byRumor("missing")).toBeUndefined();
      await account.transaction((tx) =>
        tx.invites.put(
          invite("w3", { state: "seen", rumorId: "r3", receivedAt: 3 }),
        ),
      );
      expect(await account.invites.byState("unread")).toEqual([]);
      expect((await account.invites.byState("seen")).map((r) => r.id)).toEqual([
        "w3",
      ]);
    });

    it("stores groups and intents", async () => {
      const { account } = await create();
      await account.transaction(async (tx) => {
        await tx.groups.put({ id: "g2", status: "terminal" });
        await tx.groups.put({ id: "g1", status: "active" });
        await tx.intents.put({ id: "i2", kind: "create", groupId: "g2" });
        await tx.intents.put({ id: "i1", kind: "join", groupId: "g1" });
      });
      expect(await account.groups.all()).toEqual([
        { id: "g1", status: "active" },
        { id: "g2", status: "terminal" },
      ]);
      expect(await account.groups.get("g2")).toEqual({
        id: "g2",
        status: "terminal",
      });
      expect(await account.intents.all()).toEqual([
        { id: "i1", kind: "join", groupId: "g1" },
        { id: "i2", kind: "create", groupId: "g2" },
      ]);
      await account.transaction(async (tx) => {
        await tx.groups.delete("g2");
        await tx.intents.delete("i1");
        expect((await tx.groups.all()).map((r) => r.id)).toEqual(["g1"]);
      });
      expect(await account.groups.get("g2")).toBeUndefined();
      expect((await account.intents.all()).map((r) => r.id)).toEqual(["i2"]);
    });

    it("rolls back when the callback throws", async () => {
      const { account } = await create();
      await expect(
        account.transaction(async (tx) => {
          await tx.groups.put({ id: "g1", status: "active" });
          await tx.keyPackages.put(keyPackage("k1"));
          await tx.invites.put(invite("w1"));
          await tx.intents.put({ id: "i1", kind: "join", groupId: "g1" });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await account.groups.all()).toEqual([]);
      expect(await account.keyPackages.all()).toEqual([]);
      expect(await account.invites.get("w1")).toBeUndefined();
      expect(await account.intents.all()).toEqual([]);
    });

    if (reopen)
      it("keeps committed account data across close and reopen", async () => {
        const database = await create();
        await database.account.transaction(async (tx) => {
          await tx.keyPackages.put(
            keyPackage("k1", { privatePackage: bytes(5) }),
          );
          await tx.invites.put(invite("w1", { rumorId: "r1" }));
        });
        await database.account.close();
        const restored = await reopen(database);
        expectBytes(
          (await restored.account.keyPackages.get("k1"))?.privatePackage,
          bytes(5),
        );
        expect((await restored.account.invites.byRumor("r1"))?.id).toBe("w1");
      });
  });
}
