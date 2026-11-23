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
import { matchFilter } from "applesauce-core/helpers/filter";
import { describe, expect, it } from "vitest";
import { compareMessages } from "../query.js";
import type {
  DeliveryRow,
  EffectRow,
  InviteRow,
  KeyPackageRow,
  MarmotDatabase,
  MessageFilter,
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
  options: { requireInspection?: boolean } = {},
): void {
  describe(`${name}: optional inspection`, () => {
    it("enumerates all rows in key order, independently of indexed queries", async () => {
      const database = await create();
      const db = await database.groups.open("inspection");
      const other = await database.groups.open("other");
      await other.transaction((tx) => tx.messages.put(message("excluded", 0)));
      await database.account.transaction(async (tx) => {
        await tx.invites.put(invite("z", { state: "seen" }));
        await tx.invites.put(invite("a", { state: "unread", receivedAt: 100 }));
        await tx.invites.put(invite("m"));
        if (options.requireInspection)
          expect(tx.invites.all).toBeTypeOf("function");
        if (tx.invites.all) {
          expect((await tx.invites.all()).map((row) => row.id)).toEqual([
            "a",
            "m",
            "z",
          ]);
        }
      });
      await db.transaction(async (tx) => {
        for (const key of ["z", "a"]) {
          await tx.treeNodes.put(treeNode(key));
          await tx.wrappers.put({ id: key, epoch: 1, outcome: "stale" });
          await tx.effects.put(
            effect(key, { state: key === "a" ? "pending" : "observed" }),
          );
          await tx.backfill.put({ relay: key, cursor: 1 });
          // Deliberately choose creation times opposite to primary-key order.
          await tx.messages.put(message(key, key === "a" ? 0 : 100));
          // No evidence, nor a corresponding rumor row.
          await tx.deliveries.put(delivery(key, "missing"));
        }
        for (const table of [
          tx.treeNodes,
          tx.wrappers,
          tx.effects,
          tx.backfill,
          tx.messages,
          tx.deliveries,
        ]) {
          if (options.requireInspection)
            expect(table.all).toBeTypeOf("function");
          if (table.all) expect(await table.all()).toHaveLength(2);
        }
      });
      if (options.requireInspection) {
        expect(database.groups.list).toBeTypeOf("function");
        expect(database.account.invites.all).toBeTypeOf("function");
      }
      for (const [table, key] of [
        [db.treeNodes, "tag"],
        [db.wrappers, "id"],
        [db.effects, "digest"],
        [db.backfill, "relay"],
        [db.messages, "id"],
        [db.deliveries, "id"],
      ] as const) {
        if (options.requireInspection) expect(table.all).toBeTypeOf("function");
        if (!table.all) continue;
        const rows = await table.all();
        expect(
          rows.map((row) => (row as unknown as Record<string, unknown>)[key]),
        ).toEqual(["a", "z"]);
      }
      if (database.account.invites.all) {
        expect(
          (await database.account.invites.all()).map((row) => row.id),
        ).toEqual(["a", "m", "z"]);
      }
      if (db.treeNodes.all) {
        const rows = await db.treeNodes.all();
        rows[0]!.snapshot[0] = 99;
        expectBytes((await db.treeNodes.get("a"))!.snapshot, bytes(1, 2, 3));
      }
      if (db.messages.all) {
        const rows = await db.messages.all();
        expect(rows).toEqual([message("a", 0), message("z", 100)]);
        rows[0]!.tags.push(["t", "mutated"]);
        expect((await db.messages.get("a"))!.tags).toEqual([]);
      }
      if (database.groups.list) {
        // Neither group has an account registry row.
        expect(await database.groups.list()).toEqual(["inspection", "other"]);
        await db.close();
        await database.groups.drop("inspection");
        expect(await database.groups.list()).toEqual(["other"]);
      } else {
        await db.close();
      }
      await other.close();
      await database.account.close();
    });

    it("enumerates empty tables and excludes rolled-back writes", async () => {
      const database = await create();
      if (database.groups.list)
        expect(await database.groups.list()).toEqual([]);
      const db = await database.groups.open("inspection");
      for (const table of [
        database.account.invites,
        db.treeNodes,
        db.wrappers,
        db.effects,
        db.backfill,
        db.messages,
        db.deliveries,
      ]) {
        if (table.all) expect(await table.all()).toEqual([]);
      }
      await expect(
        db.transaction(async (tx) => {
          await tx.treeNodes.put(treeNode("rolled-back"));
          await tx.wrappers.put({
            id: "rolled-back",
            epoch: 0,
            outcome: "accepted",
          });
          await tx.effects.put(effect("rolled-back"));
          await tx.backfill.put({ relay: "rolled-back" });
          await tx.messages.put(message("rolled-back", 0));
          await tx.deliveries.put(delivery("rolled-back", "missing"));
          throw new Rollback();
        }),
      ).rejects.toThrow(Rollback);
      await expect(
        database.account.transaction(async (tx) => {
          await tx.invites.put(invite("rolled-back"));
          throw new Rollback();
        }),
      ).rejects.toThrow(Rollback);
      for (const table of [
        database.account.invites,
        db.treeNodes,
        db.wrappers,
        db.effects,
        db.backfill,
        db.messages,
        db.deliveries,
      ]) {
        if (table.all) expect(await table.all()).toEqual([]);
      }
      await db.close();
      await database.account.close();
    });

    if (reopen) {
      it("discovers unregistered groups after reopening storage", async () => {
        const database = await create();
        const db = await database.groups.open("orphan");
        await db.transaction((tx) =>
          tx.wrappers.put({ id: "wrapper", epoch: 0, outcome: "stale" }),
        );
        await db.close();
        await database.account.close();
        const opened = await reopen(database);
        if (opened.groups.list)
          expect(await opened.groups.list()).toEqual(["orphan"]);
        const group = await opened.groups.open("orphan");
        if (group.wrappers.all)
          expect(await group.wrappers.all()).toEqual([
            { id: "wrapper", epoch: 0, outcome: "stale" },
          ]);
        await group.close();
        await opened.account.close();
      });
    }
  });

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
          (await tx.messages.query({ "#e": ["x"] })).map((r) => r.id),
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
          (await again.messages.query({ "#e": ["x"] })).map((r) => r.id),
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
      const ids = async (filter: MessageFilter = {}) =>
        (await db.messages.query(filter)).map((row) => row.id);
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
      const ids = async (filter: MessageFilter = {}) =>
        (await db.messages.query(filter)).map((row) => row.id);
      expect(await ids({ kinds: [9] })).toEqual(["m4", "m3", "m1"]);
      expect(await ids({ kinds: [7, 9], limit: 2 })).toEqual(["m4", "m3"]);
      expect(await ids({ authors: [BOB] })).toEqual(["m3", "m2"]);
      expect(await ids({ "#e": ["x"] })).toEqual(["m2", "m1"]);
      expect(await ids({ "#e": ["x", "z"] })).toEqual(["m3", "m2", "m1"]);
      // Duplicate tags do not duplicate results.
      expect(await ids({ "#e": ["z"] })).toEqual(["m3"]);
      expect(await ids({ "#e": ["x"], "#p": ["y"] })).toEqual(["m1"]);
      expect(await ids({ "#e": ["x", "z"], "#p": ["y"] })).toEqual([
        "m3",
        "m1",
      ]);
      expect(await ids({ "#s": ["x"] })).toEqual([]);
      // An empty tag clause is ignored, as in applesauce's matchFilter.
      expect(await ids({ "#e": [] })).toEqual(["m4", "m3", "m2", "m1"]);
      expect(await ids({ kinds: [9], authors: [BOB] })).toEqual(["m3"]);
      expect(
        await ids({ kinds: [9], "#p": ["y"], since: 2, until: 3 }),
      ).toEqual(["m3"]);
      expect(await ids({ kinds: [1] })).toEqual([]);
      expect(await ids({ authors: [] })).toEqual([]);
      // Replacing a row reindexes its tags.
      await db.transaction((tx) =>
        tx.messages.put(message("m1", 1, { tags: [["e", "w"]] })),
      );
      expect(await ids({ "#e": ["x"] })).toEqual(["m2"]);
      expect(await ids({ "#e": ["w"] })).toEqual(["m1"]);
    });

    it("answers NIP-91 AND tags, non-indexable tags and search", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.messages.put(
          message("m1", 1, {
            content: "Hello World",
            tags: [["t", "a"], ["t", "b"], ["subject", "x"], ["-"]],
          }),
        );
        await tx.messages.put(
          message("m2", 2, { content: "hello", tags: [["t", "a"]] }),
        );
        await tx.messages.put(message("m3", 3, { tags: [["t", "b"]] }));
      });
      const ids = async (filter: MessageFilter) =>
        (await db.messages.query(filter)).map((row) => row.id);
      expect(await ids({ "&t": ["a", "b"] })).toEqual(["m1"]);
      expect(await ids({ "&t": ["a"] })).toEqual(["m2", "m1"]);
      // `#` values also listed under `&` are dropped from the `#` clause.
      expect(await ids({ "&t": ["a"], "#t": ["a", "b"] })).toEqual(["m1"]);
      expect(await ids({ "&t": ["a"], "#t": ["a"] })).toEqual(["m2", "m1"]);
      expect(await ids({ "&t": [] })).toEqual(["m3", "m2", "m1"]);
      // Only single-letter tags are indexed.
      expect(await ids({ "#subject": ["x"] })).toEqual([]);
      expect(await ids({ "#-": [""] })).toEqual([]);
      expect(await ids({ search: "HELLO" })).toEqual(["m2", "m1"]);
      expect(await ids({ search: "world", "#t": ["a"] })).toEqual(["m1"]);
      expect(await ids({ search: "hello", limit: 1 })).toEqual(["m2"]);
      expect(await ids({ since: 3, until: 2 })).toEqual([]);
      expect(await ids({ until: 0 })).toEqual([]);
    });

    it("answers random filters like applesauce's matchFilter", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      // Deterministic PRNG (mulberry32).
      let seed = 0x5eed;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const int = (max: number) => Math.floor(random() * max);
      const pick = <T>(values: readonly T[]) => values[int(values.length)]!;
      const some = <T>(values: readonly T[], max = 3) =>
        Array.from({ length: 1 + int(max) }, () => pick(values));
      const authors = ["a", "b", "c", "d"].map((c) => c.repeat(64));
      const kinds = [1, 7, 9];
      const refs = ["r0", "r1", "r2", "r3", "r4", "r5"];
      const topics = ["x", "y", "z"];
      const rows: MessageRow[] = Array.from({ length: 300 }, (_, i) => {
        const tags: string[][] = [];
        for (let n = int(3); n > 0; n--) tags.push(["e", pick(refs)]);
        if (random() < 0.6) tags.push(["p", pick(authors)]);
        for (let n = int(3); n > 0; n--) tags.push(["t", pick(topics)]);
        if (random() < 0.2) tags.push(["subject", pick(topics)]);
        return message(`m${String(i).padStart(3, "0")}`, 1 + int(40), {
          kind: pick(kinds),
          pubkey: pick(authors),
          content: random() < 0.3 ? "Needle in a stack" : `row ${i}`,
          tags,
        });
      });
      await db.transaction(async (tx) => {
        for (const row of rows) await tx.messages.put(row);
      });
      for (let n = 0; n < 300; n++) {
        const filter: MessageFilter = {};
        if (random() < 0.1)
          filter.ids = some(
            rows.map((row) => row.id),
            5,
          );
        if (random() < 0.4) filter.kinds = some(kinds, 2);
        if (random() < 0.3) filter.authors = some(authors, 2);
        if (random() < 0.4) filter["#e"] = some(refs);
        if (random() < 0.2) filter["&t"] = some(topics, 2);
        if (random() < 0.3) filter["#t"] = some(topics, 2);
        if (random() < 0.2) filter["#p"] = some(authors, 2);
        if (random() < 0.3) filter.since = 1 + int(40);
        if (random() < 0.3) filter.until = 1 + int(40);
        if (random() < 0.1) filter.search = "needle";
        if (random() < 0.6) filter.limit = 1 + int(25);
        const expected = rows
          .filter((row) =>
            matchFilter(filter, {
              id: row.id,
              kind: row.kind,
              pubkey: row.pubkey,
              created_at: row.createdAt,
              content: row.content,
              tags: row.tags,
            } as Rumor),
          )
          // applesauce's matchFilter ignores NIP-50 search.
          .filter(
            (row) =>
              !filter.search ||
              row.content.toLowerCase().includes(filter.search),
          )
          .sort(compareMessages)
          .slice(0, filter.limit)
          .map((row) => row.id);
        const actual = (await db.messages.query(filter)).map((row) => row.id);
        expect({ filter, ids: actual }).toEqual({ filter, ids: expected });
      }
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
