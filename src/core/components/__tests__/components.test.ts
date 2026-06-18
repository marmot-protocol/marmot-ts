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
import {
  decodeGroupAvatarUrlV1,
  encodeGroupAvatarUrlV1,
} from "../avatar-url.js";
import {
  decodeEncryptedMediaPolicyV1,
  encodeEncryptedMediaPolicyV1,
  encryptedMediaBlossomDefault,
} from "../encrypted-media.js";
import {
  AGENT_TEXT_STREAM_ROLE_RECEIVE,
  AGENT_TEXT_STREAM_ROLE_SEND,
  decodeAgentTextStreamQuicPolicyV1,
  encodeAgentTextStreamQuicPolicyV1,
} from "../agent-text-stream.js";

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

  it("rejects relay URLs with credentials or a fragment (darkmatter parity)", () => {
    // darkmatter validate_nostr_relay_url rejects these; accepting them would
    // fork commit acceptance.
    expect(() =>
      encodeNostrRoutingV1({
        nostrGroupId: gid,
        relays: ["wss://user@relay.example"],
      }),
    ).toThrow(/credentials/);
    expect(() =>
      encodeNostrRoutingV1({
        nostrGroupId: gid,
        relays: ["wss://relay.example#frag"],
      }),
    ).toThrow(/fragment/);
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

describe("avatar-url.v1 (0x8007)", () => {
  it("encodes the absent avatar as three empty opaque fields", () => {
    expect(hex(encodeGroupAvatarUrlV1({ url: "" }))).toBe("000000");
  });

  it("matches the authoritative vector for a present https url", () => {
    const encoded = encodeGroupAvatarUrlV1({
      url: "https://example.com/a.png",
    });
    expect(hex(encoded)).toBe(
      "19" + "68747470733a2f2f6578616d706c652e636f6d2f612e706e67" + "0000",
    );
  });

  it("round-trips url + hints", () => {
    const avatar = {
      url: "https://example.com/a.png",
      dim: "128x128",
      thumbhash: "deadbeef",
    };
    expect(decodeGroupAvatarUrlV1(encodeGroupAvatarUrlV1(avatar))).toEqual(
      avatar,
    );
  });

  it("rejects hints on an absent avatar", () => {
    expect(() => encodeGroupAvatarUrlV1({ url: "", dim: "1x1" })).toThrow();
  });

  it("rejects non-https and non-routable urls", () => {
    expect(() =>
      encodeGroupAvatarUrlV1({ url: "http://example.com/a.png" }),
    ).toThrow(/https/);
    expect(() =>
      encodeGroupAvatarUrlV1({ url: "https://127.0.0.1/a.png" }),
    ).toThrow(/non-routable/);
    expect(() =>
      encodeGroupAvatarUrlV1({ url: "https://localhost/a.png" }),
    ).toThrow(/localhost/);
  });

  it("decodes a non-UTF-8 hint as absent, not an error (darkmatter parity)", () => {
    // opaque(url="https://e.example/") ++ opaque(dim=[0xff]) ++ opaque(thumbhash="")
    // 0xff is a lone invalid UTF-8 byte; darkmatter treats the hint as absent
    // rather than rejecting otherwise-valid state.
    const bytes = hexToBytes(
      "12" + "68747470733a2f2f652e6578616d706c652f" + "01ff" + "00",
    );
    const decoded = decodeGroupAvatarUrlV1(bytes);
    expect(decoded.url).toBe("https://e.example/");
    expect(decoded.dim).toBeUndefined();
    expect(decoded.thumbhash).toBeUndefined();
  });

  it("still rejects hint bytes on an absent (empty-url) avatar", () => {
    // Presence is decided on the raw bytes: empty url + any hint bytes (even
    // non-UTF-8) is invalid.
    const bytes = hexToBytes("00" + "01ff" + "00");
    expect(() => decodeGroupAvatarUrlV1(bytes)).toThrow(/absent state/);
  });
});

describe("encrypted-media.v1 (0x8008)", () => {
  it("matches the darkmatter authoritative byte vector (#171 layout, no per-item wrapper)", () => {
    // Cross-impl vector copied from darkmatter
    // crates/traits/src/app_components/tests.rs
    // (encrypted_media_policy_encodes_endpoints_without_per_item_wrapper):
    //   media_format           = "encrypted-media-v1"
    //   allowed_locator_kinds  = ["blossom-v1"]
    //   default_blob_endpoints = [{ "blossom-v1", "https://blossom.primal.net/" }]
    // Note: input lacks the trailing slash; WHATWG serialization adds it and it
    // is kept (never stripped), and each endpoint is bare {kind,url} with no
    // per-item length wrapper.
    const policy = encryptedMediaBlossomDefault(["https://blossom.primal.net"]);
    expect(hex(encodeEncryptedMediaPolicyV1(policy))).toBe(
      "12656e637279707465642d6d656469612d7631" +
        "0b0a626c6f73736f6d2d7631" +
        "270a626c6f73736f6d2d76311b68747470733a2f2f626c6f73736f6d2e7072696d616c2e6e65742f",
    );
  });

  it("round-trips and dedups endpoints, keeping the WHATWG trailing slash", () => {
    const policy = encryptedMediaBlossomDefault([
      "https://blobs.example.com",
      "https://blobs.example.com/",
    ]);
    const decoded = decodeEncryptedMediaPolicyV1(
      encodeEncryptedMediaPolicyV1(policy),
    );
    expect(decoded.mediaFormat).toBe("encrypted-media-v1");
    expect(decoded.allowedLocatorKinds).toEqual(["blossom-v1"]);
    expect(decoded.defaultBlobEndpoints).toEqual([
      { locatorKind: "blossom-v1", baseUrl: "https://blobs.example.com/" },
    ]);
  });

  it("accepts a query-bearing endpoint URL (darkmatter #374)", () => {
    const policy = encryptedMediaBlossomDefault([
      "https://blossom.example/?x=1",
    ]);
    const decoded = decodeEncryptedMediaPolicyV1(
      encodeEncryptedMediaPolicyV1(policy),
    );
    expect(decoded.defaultBlobEndpoints).toEqual([
      { locatorKind: "blossom-v1", baseUrl: "https://blossom.example/?x=1" },
    ]);
  });

  it("strictly rejects non-canonical stored bytes (no repair)", () => {
    // Canonical encoding: media_format(19) ++ 0x0b ++ 0x0a ++ "blossom-v1"...
    // Index 21 is the first byte of the allowed locator kind ("b" = 0x62).
    const bytes = encodeEncryptedMediaPolicyV1(
      encryptedMediaBlossomDefault(["https://blobs.example.com"]),
    );
    expect(bytes[21]).toBe(0x62);
    // Uppercase it to "Blossom-v1": structurally valid, but non-canonical. A
    // conformant strict decoder rejects it rather than case-folding to repair.
    const corrupted = Uint8Array.from(bytes);
    corrupted[21] = 0x42; // 'B'
    expect(() => decodeEncryptedMediaPolicyV1(corrupted)).toThrow(
      /lowercase ASCII/,
    );
  });

  it("rejects an unknown media format", () => {
    expect(() =>
      encodeEncryptedMediaPolicyV1({
        mediaFormat: "bogus",
        allowedLocatorKinds: ["blossom-v1"],
        defaultBlobEndpoints: [
          { locatorKind: "blossom-v1", baseUrl: "https://blobs.example.com" },
        ],
      }),
    ).toThrow(/format/);
  });

  it("rejects an endpoint whose locator kind is not allowed", () => {
    expect(() =>
      encodeEncryptedMediaPolicyV1({
        mediaFormat: "encrypted-media-v1",
        allowedLocatorKinds: ["blossom-v1"],
        defaultBlobEndpoints: [
          { locatorKind: "ipfs-v1", baseUrl: "https://blobs.example.com" },
        ],
      }),
    ).toThrow(/not allowed/);
  });
});

describe("agent-text-stream.quic.v1 (0x8006)", () => {
  const userToAgentDefault = {
    requiredMemberRoles: AGENT_TEXT_STREAM_ROLE_RECEIVE,
    allowedMemberRoles:
      AGENT_TEXT_STREAM_ROLE_RECEIVE | AGENT_TEXT_STREAM_ROLE_SEND,
    maxPlaintextFrameLen: 4096,
    replayTtlSecs: 0,
    paddingBucketBytes: 0,
  };

  it("matches the authoritative 12-byte vector for the user→agent default", () => {
    expect(hex(encodeAgentTextStreamQuicPolicyV1(userToAgentDefault))).toBe(
      "010300001000000000000000",
    );
  });

  it("round-trips a fully-populated policy", () => {
    const policy = {
      requiredMemberRoles: 0x01,
      allowedMemberRoles: 0x07,
      // 65519 is the darkmatter max (one QUIC datagram); 65536 would be rejected.
      maxPlaintextFrameLen: 65519,
      replayTtlSecs: 300,
      paddingBucketBytes: 4096,
    };
    expect(
      decodeAgentTextStreamQuicPolicyV1(
        encodeAgentTextStreamQuicPolicyV1(policy),
      ),
    ).toEqual(policy);
  });

  it("rejects empty required roles and a required-not-subset-of-allowed mask", () => {
    expect(() =>
      encodeAgentTextStreamQuicPolicyV1({
        ...userToAgentDefault,
        requiredMemberRoles: 0,
      }),
    ).toThrow(/empty/);
    expect(() =>
      encodeAgentTextStreamQuicPolicyV1({
        ...userToAgentDefault,
        requiredMemberRoles: AGENT_TEXT_STREAM_ROLE_SEND,
        allowedMemberRoles: AGENT_TEXT_STREAM_ROLE_RECEIVE,
      }),
    ).toThrow(/subset/);
  });

  it("rejects a wrong-length payload", () => {
    expect(() => decodeAgentTextStreamQuicPolicyV1(hexToBytes("0103"))).toThrow(
      /12 bytes/,
    );
  });
});
