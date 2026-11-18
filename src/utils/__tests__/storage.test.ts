import { describe, expect, it } from "vitest";
import {
  deletePrefix,
  memoryStorage,
  scopeStorage,
  StorageBatch,
  type MarmotStorage,
  type StorageOp,
} from "../storage.js";
import { decodeRecord, encodeRecord, RecordStore } from "../record-codec.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("memoryStorage", () => {
  it("copies values on write and read", async () => {
    const storage = memoryStorage();
    const value = bytes(1, 2);
    await storage.set("a", value);
    value[0] = 9;
    const read = (await storage.get("a"))!;
    expect([...read]).toEqual([1, 2]);
    read[1] = 9;
    expect([...(await storage.get("a"))!]).toEqual([1, 2]);
  });

  it("lists keys by prefix, sorted", async () => {
    const storage = memoryStorage();
    for (const key of ["b/2", "a/1", "b/1", "c"])
      await storage.set(key, bytes(0));
    expect(await storage.list("b/")).toEqual(["b/1", "b/2"]);
    expect(await storage.list("")).toEqual(["a/1", "b/1", "b/2", "c"]);
  });

  it("applies batches in order", async () => {
    const storage = memoryStorage();
    await storage.batch([
      { type: "set", key: "a", value: bytes(1) },
      { type: "delete", key: "a" },
      { type: "set", key: "b", value: bytes(2) },
    ]);
    expect(await storage.get("a")).toBeUndefined();
    expect([...(await storage.get("b"))!]).toEqual([2]);
  });
});

describe("scopeStorage", () => {
  it("prefixes every operation and strips listed keys", async () => {
    const root = memoryStorage();
    const scoped = scopeStorage(root, "group/");
    await scoped.set("x/state", bytes(1));
    await scoped.batch([{ type: "set", key: "x/tree/meta", value: bytes(2) }]);
    expect(await root.list("")).toEqual(["group/x/state", "group/x/tree/meta"]);
    expect(await scoped.list("x/")).toEqual(["x/state", "x/tree/meta"]);
    await deletePrefix(scoped, "x/");
    expect(await root.list("")).toEqual([]);
  });
});

describe("StorageBatch", () => {
  it("reads its own writes and commits once", async () => {
    const committed: StorageOp[][] = [];
    const inner = memoryStorage();
    const storage: MarmotStorage = {
      ...inner,
      get: (key) => inner.get(key),
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
      list: (prefix) => inner.list(prefix),
      batch: async (ops) => {
        committed.push([...ops]);
        await inner.batch(ops);
      },
    };
    await storage.set("old", bytes(1));
    const batch = new StorageBatch(storage);
    batch.set("new", bytes(2));
    batch.delete("old");
    expect([...(await batch.get("new"))!]).toEqual([2]);
    expect(await batch.get("old")).toBeUndefined();
    expect(await storage.get("old")).toBeDefined();
    await batch.commit();
    expect(committed).toHaveLength(1);
    expect(await storage.get("old")).toBeUndefined();
    expect(batch.size).toBe(0);
  });

  it("keeps ops queued when the commit fails", async () => {
    const inner = memoryStorage();
    let fail = true;
    const storage: MarmotStorage = {
      get: (key) => inner.get(key),
      set: (key, value) => inner.set(key, value),
      delete: (key) => inner.delete(key),
      list: (prefix) => inner.list(prefix),
      batch: async (ops) => {
        if (fail) throw new Error("disk full");
        await inner.batch(ops);
      },
    };
    const batch = new StorageBatch(storage);
    batch.set("a", bytes(1));
    await expect(batch.commit()).rejects.toThrow("disk full");
    expect(await inner.get("a")).toBeUndefined();
    fail = false;
    await batch.commit();
    expect(await inner.get("a")).toBeDefined();
  });
});

describe("record codec", () => {
  it("round-trips bytes, bigints and nested structures", () => {
    const value = {
      bytes: bytes(1, 255),
      big: 2n ** 70n,
      nested: [{ inner: bytes(3) }, "text", 5, null],
    };
    const decoded = decodeRecord<typeof value>(encodeRecord(value));
    expect(decoded.bytes).toBeInstanceOf(Uint8Array);
    expect([...decoded.bytes]).toEqual([1, 255]);
    expect(decoded.big).toBe(2n ** 70n);
    expect([...(decoded.nested[0] as { inner: Uint8Array }).inner]).toEqual([
      3,
    ]);
    expect(decoded.nested.slice(1)).toEqual(["text", 5, null]);
  });

  it("stores typed records under a prefix", async () => {
    const storage = memoryStorage();
    const records = new RecordStore<{ n: bigint }>(storage, "thing/");
    await records.set("b", { n: 2n });
    await records.set("a", { n: 1n });
    expect(await records.ids()).toEqual(["a", "b"]);
    expect(await records.get("b")).toEqual({ n: 2n });
    await records.delete("a");
    expect(await records.ids()).toEqual(["b"]);
    expect(await records.get("missing")).toBeUndefined();
  });
});
