import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  decryptGroupImage,
  deriveGroupImageBlossomAuthKeypair,
  encryptGroupImage,
} from "../group-image.js";

// ---------------------------------------------------------------------------
// encryptGroupImage
// ---------------------------------------------------------------------------

describe("encryptGroupImage", () => {
  it("returns encrypted bytes, imageKey, imageNonce, imageHash, imageUploadKey", () => {
    const image = randomBytes(256);
    const result = encryptGroupImage(image);

    expect(result.encrypted).toBeInstanceOf(Uint8Array);
    expect(result.imageKey).toBeInstanceOf(Uint8Array);
    expect(result.imageNonce).toBeInstanceOf(Uint8Array);
    expect(result.imageHash).toBeInstanceOf(Uint8Array);
    expect(result.imageUploadKey).toBeInstanceOf(Uint8Array);

    expect(result.imageKey.length).toBe(32);
    expect(result.imageNonce.length).toBe(12);
    expect(result.imageHash.length).toBe(32);
    expect(result.imageUploadKey.length).toBe(32);
  });

  it("imageHash is SHA-256 of the encrypted blob", () => {
    const image = randomBytes(128);
    const { encrypted, imageHash } = encryptGroupImage(image);
    expect(imageHash).toEqual(sha256(encrypted));
  });

  it("encrypted bytes are longer than plaintext (Poly1305 tag adds 16 bytes)", () => {
    const image = randomBytes(128);
    const { encrypted } = encryptGroupImage(image);
    expect(encrypted.length).toBe(image.length + 16);
  });

  it("two calls produce different keys and nonces (randomness)", () => {
    const image = randomBytes(64);
    const a = encryptGroupImage(image);
    const b = encryptGroupImage(image);

    expect(bytesToHex(a.imageKey)).not.toBe(bytesToHex(b.imageKey));
    expect(bytesToHex(a.imageNonce)).not.toBe(bytesToHex(b.imageNonce));
  });
});

// ---------------------------------------------------------------------------
// decryptGroupImage
// ---------------------------------------------------------------------------

describe("decryptGroupImage", () => {
  it("round-trips correctly", () => {
    const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { encrypted, imageKey, imageNonce } = encryptGroupImage(image);
    const decrypted = decryptGroupImage(encrypted, imageKey, imageNonce);
    expect(decrypted).toEqual(image);
  });

  it("round-trips with larger image data", () => {
    const image = randomBytes(4096);
    const { encrypted, imageKey, imageNonce } = encryptGroupImage(image);
    const decrypted = decryptGroupImage(encrypted, imageKey, imageNonce);
    expect(decrypted).toEqual(image);
  });

  it("throws when ciphertext is tampered", () => {
    const image = randomBytes(64);
    const { encrypted, imageKey, imageNonce } = encryptGroupImage(image);
    encrypted[0] ^= 0xff;
    expect(() => decryptGroupImage(encrypted, imageKey, imageNonce)).toThrow();
  });

  it("throws when key is wrong", () => {
    const image = randomBytes(64);
    const { encrypted, imageNonce } = encryptGroupImage(image);
    expect(() =>
      decryptGroupImage(encrypted, randomBytes(32), imageNonce),
    ).toThrow();
  });

  it("throws when nonce is wrong", () => {
    const image = randomBytes(64);
    const { encrypted, imageKey } = encryptGroupImage(image);
    expect(() =>
      decryptGroupImage(encrypted, imageKey, randomBytes(12)),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveImageUploadKeypair
// ---------------------------------------------------------------------------

describe("deriveGroupImageBlossomAuthKeypair", () => {
  it("returns secretKey (32 bytes) and pubkey (64 hex chars)", () => {
    const { secretKey, pubkey } = deriveGroupImageBlossomAuthKeypair(
      randomBytes(32),
    );

    expect(secretKey).toBeInstanceOf(Uint8Array);
    expect(secretKey.length).toBe(32);
    expect(typeof pubkey).toBe("string");
    expect(pubkey.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(pubkey)).toBe(true);
  });

  it("is deterministic — same imageKey yields same keypair", () => {
    const imageKey = randomBytes(32);
    const a = deriveGroupImageBlossomAuthKeypair(imageKey);
    const b = deriveGroupImageBlossomAuthKeypair(imageKey);

    expect(bytesToHex(a.secretKey)).toBe(bytesToHex(b.secretKey));
    expect(a.pubkey).toBe(b.pubkey);
  });

  it("matches the imageUploadKey stored by encryptGroupImage", () => {
    const { imageKey, imageUploadKey } = encryptGroupImage(randomBytes(64));
    const { secretKey } = deriveGroupImageBlossomAuthKeypair(imageKey);
    expect(bytesToHex(secretKey)).toBe(bytesToHex(imageUploadKey));
  });

  it("different imageKeys yield different keypairs (domain separation)", () => {
    const a = deriveGroupImageBlossomAuthKeypair(randomBytes(32));
    const b = deriveGroupImageBlossomAuthKeypair(randomBytes(32));
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});
