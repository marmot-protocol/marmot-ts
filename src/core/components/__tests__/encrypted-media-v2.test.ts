import { describe, expect, it } from "vitest";
import { BinaryWriter, encodeUtf8 } from "../../binary.js";
import {
  encodeEncryptedMediaPolicyV2,
  decodeEncryptedMediaPolicyV2,
  encryptedMediaBlossomDefault,
} from "../encrypted-media-v2.js";
import { decodeEncryptedMediaPolicyV1 } from "../encrypted-media.js";

describe("v2 media policy", () => {
  it("preserves priority and admits structurally valid destinations independently of contact policy", () => {
    const policy = encryptedMediaBlossomDefault([
      "http://192.168.1.1/blobs",
      "https://EXAMPLE.com:443/",
    ]);
    expect(
      decodeEncryptedMediaPolicyV2(encodeEncryptedMediaPolicyV2(policy)),
    ).toEqual(policy);
    expect(policy.defaultBlobEndpoints.map((e) => e.baseUrl)).toEqual([
      "http://192.168.1.1/blobs",
      "https://example.com/",
    ]);
    expect(() =>
      decodeEncryptedMediaPolicyV1(encodeEncryptedMediaPolicyV2(policy)),
    ).toThrow();
  });
  it.each([
    "https://user@example.com/",
    "https://example.com/?",
    "https://example.com/#",
    "file:///tmp/x",
  ])("rejects invalid endpoint %s", (endpoint) => {
    expect(() => encryptedMediaBlossomDefault([endpoint])).toThrow();
  });
  it("rejects signed noncanonical bytes rather than repairing them", () => {
    const allowed = new BinaryWriter().opaque(encodeUtf8("blossom-v1")).build();
    for (const endpoint of ["https://EXAMPLE.com/", "https://example.com/?x"]) {
      const endpoints = new BinaryWriter()
        .opaque(encodeUtf8("blossom-v1"))
        .opaque(encodeUtf8(endpoint))
        .build();
      const bytes = new BinaryWriter()
        .opaque(encodeUtf8("encrypted-media-v2"))
        .opaque(allowed)
        .opaque(endpoints)
        .build();
      expect(() => decodeEncryptedMediaPolicyV2(bytes)).toThrow();
    }
  });
});

it("rejects a UTF-8 BOM that would disappear during decode/re-encode", () => {
  const policy = encryptedMediaBlossomDefault(["https://example.com/media"]);
  const allowed = new BinaryWriter().opaque(encodeUtf8("blossom-v1")).build();
  const endpoints = new BinaryWriter()
    .opaque(encodeUtf8("blossom-v1"))
    .opaque(encodeUtf8(policy.defaultBlobEndpoints[0].baseUrl))
    .build();
  const bytes = new BinaryWriter()
    .opaque(encodeUtf8("\ufeffencrypted-media-v2"))
    .opaque(allowed)
    .opaque(endpoints)
    .build();
  expect(() => decodeEncryptedMediaPolicyV2(bytes)).toThrow(/canonical/);
});
