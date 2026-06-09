/**
 * Conformance + round-trip tests for the Marmot v2 app-component `data` codecs.
 *
 * The golden hex vectors are computed from the darkmatter Rust encoders
 * (`crates/traits/src/app_components.rs`, `crates/cgka-engine/src/app_components.rs`)
 * — NOT from the repo's stale `byte-fixtures/*.json` (which use TLS fixed-width
 * prefixes and contradict the real QUIC-varint implementation). These lock
 * cross-implementation byte parity.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
} from "../ids.js";
import {
  decodeComponentsList,
  encodeComponentsList,
} from "../app-components-list.js";
import { decodeAdminPolicyV1, encodeAdminPolicyV1 } from "../admin-policy.js";
import {
  decodeGroupProfileV1,
  encodeGroupProfileV1,
} from "../group-profile.js";
import {
  decodeMessageRetentionV1,
  encodeMessageRetentionV1,
} from "../message-retention.js";
import {
  decodeNostrRoutingV1,
  encodeNostrRoutingV1,
} from "../nostr-routing.js";

const hex = (b: Uint8Array) => bytesToHex(b);

describe("app_components list (0x0001)", () => {
  it("matches the authoritative vector for {0x8001,0x8003,0x8004}", () => {
    const encoded = encodeComponentsList([
      GROUP_PROFILE_COMPONENT_ID,
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      NOSTR_ROUTING_COMPONENT_ID,
    ]);
    expect(hex(encoded)).toBe("06800180038004");
  });

  it("sorts ascending and dedups regardless of input order", () => {
    const encoded = encodeComponentsList([0x8004, 0x8001, 0x8003, 0x8004]);
    expect(hex(encoded)).toBe("06800180038004");
    expect(decodeComponentsList(encoded)).toEqual([0x8001, 0x8003, 0x8004]);
  });

  it("rejects a duplicate id on decode", () => {
    // QUIC varint 4 (byte length), then 0x8001 twice.
    expect(() => decodeComponentsList(hexToBytes("0480018001"))).toThrow(
      /duplicate component id/,
    );
  });
});

describe("group.profile.v1 (0x8001)", () => {
  it("matches the authoritative vector (name='a', description='')", () => {
    expect(hex(encodeGroupProfileV1({ name: "a", description: "" }))).toBe(
      "016100",
    );
  });

  it("round-trips multibyte UTF-8 without normalization", () => {
    const profile = { name: "Café 🦫", description: "a group" };
    const decoded = decodeGroupProfileV1(encodeGroupProfileV1(profile));
    expect(decoded).toEqual(profile);
  });

  it("rejects an over-long name on encode", () => {
    expect(() =>
      encodeGroupProfileV1({ name: "x".repeat(257), description: "" }),
    ).toThrow();
  });
});

describe("admin-policy.v1 (0x8003)", () => {
  it("matches the authoritative vector for a single key [0x11; 32]", () => {
    const key = "11".repeat(32);
    expect(hex(encodeAdminPolicyV1([key]))).toBe("20" + "11".repeat(32));
  });

  it("sorts and dedups admin keys", () => {
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);
    const encoded = encodeAdminPolicyV1([b, a, b]);
    expect(decodeAdminPolicyV1(encoded)).toEqual([a, b]);
  });

  it("rejects an empty admin set", () => {
    expect(() => encodeAdminPolicyV1([])).toThrow();
  });

  it("rejects an unsorted payload on decode", () => {
    const b = "bb".repeat(32);
    const a = "aa".repeat(32);
    const unsorted = hexToBytes("4040" + b + a); // QUIC varint 0x4040 = 64 = two 32-byte keys
    expect(() => decodeAdminPolicyV1(unsorted)).toThrow(/sorted/);
  });
});

describe("nostr.routing.v1 (0x8004)", () => {
  const gid = new Uint8Array(32);
  for (let i = 0; i < 32; i++) gid[i] = i;
  const relays = ["wss://relay-a.example", "wss://relay-b.example"];

  it("matches the authoritative 77-byte vector", () => {
    const encoded = encodeNostrRoutingV1({ nostrGroupId: gid, relays });
    expect(hex(encoded)).toBe(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
        "2c" +
        "157773733a2f2f72656c61792d612e6578616d706c65" +
        "157773733a2f2f72656c61792d622e6578616d706c65",
    );
  });

  it("round-trips and re-sorts relays given out of order", () => {
    const decoded = decodeNostrRoutingV1(
      encodeNostrRoutingV1({
        nostrGroupId: gid,
        relays: [relays[1], relays[0]],
      }),
    );
    expect(decoded.relays).toEqual(relays);
    expect(hex(decoded.nostrGroupId)).toBe(hex(gid));
  });

  it("rejects an empty relay set", () => {
    expect(() =>
      encodeNostrRoutingV1({ nostrGroupId: gid, relays: [] }),
    ).toThrow();
  });

  it("rejects a wrong-size group id", () => {
    expect(() =>
      encodeNostrRoutingV1({ nostrGroupId: new Uint8Array(16), relays }),
    ).toThrow(/32 bytes/);
  });
});

describe("message-retention.v1 (0x8005)", () => {
  it("matches the authoritative vector for 0 (disabled)", () => {
    expect(hex(encodeMessageRetentionV1(0))).toBe("0000000000000000");
  });

  it("round-trips a non-zero timer as a u64", () => {
    const encoded = encodeMessageRetentionV1(86400n);
    expect(decodeMessageRetentionV1(encoded)).toBe(86400n);
  });

  it("rejects trailing bytes", () => {
    expect(() =>
      decodeMessageRetentionV1(hexToBytes("000000000000000000")),
    ).toThrow();
  });
});
