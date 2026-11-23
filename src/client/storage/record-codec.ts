/** @module @category Storage */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a structured record as bytes for a database row value.
 *
 * JSON, with `Uint8Array` tagged as `{ "$bytes": hex }` and `bigint` as
 * `{ "$bigint": decimal }`. `undefined` object members are dropped.
 */
export function encodeRecord(value: unknown): Uint8Array {
  return encoder.encode(
    JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Uint8Array) return { $bytes: bytesToHex(item) };
      if (typeof item === "bigint") return { $bigint: item.toString() };
      return item;
    }),
  );
}

/** Decodes bytes produced by {@link encodeRecord}. Throws on malformed input. */
export function decodeRecord<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes), (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const keys = Object.keys(item);
      if (keys.length === 1 && typeof item.$bytes === "string")
        return hexToBytes(item.$bytes);
      if (keys.length === 1 && typeof item.$bigint === "string")
        return BigInt(item.$bigint);
    }
    return item;
  }) as T;
}

/**
 * A typed, record-encoded view of one account table, keyed by primary key.
 * `row` derives a stored record's index columns.
 */
export class AccountRecordTable<T, R extends { value: Uint8Array }> {
  constructor(
    readonly table: {
      get(id: string): Promise<R | undefined>;
      all(): Promise<R[]>;
    },
    readonly write: <X>(
      fn: (table: {
        put(row: R): Promise<void>;
        delete(id: string): Promise<void>;
      }) => Promise<X>,
    ) => Promise<X>,
    readonly row: (id: string, value: T, bytes: Uint8Array) => R,
    readonly idOf: (row: R) => string,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const row = await this.table.get(id);
    return row && decodeRecord<T>(row.value);
  }

  async set(id: string, value: T): Promise<void> {
    const row = this.row(id, value, encodeRecord(value));
    await this.write((table) => table.put(row));
  }

  async delete(id: string): Promise<void> {
    await this.write((table) => table.delete(id));
  }

  /** Every stored id, sorted. */
  async ids(): Promise<string[]> {
    return (await this.table.all()).map(this.idOf).sort();
  }
}
