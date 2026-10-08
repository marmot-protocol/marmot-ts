/**
 * An empty fragment ("…/#") is still a fragment. WHATWG `URL.hash` returns ""
 * for it, exactly as for a URL with no fragment, while the Rust `url` crate MDK
 * uses returns `Some("")` and MDK rejects the URL. These tests pin the MDK
 * behavior for every component URL validator that forbids fragments.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { BinaryWriter, encodeUtf8 } from "../../binary.js";
import {
  decodeGroupAvatarUrlV1,
  encodeGroupAvatarUrlV1,
} from "../avatar-url.js";
import {
  decodeEncryptedMediaPolicyV1,
  encodeEncryptedMediaPolicyV1,
} from "../encrypted-media.js";
import {
  decodeNostrRoutingV1,
  encodeNostrRoutingV1,
} from "../nostr-routing.js";

describe("URLs with an empty fragment", () => {
  it("avatar-url: rejected on encode and on decode", () => {
    expect(() =>
      encodeGroupAvatarUrlV1({ url: "https://example.com/a.png#" }),
    ).toThrow(/fragment/);
    // Bytes master produced for "https://example.com/a.png#". MDK's
    // decode_group_avatar_url_v1 rejects them: "group avatar URL must not
    // include a fragment".
    expect(() =>
      decodeGroupAvatarUrlV1(
        hexToBytes(
          "1a68747470733a2f2f6578616d706c652e636f6d2f612e706e67230000",
        ),
      ),
    ).toThrow(/fragment/);
  });

  it("nostr-routing: rejected on encode and on decode", () => {
    expect(() =>
      encodeNostrRoutingV1({
        nostrGroupId: new Uint8Array(32),
        relays: ["wss://relay.example/#"],
      }),
    ).toThrow(/fragment/);
    const raw = new BinaryWriter()
      .bytes(new Uint8Array(32))
      .vector([
        new BinaryWriter().opaque(encodeUtf8("wss://relay.example/#")).build(),
      ])
      .build();
    expect(() => decodeNostrRoutingV1(raw)).toThrow(/fragment/);
  });

  it("encrypted-media v1 endpoint: rejected", () => {
    expect(() =>
      encodeEncryptedMediaPolicyV1({
        mediaFormat: "encrypted-media-v1",
        allowedLocatorKinds: ["blossom-v1"],
        defaultBlobEndpoints: [
          { locatorKind: "blossom-v1", baseUrl: "https://blossom.example/#" },
        ],
      }),
    ).toThrow(/fragment/);
    const endpoint = new BinaryWriter()
      .opaque(encodeUtf8("blossom-v1"))
      .opaque(encodeUtf8("https://blossom.example/#"))
      .build();
    const raw = new BinaryWriter()
      .opaque(encodeUtf8("encrypted-media-v1"))
      .vector([new BinaryWriter().opaque(encodeUtf8("blossom-v1")).build()])
      .vector([endpoint])
      .build();
    expect(() => decodeEncryptedMediaPolicyV1(raw)).toThrow(/fragment/);
  });

  it("URLs without a fragment are unaffected", () => {
    expect(
      decodeGroupAvatarUrlV1(
        encodeGroupAvatarUrlV1({ url: "https://example.com/a.png?x=1" }),
      ).url,
    ).toBe("https://example.com/a.png?x=1");
    expect(
      decodeNostrRoutingV1(
        encodeNostrRoutingV1({
          nostrGroupId: new Uint8Array(32),
          relays: ["wss://relay.example/path?q=1"],
        }),
      ).relays,
    ).toEqual(["wss://relay.example/path?q=1"]);
  });
});
