import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import {
  BinaryReader,
  BinaryWriter,
  BinaryDecodeError,
  MAX_VARINT,
  decodeVarint,
  encodeVarint,
  varintSize,
  encodeUtf8,
  decodeUtf8,
} from "../binary.js";

const hex = (s: string) => hexToBytes(s.replace(/\s+/g, ""));

describe("QUIC varint encoding", () => {
  it("encodes an empty/zero length as a single 00 byte", () => {
    expect(bytesToHex(encodeVarint(0))).toBe("00");
  });

  it("matches the spec worked examples", () => {
    // a seven-byte value's length prefix is 07
    expect(bytesToHex(encodeVarint(7))).toBe("07");
    // 64 is the first 2-byte value, starting with 0x40
    expect(bytesToHex(encodeVarint(64))).toBe("4040");
    // 16383 is the largest 2-byte value
    expect(bytesToHex(encodeVarint(16383))).toBe("7fff");
    // 16384 is the first 4-byte value
    expect(bytesToHex(encodeVarint(16384))).toBe("80004000");
  });

  it("uses the shortest prefix at each boundary", () => {
    expect(varintSize(63)).toBe(1);
    expect(varintSize(64)).toBe(2);
    expect(varintSize(16383)).toBe(2);
    expect(varintSize(16384)).toBe(4);
    expect(varintSize(1073741823)).toBe(4);
    expect(varintSize(1073741824)).toBe(8);
  });

  it("round-trips boundary values", () => {
    for (const v of [
      0n,
      1n,
      63n,
      64n,
      16383n,
      16384n,
      1073741823n,
      1073741824n,
      MAX_VARINT,
    ]) {
      const encoded = encodeVarint(v);
      const { value, length } = decodeVarint(encoded);
      expect(value).toBe(v);
      expect(length).toBe(encoded.length);
    }
  });

  it("rejects values out of range", () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => encodeVarint(MAX_VARINT + 1n)).toThrow(RangeError);
  });

  it("rejects non-minimal (longer-than-needed) encodings", () => {
    // value 5 encoded in a 2-byte prefix (0x4005) is non-canonical
    expect(() => decodeVarint(hex("4005"))).toThrow(BinaryDecodeError);
    // value 100 (fits in 2 bytes) encoded in a 4-byte prefix
    expect(() => decodeVarint(hex("80000064"))).toThrow(BinaryDecodeError);
    // value 0 in a 2-byte prefix
    expect(() => decodeVarint(hex("4000"))).toThrow(BinaryDecodeError);
  });

  it("rejects a truncated length prefix", () => {
    expect(() => decodeVarint(hex("40"))).toThrow(BinaryDecodeError);
    expect(() => decodeVarint(new Uint8Array())).toThrow(BinaryDecodeError);
  });
});

describe("fixed-width integers", () => {
  it("round-trips uint8/16/32/64 in network byte order", () => {
    const bytes = new BinaryWriter()
      .uint8(0x12)
      .uint16(0x1234)
      .uint32(0x12345678)
      .uint64(0x123456789abcdef0n)
      .build();
    expect(bytesToHex(bytes)).toBe(
      "12" + "1234" + "12345678" + "123456789abcdef0",
    );

    const r = new BinaryReader(bytes);
    expect(r.uint8()).toBe(0x12);
    expect(r.uint16()).toBe(0x1234);
    expect(r.uint32()).toBe(0x12345678);
    expect(r.uint64()).toBe(0x123456789abcdef0n);
    r.end();
  });

  it("rejects out-of-range integers", () => {
    expect(() => new BinaryWriter().uint8(256)).toThrow(RangeError);
    expect(() => new BinaryWriter().uint16(0x10000)).toThrow(RangeError);
    expect(() => new BinaryWriter().uint64(-1n)).toThrow(RangeError);
  });

  it("throws when reading past the end", () => {
    expect(() => new BinaryReader(hex("12")).uint16()).toThrow(
      BinaryDecodeError,
    );
  });
});

