/** @module @category Storage */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { MarmotStorage } from "./storage.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Encodes a structured record as bytes for {@link MarmotStorage}.
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
 * Typed records under one key prefix of a {@link MarmotStorage}, encoded with
 * {@link encodeRecord}. Ids are the key suffix after the prefix.
 */
export class RecordStore<T> {
  constructor(
    readonly storage: MarmotStorage,
    readonly prefix: string,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const bytes = await this.storage.get(this.prefix + id);
    return bytes && decodeRecord<T>(bytes);
  }

  async set(id: string, value: T): Promise<void> {
    await this.storage.set(this.prefix + id, encodeRecord(value));
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(this.prefix + id);
  }

  /** Every stored id, sorted. */
  async ids(): Promise<string[]> {
    return (await this.storage.list(this.prefix)).map((key) =>
      key.slice(this.prefix.length),
    );
  }
}
