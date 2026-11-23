import { describe, expect, it } from "vitest";
import { memoryDatabase } from "../database/memory.js";
import type { KeyPackageRow } from "../database/types.js";
import {
  AccountRecordTable,
  decodeRecord,
  encodeRecord,
} from "../record-codec.js";

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

  it("stores typed records in an account table with derived columns", async () => {
    const { account } = memoryDatabase();
    const records = new AccountRecordTable<{ n: bigint }, KeyPackageRow>(
      account.keyPackages,
      (fn) => account.transaction((tx) => fn(tx.keyPackages)),
      (ref, value, encoded) => ({
        ref,
        notBefore: Number(value.n),
        used: false,
        value: encoded,
      }),
      (row) => row.ref,
    );
    await records.set("b", { n: 2n });
    await records.set("a", { n: 1n });
    expect(await records.ids()).toEqual(["a", "b"]);
    expect(await records.get("b")).toEqual({ n: 2n });
    expect((await account.keyPackages.get("b"))?.notBefore).toBe(2);
    await records.delete("a");
    expect(await records.ids()).toEqual(["b"]);
    expect(await records.get("missing")).toBeUndefined();
  });
});
