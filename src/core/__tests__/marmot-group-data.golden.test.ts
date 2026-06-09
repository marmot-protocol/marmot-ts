/**
 * Golden wire-byte vectors for the v2 MarmotGroupData encoding.
 *
 * These lock the exact bytes so the Phase 1 refactor that routes encoding
 * through the shared Marmot binary profile (`core/binary.ts`) is provably
 * byte-preserving. Round-trip tests alone would not catch a wire-format change.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  decodeMarmotGroupData,
  encodeMarmotGroupData,
} from "../marmot-group-data.js";
import type { MarmotGroupData } from "../protocol.js";

const fixture: MarmotGroupData = {
  version: 2,
  nostrGroupId: new Uint8Array(32).fill(0x11),
  name: "Café", // multibyte UTF-8 (é = c3 a9)
  description: "desc",
  adminPubkeys: ["a".repeat(64), "b".repeat(64)],
  relays: ["wss://relay.one", "wss://relay.two"],
  imageHash: new Uint8Array(32).fill(0x22),
  imageKey: new Uint8Array(32).fill(0x33),
  imageNonce: new Uint8Array(12).fill(0x44),
  imageUploadKey: new Uint8Array(32).fill(0x55),
};

// Captured from the pre-refactor encoder; the QUIC-varint v2 profile.
const GOLDEN_HEX =
  "0002111111111111111111111111111111111111111111111111111111111111111105436166c3a904646573634040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb200f7773733a2f2f72656c61792e6f6e650f7773733a2f2f72656c61792e74776f2022222222222222222222222222222222222222222222222222222222222222222033333333333333333333333333333333333333333333333333333333333333330c444444444444444444444444205555555555555555555555555555555555555555555555555555555555555555";

describe("MarmotGroupData v2 golden wire bytes", () => {
  it("encodes to the locked byte vector", () => {
    const encoded = encodeMarmotGroupData(fixture);
    expect(bytesToHex(encoded)).toBe(GOLDEN_HEX);
  });

  it("round-trips the golden vector back to the fixture", () => {
    const decoded = decodeMarmotGroupData(hexToBytes(GOLDEN_HEX));
    expect(decoded.version).toBe(2);
    expect(decoded.name).toBe(fixture.name);
    expect(decoded.description).toBe(fixture.description);
    expect(decoded.adminPubkeys).toEqual(fixture.adminPubkeys);
    expect(decoded.relays).toEqual(fixture.relays);
    expect(bytesToHex(decoded.nostrGroupId)).toBe(
      bytesToHex(fixture.nostrGroupId),
    );
    expect(bytesToHex(decoded.imageHash)).toBe(bytesToHex(fixture.imageHash));
    expect(bytesToHex(decoded.imageKey)).toBe(bytesToHex(fixture.imageKey));
    expect(bytesToHex(decoded.imageNonce)).toBe(bytesToHex(fixture.imageNonce));
    expect(bytesToHex(decoded.imageUploadKey)).toBe(
      bytesToHex(fixture.imageUploadKey),
    );
  });
});
