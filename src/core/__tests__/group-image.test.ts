import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import {
  expand as hkdf_expand,
  extract as hkdf_extract,
} from "@noble/hashes/hkdf.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decryptGroupImage,
  deriveGroupImageBlossomAuthKeypair,
  encryptGroupImage,
  uploadGroupImage,
} from "../group-image.js";

const enc = new TextEncoder();
const MIP01_IMAGE_ENCRYPTION_LABEL = enc.encode("mip01-image-encryption-v2");
const MIP01_BLOSSOM_LABEL = enc.encode("mip01-blossom-upload-v2");

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// encryptGroupImage
// ---------------------------------------------------------------------------

describe("encryptGroupImage", () => {
  it("returns encrypted bytes and metadata with imageKey, imageNonce, imageHash, imageUploadKey", () => {
    const image = randomBytes(256);
    const result = encryptGroupImage(image);
    const { metadata } = result;

    expect(result.encrypted).toBeInstanceOf(Uint8Array);
    expect(metadata.imageKey).toBeInstanceOf(Uint8Array);
    expect(metadata.imageNonce).toBeInstanceOf(Uint8Array);
    expect(metadata.imageHash).toBeInstanceOf(Uint8Array);
    expect(metadata.imageUploadKey).toBeInstanceOf(Uint8Array);

    expect(metadata.imageKey.length).toBe(32);
    expect(metadata.imageNonce.length).toBe(12);
    expect(metadata.imageHash.length).toBe(32);
    expect(metadata.imageUploadKey.length).toBe(32);
  });

  it("imageHash is SHA-256 of the encrypted blob", () => {
    const image = randomBytes(128);
    const {
      encrypted,
      metadata: { imageHash },
    } = encryptGroupImage(image);
    expect(imageHash).toEqual(sha256(encrypted));
  });

  it("derives the encryption key from imageKey using HKDF-SHA256", () => {
    const image = randomBytes(128);
    const {
      encrypted,
      metadata: { imageKey, imageNonce },
    } = encryptGroupImage(image);
    const prk = hkdf_extract(sha256, imageKey, new Uint8Array(0));
    const encryptionKey = hkdf_expand(
      sha256,
      prk,
      MIP01_IMAGE_ENCRYPTION_LABEL,
      32,
    );

    expect(encrypted).toEqual(
      chacha20poly1305(encryptionKey, imageNonce).encrypt(image),
    );
  });

  it("generates imageUploadKey independently from imageKey", () => {
    const {
      metadata: { imageKey, imageUploadKey },
    } = encryptGroupImage(randomBytes(64));
    expect(bytesToHex(imageUploadKey)).not.toBe(bytesToHex(imageKey));
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

    expect(bytesToHex(a.metadata.imageKey)).not.toBe(
      bytesToHex(b.metadata.imageKey),
    );
    expect(bytesToHex(a.metadata.imageNonce)).not.toBe(
      bytesToHex(b.metadata.imageNonce),
    );
    expect(bytesToHex(a.metadata.imageUploadKey)).not.toBe(
      bytesToHex(b.metadata.imageUploadKey),
    );
  });
});

// ---------------------------------------------------------------------------
// decryptGroupImage
// ---------------------------------------------------------------------------

