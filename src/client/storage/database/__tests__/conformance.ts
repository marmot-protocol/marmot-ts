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
import { describe, expect, it } from "vitest";
import type { DeliveryRow, MarmotDatabase, MessageRow } from "../types.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

function message(
  id: string,
  createdAt: number,
  extra: Partial<MessageRow> = {},
): MessageRow {
  return {
    id,
    kind: 9,
    pubkey: "a".repeat(64),
    createdAt,
    tags: [],
    value: bytes(createdAt),
    ...extra,
  };
}

function delivery(
  id: string,
  rumorId: string,
  extra: Partial<DeliveryRow> = {},
): DeliveryRow {
  return { id, rumorId, epoch: 1, createdAt: 1, value: bytes(1), ...extra };
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
  describe(`${name}: group database`, () => {
    it("commits writes across tables atomically", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.meta.set("state", bytes(1));
        await tx.treeNodes.put({ tag: "t1", value: bytes(2) });
        await tx.wrappers.put({ id: "w1", epoch: 3, value: bytes(3) });
        await tx.messages.put(message("m1", 10));
        await tx.deliveries.put(delivery("d1", "m1"));
      });
      expect(await db.meta.get("state")).toEqual(bytes(1));
      expect((await db.treeNodes.get("t1"))?.value).toEqual(bytes(2));
      expect(await db.wrappers.get("w1")).toMatchObject({ id: "w1", epoch: 3 });
      expect((await db.messages.get("m1"))?.createdAt).toBe(10);
      expect(await db.deliveries.countByRumor("m1")).toBe(1);
    });

    it("rolls back every table when the callback throws", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction((tx) => tx.meta.set("state", bytes(1)));
      await expect(
        db.transaction(async (tx) => {
          await tx.meta.set("state", bytes(9));
          await tx.messages.put(message("m1", 1));
          await tx.deliveries.put(delivery("d1", "m1"));
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await db.meta.get("state")).toEqual(bytes(1));
      expect(await db.messages.get("m1")).toBeUndefined();
      expect(await db.deliveries.countByRumor("m1")).toBe(0);
    });

    it("sees its own writes inside a transaction", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.deliveries.put(delivery("d1", "m1"));
        await tx.deliveries.put(delivery("d2", "m1"));
        expect(await tx.deliveries.countByRumor("m1")).toBe(2);
        await tx.deliveries.delete("d1");
        expect(await tx.deliveries.countByRumor("m1")).toBe(1);
        await tx.meta.set("tree", bytes(4));
        expect(await tx.meta.get("tree")).toEqual(bytes(4));
      });
    });

    it("isolates groups and drops one without touching others", async () => {
      const { groups } = await create();
      const a = await groups.open("aa");
      const b = await groups.open("bb");
      await a.transaction((tx) => tx.meta.set("state", bytes(1)));
      await b.transaction((tx) => tx.meta.set("state", bytes(2)));
      expect(await a.meta.get("state")).toEqual(bytes(1));
      await a.close();
      await groups.drop("aa");
      await groups.drop("missing");
      const reopened = await groups.open("aa");
      expect(await reopened.meta.get("state")).toBeUndefined();
      expect(await b.meta.get("state")).toEqual(bytes(2));
    });

    it("deletes wrappers below an epoch floor, keeping exceptions", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        for (const [id, epoch] of [
          ["w1", 1],
          ["w2", 2],
          ["w3", 3],
          ["w4", 1],
        ] as const)
          await tx.wrappers.put({ id, epoch, value: bytes(epoch) });
      });
      await db.transaction((tx) => tx.wrappers.deleteBelow(3, ["w4"]));
      expect(await db.wrappers.get("w1")).toBeUndefined();
      expect(await db.wrappers.get("w2")).toBeUndefined();
      expect(await db.wrappers.get("w3")).toBeDefined();
      expect(await db.wrappers.get("w4")).toBeDefined();
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
      expect(await ids({ since: 20 })).toEqual(["d", "a", "b"]);
      expect(await ids({ until: 20 })).toEqual(["a", "b", "c"]);
      expect(await ids({ since: 15, until: 25, limit: 1 })).toEqual(["a"]);
      expect(await ids({ ids: ["c", "d"] })).toEqual(["d", "c"]);
    });

    it("filters messages by kind, author and tags (AND of ORs)", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const alice = "a".repeat(64);
      const bob = "b".repeat(64);
      await db.transaction(async (tx) => {
        await tx.messages.put(
          message("m1", 1, { kind: 9, pubkey: alice, tags: ["e:x", "p:y"] }),
        );
        await tx.messages.put(
          message("m2", 2, { kind: 7, pubkey: bob, tags: ["e:x"] }),
        );
        await tx.messages.put(
          message("m3", 3, { kind: 9, pubkey: bob, tags: ["e:z", "p:y"] }),
        );
      });
      const ids = async (query = {}) =>
        (await db.messages.query(query)).map((row) => row.id);
      expect(await ids({ kinds: [9] })).toEqual(["m3", "m1"]);
      expect(await ids({ authors: [bob] })).toEqual(["m3", "m2"]);
      expect(await ids({ tags: [["e:x"]] })).toEqual(["m2", "m1"]);
      expect(await ids({ tags: [["e:x", "e:z"]] })).toEqual(["m3", "m2", "m1"]);
      expect(await ids({ tags: [["e:x"], ["p:y"]] })).toEqual(["m1"]);
      expect(await ids({ kinds: [9], authors: [bob] })).toEqual(["m3"]);
      expect(await ids({ kinds: [1] })).toEqual([]);
    });

    it("indexes deliveries by rumor and evidence", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      await db.transaction(async (tx) => {
        await tx.deliveries.put(delivery("d1", "m1", { evidence: bytes(1) }));
        await tx.deliveries.put(delivery("d2", "m1"));
        await tx.deliveries.put(delivery("d3", "m2", { evidence: bytes(3) }));
      });
      expect((await db.deliveries.byRumor("m1")).map((r) => r.id)).toEqual([
        "d1",
        "d2",
      ]);
      expect(await db.deliveries.countByRumor("m2")).toBe(1);
      expect((await db.deliveries.withEvidence()).map((r) => r.id)).toEqual([
        "d1",
        "d3",
      ]);
      // Clearing evidence removes a row from the sparse index.
      await db.transaction((tx) => tx.deliveries.put(delivery("d1", "m1")));
      expect((await db.deliveries.withEvidence()).map((r) => r.id)).toEqual([
        "d3",
      ]);
    });

    it("returns copies of stored bytes", async () => {
      const { groups } = await create();
      const db = await groups.open("aa");
      const value = bytes(1, 2);
      await db.transaction((tx) => tx.meta.set("state", value));
      value[0] = 9;
      const read = await db.meta.get("state");
      expect(read).toEqual(bytes(1, 2));
      read![0] = 9;
      expect(await db.meta.get("state")).toEqual(bytes(1, 2));
    });

    if (reopen)
      it("keeps committed data across close and reopen", async () => {
        const database = await create();
        const db = await database.groups.open("aa");
        await db.transaction(async (tx) => {
          await tx.meta.set("state", bytes(1));
          await tx.messages.put(message("m1", 1, { tags: ["e:x"] }));
        });
        await db.close();
        await database.account.close();
        const restored = await reopen(database);
        const again = await restored.groups.open("aa");
        expect(await again.meta.get("state")).toEqual(bytes(1));
        expect(
          (await again.messages.query({ tags: [["e:x"]] })).map((r) => r.id),
        ).toEqual(["m1"]);
      });
  });

  describe(`${name}: account database`, () => {
    it("stores key packages, groups and intents", async () => {
      const { account } = await create();
      await account.transaction(async (tx) => {
        await tx.keyPackages.put({
          ref: "k2",
          identifier: "slot",
          notBefore: 5,
          used: false,
          value: bytes(2),
        });
        await tx.keyPackages.put({
          ref: "k1",
          notBefore: 9,
          used: true,
          value: bytes(1),
        });
        await tx.groups.put({ id: "g1", status: "active", value: bytes() });
        await tx.intents.put({
          id: "i1",
          kind: "join",
          groupId: "g1",
          value: bytes(),
        });
        await tx.meta.set("format", bytes(1));
      });
      expect((await account.keyPackages.all()).map((r) => r.ref)).toEqual([
        "k1",
        "k2",
      ]);
      expect(await account.keyPackages.get("k2")).toMatchObject({
        identifier: "slot",
        notBefore: 5,
        used: false,
      });
      expect((await account.keyPackages.get("k1"))?.identifier).toBeUndefined();
      expect((await account.groups.all()).map((r) => r.id)).toEqual(["g1"]);
      expect((await account.intents.all()).map((r) => r.id)).toEqual(["i1"]);
      expect(await account.meta.get("format")).toEqual(bytes(1));
    });

    it("indexes invites by state and rumor", async () => {
      const { account } = await create();
      await account.transaction(async (tx) => {
        await tx.invites.put({
          id: "w2",
          state: "received",
          receivedAt: 2,
          value: bytes(),
        });
        await tx.invites.put({
          id: "w1",
          state: "received",
          receivedAt: 1,
          value: bytes(),
        });
        await tx.invites.put({
          id: "w3",
          state: "unread",
          rumorId: "r3",
          receivedAt: 3,
          value: bytes(),
        });
      });
      expect(
        (await account.invites.byState("received")).map((r) => r.id),
      ).toEqual(["w1", "w2"]);
      expect((await account.invites.byRumor("r3"))?.id).toBe("w3");
      expect(await account.invites.byRumor("missing")).toBeUndefined();
      await account.transaction((tx) =>
        tx.invites.put({
          id: "w3",
          state: "seen",
          rumorId: "r3",
          receivedAt: 3,
          value: bytes(),
        }),
      );
      expect(await account.invites.byState("unread")).toEqual([]);
    });

    it("rolls back when the callback throws", async () => {
      const { account } = await create();
      await expect(
        account.transaction(async (tx) => {
          await tx.groups.put({ id: "g1", status: "active", value: bytes() });
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await account.groups.all()).toEqual([]);
    });
  });
}
