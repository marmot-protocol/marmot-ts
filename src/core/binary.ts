/** @module @category Core - Binary Encoding */

/**
 * The Marmot binary profile.
 *
 * Marmot-owned binary structures (app component state, app component updates, Marmot
 * extensions, and other byte strings owned by the Marmot spec) use TLS Presentation
 * Language syntax with QUIC variable-length vector prefixes. This module implements that
 * profile: fixed-width network-byte-order integers, fixed `opaque[N]` fields, QUIC
 * variable-length integer length prefixes, and length-prefixed variable vectors.
 *
 * It does not cover bytes owned by another protocol. MLS messages, KeyPackages,
 * credentials, and MLS-defined extensions use the encoding defined by MLS; Nostr event ids
 * and signatures use the Nostr canonical event serialization; transport envelopes use the
 * encoding defined by their transport document.
 *
 * @see Marmot v2 spec: `foundation/canonical-encoding.md`
 */

/** Largest value representable by a QUIC variable-length integer (`2^62 - 1`). */
export const MAX_VARINT = 4611686018427387903n;

/** Smallest value that requires each QUIC varint prefix size, indexed by prefix bits. */
const VARINT_MINS = [0n, 64n, 16384n, 1073741824n];

/** Error thrown when bytes do not conform to the Marmot binary profile. */
export class BinaryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryDecodeError";
  }
}

function toBigInt(value: number | bigint, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isInteger(value)) {
    throw new RangeError(`${field} must be an integer, got ${value}`);
  }
  return BigInt(value);
}

/**
 * Encodes a QUIC variable-length integer using the shortest prefix size that can hold the
 * value, as required for canonical Marmot encoding.
 *
 * @param value - A non-negative integer in `[0, MAX_VARINT]`.
 */
export function encodeVarint(value: number | bigint): Uint8Array {
  const v = toBigInt(value, "varint");
  if (v < 0n) throw new RangeError(`varint must be non-negative, got ${v}`);
  if (v > MAX_VARINT) throw new RangeError(`varint too large: ${v}`);

  let len: number;
  let prefixBits: number;
  if (v < 64n) {
    len = 1;
    prefixBits = 0;
  } else if (v < 16384n) {
    len = 2;
    prefixBits = 1;
  } else if (v < 1073741824n) {
    len = 4;
    prefixBits = 2;
  } else {
    len = 8;
    prefixBits = 3;
  }

  const out = new Uint8Array(len);
  let tmp = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  out[0] |= prefixBits << 6;
  return out;
}

/**
 * Decodes a QUIC variable-length integer at `offset`.
 *
 * Rejects non-minimal encodings: a value MUST use the shortest prefix size that can hold
 * it, so a longer prefix for the same value is invalid.
 *
 * @returns The decoded value and the number of bytes consumed.
 */
export function decodeVarint(
  data: Uint8Array,
  offset = 0,
): { value: bigint; length: number } {
  if (offset < 0 || offset >= data.length) {
    throw new BinaryDecodeError("varint: read past end of buffer");
  }
  const first = data[offset];
  const prefixBits = first >> 6;
  const len = 1 << prefixBits;
  if (offset + len > data.length) {
    throw new BinaryDecodeError("varint: truncated length prefix");
  }

  let value = BigInt(first & 0x3f);
  for (let i = 1; i < len; i++) {
    value = (value << 8n) | BigInt(data[offset + i]);
  }

  if (value < VARINT_MINS[prefixBits]) {
    throw new BinaryDecodeError(
      `varint: non-minimal encoding (value ${value} in ${len}-byte prefix)`,
    );
  }

  return { value, length: len };
}

/** Number of bytes a value would occupy when encoded as a QUIC varint. */
export function varintSize(value: number | bigint): number {
  const v = toBigInt(value, "varint");
  if (v < 0n || v > MAX_VARINT)
    throw new RangeError(`varint out of range: ${v}`);
  if (v < 64n) return 1;
  if (v < 16384n) return 2;
  if (v < 1073741824n) return 4;
  return 8;
}

interface OpaqueBounds {
  /** Minimum decoded byte length (inclusive). Defaults to `0`. */
  min?: number;
  /** Maximum decoded byte length (inclusive). Defaults to unbounded. */
  max?: number;
}

/**
 * Builds a byte string in the Marmot binary profile. Methods append in field order and
 * return `this` for chaining; call {@link BinaryWriter.build} to materialize the bytes.
 */
export class BinaryWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  /** Appends a `uint8`. */
  uint8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`uint8 out of range: ${value}`);
    }
    return this.push(Uint8Array.of(value));
  }

  /** Appends a big-endian `uint16`. */
  uint16(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new RangeError(`uint16 out of range: ${value}`);
    }
    return this.push(Uint8Array.of((value >> 8) & 0xff, value & 0xff));
  }

  /** Appends a big-endian `uint32`. */
  uint32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`uint32 out of range: ${value}`);
    }
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, false);
    return this.push(out);
  }

  /** Appends a big-endian `uint64`. */
  uint64(value: number | bigint): this {
    const v = toBigInt(value, "uint64");
    if (v < 0n || v > 0xffffffffffffffffn) {
      throw new RangeError(`uint64 out of range: ${v}`);
    }
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, v, false);
    return this.push(out);
  }

  /** Appends a QUIC variable-length integer. */
  varint(value: number | bigint): this {
    return this.push(encodeVarint(value));
  }

  /** Appends raw fixed bytes with no length prefix (`opaque name[N]`). */
  bytes(value: Uint8Array): this {
    return this.push(value);
  }

  /**
   * Appends a variable-length byte string as a QUIC varint length prefix followed by the
   * bytes (`opaque name<min..max>`).
   */
  opaque(value: Uint8Array, bounds?: OpaqueBounds): this {
    checkBounds(value.length, bounds, "opaque");
    return this.push(encodeVarint(value.length)).push(value);
  }

  /**
   * Appends a list as a QUIC varint byte-length prefix followed by the concatenated item
   * encodings (`Type items<V>`).
   */
  vector(items: Uint8Array[], bounds?: OpaqueBounds): this {
    let total = 0;
    for (const item of items) total += item.length;
    checkBounds(total, bounds, "vector");
    this.varint(total);
    for (const item of items) this.push(item);
    return this;
  }

  /** Materializes the accumulated bytes. */
  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function checkBounds(
  len: number,
  bounds: OpaqueBounds | undefined,
  field: string,
): void {
  if (!bounds) return;
  if (bounds.min !== undefined && len < bounds.min) {
    throw new RangeError(`${field} length ${len} below minimum ${bounds.min}`);
  }
  if (bounds.max !== undefined && len > bounds.max) {
    throw new RangeError(`${field} length ${len} above maximum ${bounds.max}`);
  }
}

