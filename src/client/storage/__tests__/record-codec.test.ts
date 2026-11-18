import { describe, expect, it } from "vitest";
import { decodeRecord, encodeRecord, RecordStore } from "../record-codec.js";
import { memoryStorage } from "../storage.js";

const bytes = (...values: number[]) => Uint8Array.from(values);

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
