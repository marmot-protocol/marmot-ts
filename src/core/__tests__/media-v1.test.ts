import { expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  encryptMediaFileV1,
  decryptMediaFileV1,
  encodeMediaImetaTagV1,
  parseHistoricalMediaImetaTag,
  parseMediaImetaTag,
  type MediaAttachmentV1,
} from "../media.js";

it("preserves frozen v1 historical interpretation with explicit dispatch", () => {
  const file = Uint8Array.of(1, 2, 3);
  const key = new Uint8Array(32).fill(2);
  const { encrypted, attachment } = encryptMediaFileV1(file, key, {
    filename: "old.bin",
    mediaType: "application/octet-stream",
    plaintextSha256: bytesToHex(sha256(file)),
  });
  attachment.locators.push({
    kind: "blossom-v1",
    value: "https://example.com/blob",
  });
  const tag = encodeMediaImetaTagV1(attachment);
  const historical = parseHistoricalMediaImetaTag(tag);
  expect(historical?.version).toBe("encrypted-media-v1");
  expect(
    decryptMediaFileV1(encrypted, key, historical as MediaAttachmentV1),
  ).toEqual(file);
  expect(parseMediaImetaTag(tag)).toBeNull();
  expect(
    parseHistoricalMediaImetaTag([...tag, "v encrypted-media-v2"]),
  ).toBeNull();
});