/**
 * Reads a byte string in the Marmot binary profile with a moving cursor. Read methods
 * advance the cursor and throw {@link BinaryDecodeError} on truncated or non-canonical
 * input.
 */
export class BinaryReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Bytes not yet consumed. */
  get remaining(): number {
    return this.data.length - this.offset;
  }

  /** Current cursor position. */
  get position(): number {
    return this.offset;
  }

  /** Whether any bytes remain to be read. */
  hasMore(): boolean {
    return this.offset < this.data.length;
  }

  private require(n: number, field: string): void {
    if (this.offset + n > this.data.length) {
      throw new BinaryDecodeError(`${field}: read past end of buffer`);
    }
  }

  /** Reads a `uint8`. */
  uint8(): number {
    this.require(1, "uint8");
    return this.data[this.offset++];
  }

  /** Reads a big-endian `uint16`. */
  uint16(): number {
    this.require(2, "uint16");
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  /** Reads a big-endian `uint32`. */
  uint32(): number {
    this.require(4, "uint32");
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  /** Reads a big-endian `uint64`. */
  uint64(): bigint {
    this.require(8, "uint64");
    const value = this.view.getBigUint64(this.offset, false);
    this.offset += 8;
    return value;
  }

  /** Reads a QUIC variable-length integer as a `bigint`. */
  varintBig(): bigint {
    const { value, length } = decodeVarint(this.data, this.offset);
    this.offset += length;
    return value;
  }

  /**
   * Reads a QUIC variable-length integer as a `number`. Throws if the value exceeds
   * {@link Number.MAX_SAFE_INTEGER}; use {@link BinaryReader.varintBig} for larger values.
   */
  varint(): number {
    const value = this.varintBig();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BinaryDecodeError(
        `varint: value ${value} exceeds safe integer range`,
      );
    }
    return Number(value);
  }

  /** Reads exactly `n` raw bytes (`opaque name[N]`). */
  bytes(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(
        `bytes length must be a non-negative integer, got ${n}`,
      );
    }
    this.require(n, "bytes");
    const out = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  /**
   * Reads a variable-length byte string written as a QUIC varint length prefix followed by
   * the bytes (`opaque name<min..max>`). Enforces the field bounds when given.
   */
  opaque(bounds?: OpaqueBounds): Uint8Array {
    const len = this.varint();
    if (bounds) {
      if (bounds.min !== undefined && len < bounds.min) {
        throw new BinaryDecodeError(
          `opaque length ${len} below minimum ${bounds.min}`,
        );
      }
      if (bounds.max !== undefined && len > bounds.max) {
        throw new BinaryDecodeError(
          `opaque length ${len} above maximum ${bounds.max}`,
        );
      }
    }
    return this.bytes(len);
  }

  /**
   * Reads a list written as a QUIC varint byte-length prefix followed by concatenated item
   * encodings (`Type items<V>`). The body MUST decode to a whole number of items with no
   * trailing bytes.
   */
  vector<T>(readItem: (reader: BinaryReader) => T, bounds?: OpaqueBounds): T[] {
    const byteLength = this.varint();
    if (bounds) {
      if (bounds.min !== undefined && byteLength < bounds.min) {
        throw new BinaryDecodeError(
          `vector length ${byteLength} below minimum ${bounds.min}`,
        );
      }
      if (bounds.max !== undefined && byteLength > bounds.max) {
        throw new BinaryDecodeError(
          `vector length ${byteLength} above maximum ${bounds.max}`,
        );
      }
    }
    this.require(byteLength, "vector");
    // Copy (not subarray) so the inner reader owns an independent buffer — the
    // same non-aliasing discipline as `bytes()`, avoiding a view that shares
    // (and keeps alive) the outer backing store.
    const body = this.data.slice(this.offset, this.offset + byteLength);
    this.offset += byteLength;

    const inner = new BinaryReader(body);
    const items: T[] = [];
    while (inner.hasMore()) {
      items.push(readItem(inner));
    }
    if (inner.remaining !== 0) {
      throw new BinaryDecodeError("vector: trailing bytes after final item");
    }
    return items;
  }

  /**
   * Asserts that the cursor has consumed the entire buffer. Use this when a document says a
   * value is "decoded exactly".
   */
  end(): void {
    if (this.remaining !== 0) {
      throw new BinaryDecodeError(
        `expected end of buffer, ${this.remaining} byte(s) remaining`,
      );
    }
  }
}

/** UTF-8 encodes text. Marmot text fields are UTF-8 byte strings. */
export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** UTF-8 decodes bytes without Unicode normalization. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