describe("opaque fixed and variable fields", () => {
  it("writes fixed bytes with no length prefix", () => {
    const id = hex("00112233445566778899aabbccddeeff");
    const bytes = new BinaryWriter().bytes(id).build();
    expect(bytes).toEqual(id);
    expect(new BinaryReader(bytes).bytes(16)).toEqual(id);
  });

  it("round-trips a variable opaque field with a varint prefix", () => {
    const payload = hex("09 02 62 22 37 5a 36"); // 7-byte value from the spec
    const bytes = new BinaryWriter().opaque(payload).build();
    expect(bytesToHex(bytes)).toBe(
      "07" + "0902622237 5a36".replace(/\s+/g, ""),
    );

    const r = new BinaryReader(bytes);
    expect(r.opaque()).toEqual(payload);
    r.end();
  });

  it("encodes an empty variable opaque field as 00", () => {
    const bytes = new BinaryWriter().opaque(new Uint8Array()).build();
    expect(bytesToHex(bytes)).toBe("00");
    expect(new BinaryReader(bytes).opaque()).toEqual(new Uint8Array());
  });

  it("enforces opaque bounds on encode and decode", () => {
    expect(() => new BinaryWriter().opaque(hex("aabb"), { max: 1 })).toThrow(
      RangeError,
    );
    // a 2-byte value decoded with max 1
    const bytes = new BinaryWriter().opaque(hex("aabb")).build();
    expect(() => new BinaryReader(bytes).opaque({ max: 1 })).toThrow(
      BinaryDecodeError,
    );
    expect(() => new BinaryReader(bytes).opaque({ min: 3 })).toThrow(
      BinaryDecodeError,
    );
  });
});

describe("Type items<V> vectors", () => {
  it("round-trips a vector of uint16 items", () => {
    const items = [1, 2, 0xffff];
    const bytes = new BinaryWriter()
      .vector(items.map((n) => new BinaryWriter().uint16(n).build()))
      .build();
    // total body length is 6 bytes -> prefix 06
    expect(bytesToHex(bytes)).toBe("06" + "0001" + "0002" + "ffff");

    const r = new BinaryReader(bytes);
    const decoded = r.vector((reader) => reader.uint16());
    expect(decoded).toEqual(items);
    r.end();
  });

  it("decodes an empty vector", () => {
    const bytes = new BinaryWriter().vector([]).build();
    expect(bytesToHex(bytes)).toBe("00");
    expect(new BinaryReader(bytes).vector((r) => r.uint8())).toEqual([]);
  });

  it("rejects a body that does not split into whole items", () => {
    // body length 3, but each item reads 2 bytes -> trailing byte
    const bytes = hex("03 0001 02");
    expect(() => new BinaryReader(bytes).vector((r) => r.uint16())).toThrow(
      BinaryDecodeError,
    );
  });
});

describe("exact decode", () => {
  it("end() rejects trailing bytes", () => {
    const r = new BinaryReader(hex("1234 56"));
    r.uint16();
    expect(() => r.end()).toThrow(BinaryDecodeError);
  });

  it("tracks position and remaining", () => {
    const r = new BinaryReader(hex("1234 56"));
    expect(r.position).toBe(0);
    expect(r.remaining).toBe(3);
    r.uint16();
    expect(r.position).toBe(2);
    expect(r.remaining).toBe(1);
    expect(r.hasMore()).toBe(true);
    r.uint8();
    expect(r.hasMore()).toBe(false);
  });
});

describe("utf-8 text", () => {
  it("round-trips unicode without normalization", () => {
    const text = "café \u{1F436}"; // includes a non-ASCII char and an emoji
    const bytes = encodeUtf8(text);
    expect(decodeUtf8(bytes)).toBe(text);
  });

  it("rejects invalid utf-8", () => {
    expect(() => decodeUtf8(hex("ff"))).toThrow();
  });

  it("composes with opaque for a variable text field", () => {
    const text = "marmot";
    const bytes = new BinaryWriter().opaque(encodeUtf8(text)).build();
    const r = new BinaryReader(bytes);
    expect(decodeUtf8(r.opaque())).toBe(text);
    r.end();
  });
});