describe("decryptGroupImage", () => {
  it("round-trips correctly", () => {
    const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { encrypted, metadata } = encryptGroupImage(image);
    const decrypted = decryptGroupImage(encrypted, metadata);
    expect(decrypted).toEqual(image);
  });

  it("round-trips with larger image data", () => {
    const image = randomBytes(4096);
    const { encrypted, metadata } = encryptGroupImage(image);
    const decrypted = decryptGroupImage(encrypted, metadata);
    expect(decrypted).toEqual(image);
  });

  it("throws when ciphertext is tampered", () => {
    const image = randomBytes(64);
    const { encrypted, metadata } = encryptGroupImage(image);
    encrypted[0] ^= 0xff;
    expect(() => decryptGroupImage(encrypted, metadata)).toThrow();
  });

  it("throws when key is wrong", () => {
    const image = randomBytes(64);
    const { encrypted, metadata } = encryptGroupImage(image);
    expect(() =>
      decryptGroupImage(encrypted, {
        ...metadata,
        imageKey: randomBytes(32),
      }),
    ).toThrow();
  });

  it("throws when nonce is wrong", () => {
    const image = randomBytes(64);
    const { encrypted, metadata } = encryptGroupImage(image);
    expect(() =>
      decryptGroupImage(encrypted, {
        ...metadata,
        imageNonce: randomBytes(12),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// deriveGroupImageBlossomAuthKeypair
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

  it("is deterministic — same imageUploadKey yields same keypair", () => {
    const imageUploadKey = randomBytes(32);
    const a = deriveGroupImageBlossomAuthKeypair(imageUploadKey);
    const b = deriveGroupImageBlossomAuthKeypair(imageUploadKey);

    expect(bytesToHex(a.secretKey)).toBe(bytesToHex(b.secretKey));
    expect(a.pubkey).toBe(b.pubkey);
  });

  it("derives the upload secret from imageUploadKey using HKDF-SHA256", () => {
    const imageUploadKey = randomBytes(32);
    const { secretKey } = deriveGroupImageBlossomAuthKeypair(imageUploadKey);
    const prk = hkdf_extract(sha256, imageUploadKey, new Uint8Array(0));
    const expectedSecretKey = hkdf_expand(sha256, prk, MIP01_BLOSSOM_LABEL, 32);

    expect(bytesToHex(secretKey)).toBe(bytesToHex(expectedSecretKey));
  });

  it("matches the upload seed stored by encryptGroupImage", () => {
    const {
      metadata: { imageUploadKey },
    } = encryptGroupImage(randomBytes(64));
    const { secretKey } = deriveGroupImageBlossomAuthKeypair(imageUploadKey);
    const prk = hkdf_extract(sha256, imageUploadKey, new Uint8Array(0));
    const expectedSecretKey = hkdf_expand(sha256, prk, MIP01_BLOSSOM_LABEL, 32);

    expect(bytesToHex(secretKey)).toBe(bytesToHex(expectedSecretKey));
  });

  it("different imageUploadKeys yield different keypairs (domain separation)", () => {
    const a = deriveGroupImageBlossomAuthKeypair(randomBytes(32));
    const b = deriveGroupImageBlossomAuthKeypair(randomBytes(32));
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});

describe("uploadGroupImage", () => {
  it("throws when servers is empty", async () => {
    await expect(
      uploadGroupImage({
        imageData: randomBytes(16),
        servers: [],
        fetchImplementation: vi.fn(),
      }),
    ).rejects.toThrow("uploadGroupImage requires at least one Blossom server");
  });

  it("uploads the same encrypted blob to all servers with one shared auth event", async () => {
    const image = randomBytes(64);
    const authHeaders: string[] = [];

    const result = await uploadGroupImage({
      imageData: image,
      servers: ["https://cdn.example.com", "https://media.example.net"],
      fetchImplementation: vi.fn(async (input, init) => {
        const url = String(input);
        const sha256Hex = init?.headers
          ? new Headers(init.headers).get("x-sha-256")
          : null;
        const authorization = init?.headers
          ? new Headers(init.headers).get("authorization")
          : null;

        if (!sha256Hex || !authorization) {
          throw new Error("missing upload headers");
        }

        authHeaders.push(authorization);

        expect(url).toMatch(/\/upload$/);

        return new Response(
          JSON.stringify({
            url: `${new URL(url).origin}/${sha256Hex}.png`,
            sha256: sha256Hex,
            size: init?.body instanceof ArrayBuffer ? init.body.byteLength : 0,
            type: "image/png",
            uploaded: 1725105921,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });

    expect(result.uploads).toHaveLength(2);
    expect(result.uploads.every((u) => u.status === "fulfilled")).toBe(true);

    const descriptors = result.uploads.map(
      (u) =>
        (u as PromiseFulfilledResult<{ descriptor: { sha256: string } }>).value
          .descriptor,
    );

    expect(authHeaders).toHaveLength(2);
    expect(authHeaders[0]).toBe(authHeaders[1]);

    const encodedEvent = authHeaders[0].slice("Nostr ".length);
    const authEvent = JSON.parse(
      Buffer.from(encodedEvent, "base64url").toString("utf8"),
    );
    const imageHashHex = bytesToHex(result.metadata.imageHash);
    const blossomKeypair = deriveGroupImageBlossomAuthKeypair(
      result.metadata.imageUploadKey,
    );

    expect(authEvent.kind).toBe(24242);
    expect(authEvent.pubkey).toBe(blossomKeypair.pubkey);
    expect(authEvent.tags).toContainEqual(["t", "upload"]);
    expect(authEvent.tags).toContainEqual(["x", imageHashHex]);
    expect(
      authEvent.tags.some(
        (t: string[]) => t[0] === "expiration" && typeof t[1] === "string",
      ),
    ).toBe(true);

    expect(descriptors.map((descriptor) => descriptor.sha256)).toEqual([
      imageHashHex,
      imageHashHex,
    ]);
    expect(
      decryptGroupImage(result.encrypted, {
        imageKey: result.metadata.imageKey,
        imageNonce: result.metadata.imageNonce,
      }),
    ).toEqual(image);
  });

  it("records rejection when any upload server rejects the blob", async () => {
    const image = randomBytes(32);

    const result = await uploadGroupImage({
      imageData: image,
      servers: ["https://ok.example.com", "https://fail.example.com"],
      fetchImplementation: vi.fn(async (input, init) => {
        const url = String(input);
        if (url.includes("fail.example.com")) {
          return new Response("forbidden", { status: 403 });
        }

        const sha256Hex = init?.headers
          ? new Headers(init.headers).get("x-sha-256")
          : null;

        return new Response(
          JSON.stringify({
            url: `${new URL(url).origin}/${sha256Hex}.bin`,
            sha256: sha256Hex,
            size: init?.body instanceof ArrayBuffer ? init.body.byteLength : 0,
            type: "application/octet-stream",
            uploaded: 1725105921,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    });

    expect(result.uploads).toHaveLength(2);

    const ok = result.uploads.find((u) => u.status === "fulfilled");
    const failed = result.uploads.find((u) => u.status === "rejected");

    expect(ok?.status).toBe("fulfilled");
    expect(failed?.status).toBe("rejected");
    expect(String((failed as PromiseRejectedResult).reason.message)).toContain(
      "Failed to upload group image to https://fail.example.com/",
    );
    expect(String((failed as PromiseRejectedResult).reason.message)).toContain(
      ": 403",
    );
  });

  it("records rejection when Blossom returns a mismatched sha256", async () => {
    const image = randomBytes(24);

    const result = await uploadGroupImage({
      imageData: image,
      servers: ["https://cdn.example.com"],
      fetchImplementation: vi.fn(async (_input, init) => {
        return new Response(
          JSON.stringify({
            url: "https://cdn.example.com/wrong",
            sha256: "00".repeat(32),
            size: init?.body instanceof ArrayBuffer ? init.body.byteLength : 0,
            type: "application/octet-stream",
            uploaded: 1725105921,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }),
    });

    expect(result.uploads).toHaveLength(1);
    expect(result.uploads[0]?.status).toBe("rejected");
    expect(
      String((result.uploads[0] as PromiseRejectedResult).reason.message),
    ).toContain("mismatched sha256");
  });
});
