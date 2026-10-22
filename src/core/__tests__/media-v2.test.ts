import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  canonicalizeMimeType,
  encryptMediaFile,
  decryptMediaFile,
  encodeMediaImetaTag,
  parseMediaImetaTag,
  getMediaAttachments,
  ENCRYPTED_MEDIA_VERSION,
  ENCRYPTED_MEDIA_VERSION_V1,
  parseMediaImetaTagV1,
  buildFallbackFetchUrls,
} from "../media.js";
import { encryptedMediaBlossomDefault } from "../components/encrypted-media-v2.js";

const plaintext = new TextEncoder().encode("attachment contents");
const key = new Uint8Array(32).fill(9);
const fields = {
  plaintextSha256: bytesToHex(sha256(plaintext)),
  mediaType: "image/jpeg",
  filename: "café.png",
};
function sample() {
  const result = encryptMediaFile(plaintext, key, fields);
  result.attachment.locators.push({
    kind: "blossom-v1",
    value: "http://localhost:1234/custom?blob=1",
  });
  return result;
}

describe("encrypted-media-v2", () => {
  it("uses the new version and independent random nonces", () => {
    const a = sample(),
      b = sample();
    expect(a.attachment.version).toBe("encrypted-media-v2");
    expect(ENCRYPTED_MEDIA_VERSION).not.toBe(ENCRYPTED_MEDIA_VERSION_V1);
    expect(a.attachment.nonce).not.toBe(b.attachment.nonce);
    expect(decryptMediaFile(a.encrypted, key, a.attachment)).toEqual(plaintext);
    expect(parseMediaImetaTagV1(encodeMediaImetaTag(a.attachment))).toBeNull();
  });

  it.each([
    "text/plain/extra",
    "text/💩",
    "text/a b",
    "\vtext/plain",
    "\u00a0text/plain",
    "a".repeat(65) + "/b",
  ])("rejects MIME outside the v2 token profile: %s", (value) => {
    expect(() => canonicalizeMimeType(value)).toThrow();
  });

  it("normalizes producer MIME but requires exact receiver bytes", () => {
    expect(canonicalizeMimeType(" \tIMAGE/JPG ; charset=x")).toBe("image/jpeg");
    const tag = encodeMediaImetaTag(sample().attachment);
    expect(parseMediaImetaTag(tag)?.locators[0].value).toBe(
      "http://localhost:1234/custom?blob=1",
    );
    expect(
      parseMediaImetaTag(
        tag.map((x) => (x === "m image/jpeg" ? "m IMAGE/JPG" : x)),
      ),
    ).toBeNull();
  });

  it.each(["", "\0bad", "\ud800", "é".repeat(128)])(
    "rejects invalid filename %j",
    (filename) => {
      expect(() =>
        encryptMediaFile(plaintext, key, { ...fields, filename }),
      ).toThrow();
    },
  );

  it("rejects tampering without falling back to v1", () => {
    const { encrypted, attachment } = sample();
    for (const changed of [
      { ...attachment, filename: "other" },
      { ...attachment, mediaType: "image/png" },
      { ...attachment, plaintextSha256: "ab".repeat(32) },
      { ...attachment, nonce: "00".repeat(12) },
      { ...attachment, version: ENCRYPTED_MEDIA_VERSION_V1 },
    ]) {
      expect(() =>
        decryptMediaFile(encrypted, key, changed as typeof attachment),
      ).toThrow();
    }
    expect(() =>
      decryptMediaFile(new Uint8Array(encrypted.length), key, attachment),
    ).toThrow();
  });

  it("rejects malformed tags attachment-locally while preserving valid siblings", () => {
    const tag = encodeMediaImetaTag(sample().attachment);
    expect(parseMediaImetaTag([...tag, "filename duplicate"])).toBeNull();
    expect(parseMediaImetaTag([...tag, "blurhash x"])).toBeNull();
    expect(
      getMediaAttachments([["other"], [...tag, "v encrypted-media-v2"], tag]),
    ).toHaveLength(1);
  });

  it("preserves endpoint path segments in fallback URLs", () => {
    const policy = encryptedMediaBlossomDefault([
      "http://localhost:1234/blobs",
    ]);
    const { attachment } = sample();
    expect(buildFallbackFetchUrls(attachment, policy)).toEqual([
      "http://localhost:1234/blobs/" + attachment.ciphertextSha256,
    ]);
  });
});

it("decrypts the independently generated MDK upload fixture and matches its policy bytes", async () => {
  const fixture = (
    await import("../../__tests__/fixtures/media-v2-rust.json", {
      with: { type: "json" },
    })
  ).default;
  const { hexToBytes } = await import("@noble/hashes/utils.js");
  const { deriveMediaFileKey } = await import("../media.js");
  const { encodeEncryptedMediaPolicyV2 } =
    await import("../components/encrypted-media-v2.js");
  const attachment = parseMediaImetaTag(fixture.tag)!;
  expect(attachment).not.toBeNull();
  expect(
    decryptMediaFile(
      hexToBytes(fixture.encrypted),
      deriveMediaFileKey(hexToBytes(fixture.mediaSecret), attachment),
      attachment,
    ),
  ).toEqual(hexToBytes(fixture.plaintext));
  expect(
    bytesToHex(
      encodeEncryptedMediaPolicyV2(
        encryptedMediaBlossomDefault(["https://example.com/media"]),
      ),
    ),
  ).toBe(fixture.policy);
});

it("preserves all valid filename bytes including a leading BOM and decomposed Unicode", () => {
  for (const filename of ["\ufefffile.txt", "e\u0301.txt", "a".repeat(255)]) {
    const result = encryptMediaFile(plaintext, key, { ...fields, filename });
    expect(result.attachment.filename).toBe(filename);
    expect(decryptMediaFile(result.encrypted, key, result.attachment)).toEqual(
      plaintext,
    );
  }
});
