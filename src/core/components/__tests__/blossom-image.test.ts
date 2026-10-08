import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  canonicalizeGroupImageMediaType,
  decodeGroupBlossomImageV1,
  decryptGroupBlossomImage,
  emptyGroupBlossomImageV1,
  encodeGroupBlossomImageV1,
  encryptGroupBlossomImage,
  isGroupBlossomImagePresent,
} from "../blossom-image.js";
import {
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "../ids.js";

const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

// Field values from MDK `blossom_image_codec_canonicalizes_on_encode_and_rejects_non_canonical_decode`
// (crates/traits/src/app_components/tests.rs).
const image = {
  imageHash: fill(32, 1),
  imageKey: fill(32, 2),
  imageNonce: fill(12, 3),
  imageUploadKey: fill(32, 4),
  mediaType: " Image/JPG; charset=utf-8 ",
};
const vec = (len: number, byte: string) =>
  len.toString(16).padStart(2, "0") + byte.repeat(len);
const canonicalHex =
  vec(32, "01") +
  vec(32, "02") +
  vec(12, "03") +
  vec(32, "04") +
  "0a" +
  bytesToHex(new TextEncoder().encode("image/jpeg"));

describe("marmot.group.blossom.image.v1 (0x8002)", () => {
  it("is advertised in the KeyPackage app_components list", () => {
    expect(SUPPORTED_APP_COMPONENT_IDS).toContain(
      GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
    );
  });

  it("canonicalizes the media type on encode (MDK vector)", () => {
    const encoded = encodeGroupBlossomImageV1(image);
    expect(bytesToHex(encoded)).toBe(canonicalHex);
    expect(decodeGroupBlossomImageV1(encoded).mediaType).toBe("image/jpeg");
  });

  it("rejects a non-canonical media type on decode (MDK vector)", () => {
    const nonCanonical =
      canonicalHex.slice(0, -22) +
      "09" +
      bytesToHex(new TextEncoder().encode("image/jpg"));
    expect(() => decodeGroupBlossomImageV1(hexToBytes(nonCanonical))).toThrow(
      "not canonical",
    );
  });

  it("encodes the absent state as five empty vectors, like MDK encode_group_blossom_image_v1", () => {
    const decoded = decodeGroupBlossomImageV1(hexToBytes("0000000000"));
    expect(isGroupBlossomImagePresent(decoded)).toBe(false);
    expect(
      bytesToHex(encodeGroupBlossomImageV1(emptyGroupBlossomImageV1())),
    ).toBe("0000000000");
  });

  it("rejects partial states, oversized fields and trailing bytes", () => {
    // hash only
    expect(() =>
      decodeGroupBlossomImageV1(hexToBytes(vec(32, "01") + "00000000")),
    ).toThrow("partial");
    // 33-byte hash length prefix (MDK rejects before reading the body)
    expect(() => decodeGroupBlossomImageV1(hexToBytes("21"))).toThrow();
    expect(() =>
      decodeGroupBlossomImageV1(hexToBytes(canonicalHex + "00")),
    ).toThrow();
  });

  it("matches MDK's media-type canonicalization boundaries", () => {
    for (const [input, expected] of [
      ["image/png", "image/png"],
      ["\t Image/JPG \r; charset=utf-8", "image/jpeg"],
      ["application/vnd.marmot+json", "application/vnd.marmot+json"],
      ["x!#$%&'*+-.^_`|~/y", "x!#$%&'*+-.^_`|~/y"],
    ])
      expect(canonicalizeGroupImageMediaType(input)).toBe(expected);
    for (const invalid of [
      "image",
      "image/png/extra",
      "/png",
      "image/",
      "image/(png)",
      "image/π",
      "\u000bimage/png",
      `${"a".repeat(65)}/x`,
    ])
      expect(() => canonicalizeGroupImageMediaType(invalid)).toThrow();
  });

  it("encrypts with the spec AAD and decrypts after checking image_hash", () => {
    const plaintext = new TextEncoder().encode("not really a png");
    const { encryptedBlob, image: state } = encryptGroupBlossomImage(
      plaintext,
      "IMAGE/PNG",
    );
    expect(state.mediaType).toBe("image/png");
    expect(state.imageHash).toEqual(sha256(encryptedBlob));
    // AAD = "marmot-group-image-v1" || 0x00 || media_type
    const aad = new TextEncoder().encode("marmot-group-image-v1\0image/png");
    expect(
      chacha20poly1305(state.imageKey, state.imageNonce, aad).decrypt(
        encryptedBlob,
      ),
    ).toEqual(plaintext);
    expect(decryptGroupBlossomImage(encryptedBlob, state)).toEqual(plaintext);
    // round-trips through the component codec
    expect(decodeGroupBlossomImageV1(encodeGroupBlossomImageV1(state))).toEqual(
      state,
    );

    const tampered = encryptedBlob.slice();
    tampered[0] ^= 1;
    expect(() => decryptGroupBlossomImage(tampered, state)).toThrow(
      "image_hash",
    );
  });
});
