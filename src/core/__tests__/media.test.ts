import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import type { NostrEvent } from "applesauce-core/helpers";
import { describe, expect, it, vi } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupMediaStore } from "../../client/group/group-media-store.js";
import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { createSimpleGroup } from "../group.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { GroupStateStore } from "../../store/group-state-store.js";
import { KeyValueGroupStateBackend } from "../../store/adapters/key-value-group-state-backend.js";
import {
  canonicalizeMimeType,
  decryptMediaFile,
  deriveMediaEncryptionKey,
  encryptMediaFile,
  getMediaAttachmentFromFileEvent,
  getMediaAttachments,
  MIP04_VERSION,
  parseMediaImetaTag,
  type MediaAttachment,
} from "../media.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeClientState() {
  const adminPubkey = "a".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const credential = createCredential(adminPubkey);
  const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
  const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
    adminPubkeys: [adminPubkey],
    relays: [],
  });
  return { clientState, ciphersuite: impl };
}

/** Build a minimal valid MediaAttachment for a given file. */
function makeAttachment(
  file: Uint8Array,
  mimeType = "image/jpeg",
  filename = "photo.jpg",
): MediaAttachment {
  return {
    sha256: bytesToHex(sha256(file)),
    type: mimeType,
    filename,
    nonce: "",
    version: MIP04_VERSION,
  };
}

// ---------------------------------------------------------------------------
// canonicalizeMimeType
// ---------------------------------------------------------------------------

describe("canonicalizeMimeType", () => {
  it("lowercases the type", () => {
    expect(canonicalizeMimeType("IMAGE/JPEG")).toBe("image/jpeg");
  });

  it("trims whitespace", () => {
    expect(canonicalizeMimeType("  image/jpeg  ")).toBe("image/jpeg");
  });

  it("strips parameters", () => {
    expect(canonicalizeMimeType("image/jpeg; charset=utf-8")).toBe(
      "image/jpeg",
    );
  });

  it("handles combined cases", () => {
    expect(canonicalizeMimeType("  TEXT/PLAIN ; charset=US-ASCII  ")).toBe(
      "text/plain",
    );
  });

  it("leaves a clean mime type unchanged", () => {
    expect(canonicalizeMimeType("video/mp4")).toBe("video/mp4");
  });
});

// ---------------------------------------------------------------------------
// deriveMediaEncryptionKey
// ---------------------------------------------------------------------------

describe("deriveMediaEncryptionKey", () => {
  it("returns 32 bytes", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const key = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(randomBytes(100)),
    );
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same epoch + file metadata", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const attachment = makeAttachment(randomBytes(100));
    const a = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const b = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("produces different keys for different file hashes", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const keyA = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(randomBytes(100)),
    );
    const keyB = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(randomBytes(100)),
    );
    expect(bytesToHex(keyA)).not.toBe(bytesToHex(keyB));
  });

  it("produces different keys for different MIME types", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const keyA = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "image/jpeg"),
    );
    const keyB = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "video/mp4"),
    );
    expect(bytesToHex(keyA)).not.toBe(bytesToHex(keyB));
  });

  it("produces different keys for different filenames", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const keyA = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "image/jpeg", "photo.jpg"),
    );
    const keyB = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "image/jpeg", "other.jpg"),
    );
    expect(bytesToHex(keyA)).not.toBe(bytesToHex(keyB));
  });

  it("canonicalizes MIME type before key derivation", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const keyLower = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "image/jpeg"),
    );
    const keyUpper = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "IMAGE/JPEG"),
    );
    const keyParams = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      makeAttachment(file, "image/jpeg; charset=utf-8"),
    );
    expect(bytesToHex(keyLower)).toBe(bytesToHex(keyUpper));
    expect(bytesToHex(keyLower)).toBe(bytesToHex(keyParams));
  });

  it("throws when sha256 is missing", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const attachment = {
      type: "image/jpeg",
      filename: "photo.jpg",
    } as unknown as MediaAttachment;
    await expect(
      deriveMediaEncryptionKey(clientState, ciphersuite, attachment),
    ).rejects.toThrow("sha256");
  });

  it("throws when type is missing", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const attachment = {
      sha256: bytesToHex(sha256(randomBytes(32))),
      filename: "photo.jpg",
    } as unknown as MediaAttachment;
    await expect(
      deriveMediaEncryptionKey(clientState, ciphersuite, attachment),
    ).rejects.toThrow("type");
  });
});

// ---------------------------------------------------------------------------
// encryptMediaFile / decryptMediaFile
// ---------------------------------------------------------------------------

describe("encryptMediaFile / decryptMediaFile", () => {
  it("round-trips a small file", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = new Uint8Array([10, 20, 30, 40, 50]);
    const attachment = makeAttachment(
      file,
      "application/octet-stream",
      "data.bin",
    );

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(decryptMediaFile(encrypted, fileKey, filled)).toEqual(file);
  });

  it("round-trips a larger file", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(16384);
    const attachment = makeAttachment(file, "image/png", "large.png");

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(decryptMediaFile(encrypted, fileKey, filled)).toEqual(file);
  });

  it("populated attachment has correct fields", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file, "image/jpeg", "img.jpg");

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { attachment: filled } = encryptMediaFile(file, fileKey, attachment);

    expect(filled.version).toBe(MIP04_VERSION);
    expect(filled.nonce).toMatch(/^[0-9a-f]{24}$/); // 12 bytes hex-encoded
    expect(filled.sha256).toBe(attachment.sha256);
    expect(filled.type).toBe("image/jpeg");
    expect(filled.filename).toBe("img.jpg");
  });

  it("canonicalizes the MIME type on the returned attachment", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(32);
    const attachment = makeAttachment(file, "IMAGE/JPEG", "img.jpg");

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { attachment: filled } = encryptMediaFile(file, fileKey, attachment);
    expect(filled.type).toBe("image/jpeg");
  });

  it("each encryption produces a unique nonce", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file);

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { attachment: a } = encryptMediaFile(file, fileKey, attachment);
    const { attachment: b } = encryptMediaFile(file, fileKey, attachment);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("encrypted length is plaintext length + 16 (Poly1305 tag)", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const attachment = makeAttachment(
      file,
      "application/octet-stream",
      "test.bin",
    );

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted } = encryptMediaFile(file, fileKey, attachment);
    expect(encrypted.length).toBe(file.length + 16);
  });

  it("extra FileMetadata fields are preserved on the returned attachment", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(32);
    const attachment: MediaAttachment = {
      ...makeAttachment(file),
      url: "https://example.com/blob",
      dimensions: "800x600",
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
      alt: "A test image",
    };

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { attachment: filled } = encryptMediaFile(file, fileKey, attachment);

    expect(filled.url).toBe("https://example.com/blob");
    expect(filled.dimensions).toBe("800x600");
    expect(filled.blurhash).toBe("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    expect(filled.alt).toBe("A test image");
  });

  it("throws when ciphertext is tampered (AEAD failure)", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file);

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    encrypted[0] ^= 0xff;
    expect(() => decryptMediaFile(encrypted, fileKey, filled)).toThrow();
  });

  it("throws when filename is tampered (AAD mismatch)", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file, "image/jpeg", "real.jpg");

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(() =>
      decryptMediaFile(encrypted, fileKey, {
        ...filled,
        filename: "tampered.jpg",
      }),
    ).toThrow();
  });

  it("throws when MIME type is tampered (AAD mismatch)", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file, "image/jpeg", "file.jpg");

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(() =>
      decryptMediaFile(encrypted, fileKey, { ...filled, type: "image/png" }),
    ).toThrow();
  });

  it("throws when wrong key is used", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file);

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(() =>
      decryptMediaFile(encrypted, randomBytes(32), filled),
    ).toThrow();
  });

  it("throws when nonce is missing from attachment", () => {
    const attachment: MediaAttachment = {
      ...makeAttachment(randomBytes(32)),
      nonce: "",
    };
    expect(() =>
      decryptMediaFile(randomBytes(48), randomBytes(32), attachment),
    ).toThrow("nonce");
  });

  it("throws when fileHash in attachment is wrong (AAD mismatch)", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const attachment = makeAttachment(file);

    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );
    expect(() =>
      decryptMediaFile(encrypted, fileKey, {
        ...filled,
        sha256: bytesToHex(sha256(randomBytes(64))),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers for imeta parsing tests
// ---------------------------------------------------------------------------

/**
 * Builds a valid MIP-04 v2 `imeta` tag array from a {@link MediaAttachment}.
 * Mirrors what `createImetaTagForAttachment` from applesauce would emit for the
 * standard NIP-92 fields, with the MIP-04 extensions appended.
 */
function buildImetaTag(attachment: MediaAttachment): string[] {
  const parts: string[] = ["imeta"];
  if (attachment.url) parts.push(`url ${attachment.url}`);
  if (attachment.type) parts.push(`m ${attachment.type}`);
  if (attachment.sha256) parts.push(`x ${attachment.sha256}`);
  if (attachment.size !== undefined) parts.push(`size ${attachment.size}`);
  if (attachment.dimensions) parts.push(`dim ${attachment.dimensions}`);
  if (attachment.blurhash) parts.push(`blurhash ${attachment.blurhash}`);
  if (attachment.alt) parts.push(`alt ${attachment.alt}`);
  parts.push(`filename ${attachment.filename}`);
  parts.push(`n ${attachment.nonce}`);
  parts.push(`v ${attachment.version}`);
  return parts;
}

/** Minimal valid MIP-04 v2 imeta tag with only the required MIP-04 fields. */
function minimalImetaTag(overrides?: Partial<MediaAttachment>): string[] {
  const base: MediaAttachment = {
    sha256: bytesToHex(sha256(randomBytes(32))),
    type: "image/jpeg",
    filename: "photo.jpg",
    nonce: bytesToHex(randomBytes(12)),
    version: MIP04_VERSION,
    ...overrides,
  };
  return buildImetaTag(base);
}

// ---------------------------------------------------------------------------
// parseMediaImetaTag
// ---------------------------------------------------------------------------

describe("parseMediaImetaTag", () => {
  it("returns null for non-imeta tags", () => {
    expect(parseMediaImetaTag(["p", "pubkey"])).toBeNull();
    expect(parseMediaImetaTag(["e", "eventid"])).toBeNull();
    expect(parseMediaImetaTag([])).toBeNull();
  });

  it("returns null when v field is absent", () => {
    const tag = [
      "imeta",
      "x abcdef1234",
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when v field does not match MIP04_VERSION", () => {
    const tag = minimalImetaTag();
    // Replace v field with legacy version
    const tampered = tag.map((p) => (p.startsWith("v ") ? "v mip04-v1" : p));
    expect(parseMediaImetaTag(tampered)).toBeNull();
  });

  it("returns null when n (nonce) is absent", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m image/jpeg",
      "filename photo.jpg",
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when n is too short (not 12 bytes encoded)", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(11)), // 22 chars — one byte short
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when n is too long (more than 12 bytes encoded)", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(13)), // 26 chars — one byte over
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when n is not valid hex", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m image/jpeg",
      "filename photo.jpg",
      "n zzzzzzzzzzzzzzzzzzzzzzzz",
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when x (sha256) is absent", () => {
    const tag = [
      "imeta",
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when x is wrong length", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(randomBytes(31)), // 62 chars instead of 64
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when x is not valid hex", () => {
    const tag = [
      "imeta",
      "x " + "g".repeat(64),
      "m image/jpeg",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when m (MIME type) is absent", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when m is not a valid MIME type", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m notamimetype",
      "filename photo.jpg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns null when filename is absent", () => {
    const tag = [
      "imeta",
      "x " + bytesToHex(sha256(randomBytes(32))),
      "m image/jpeg",
      "n " + bytesToHex(randomBytes(12)),
      "v " + MIP04_VERSION,
    ];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("returns a valid attachment for a well-formed tag", () => {
    const sha = bytesToHex(sha256(randomBytes(32)));
    const nonce = bytesToHex(randomBytes(12));
    const tag = [
      "imeta",
      `url https://example.com/blob/${sha}`,
      `x ${sha}`,
      "m image/jpeg",
      "filename photo.jpg",
      `n ${nonce}`,
      `v ${MIP04_VERSION}`,
    ];

    const result = parseMediaImetaTag(tag);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("photo.jpg");
    expect(result!.nonce).toBe(nonce);
    expect(result!.version).toBe(MIP04_VERSION);
    expect(result!.sha256).toBe(sha);
    expect(result!.type).toBe("image/jpeg");
    expect(result!.url).toBe(`https://example.com/blob/${sha}`);
  });

  it("copies standard NIP-92 fields via applesauce", () => {
    const sha = bytesToHex(sha256(randomBytes(32)));
    const nonce = bytesToHex(randomBytes(12));
    const tag = [
      "imeta",
      `x ${sha}`,
      "m video/mp4",
      "dim 1920x1080",
      "blurhash LEHV6nWB2yk8",
      "alt A test video",
      "size 4096",
      "filename clip.mp4",
      `n ${nonce}`,
      `v ${MIP04_VERSION}`,
    ];

    const result = parseMediaImetaTag(tag);
    expect(result).not.toBeNull();
    expect(result!.dimensions).toBe("1920x1080");
    expect(result!.blurhash).toBe("LEHV6nWB2yk8");
    expect(result!.alt).toBe("A test video");
    expect(result!.size).toBe(4096);
    expect(result!.type).toBe("video/mp4");
    expect(result!.sha256).toBe(sha);
  });

  it("round-trips through encryptMediaFile → buildImetaTag → parseMediaImetaTag", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(256);
    const attachment = makeAttachment(file, "image/png", "snap.png");
    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { attachment: filled } = encryptMediaFile(file, fileKey, attachment);
    const tag = buildImetaTag(filled);
    const parsed = parseMediaImetaTag(tag);

    expect(parsed).not.toBeNull();
    expect(parsed!.filename).toBe("snap.png");
    expect(parsed!.nonce).toBe(filled.nonce);
    expect(parsed!.sha256).toBe(filled.sha256);
    expect(parsed!.type).toBe("image/png");
    expect(parsed!.version).toBe(MIP04_VERSION);
  });
});

// ---------------------------------------------------------------------------
// getMediaAttachments
// ---------------------------------------------------------------------------

describe("getMediaAttachments", () => {
  it("returns an empty array when there are no imeta tags", () => {
    const tags = [
      ["p", "pubkey"],
      ["e", "eventid"],
    ];
    expect(getMediaAttachments(tags)).toEqual([]);
  });

  it("skips non-imeta tags", () => {
    const tags = [["p", "pubkey"], minimalImetaTag()];
    expect(getMediaAttachments(tags)).toHaveLength(1);
  });

  it("skips imeta tags that fail MIP-04 validation", () => {
    const valid = minimalImetaTag();
    const noVersion = valid.filter((p) => !p.startsWith("v "));
    const noNonce = valid.filter((p) => !p.startsWith("n "));
    const tags = [noVersion, noNonce, valid];
    expect(getMediaAttachments(tags)).toHaveLength(1);
  });

  it("returns all valid MIP-04 v2 attachments", () => {
    const tags = [minimalImetaTag(), minimalImetaTag(), minimalImetaTag()];
    const results = getMediaAttachments(tags);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.version).toBe(MIP04_VERSION);
    }
  });
});

// ---------------------------------------------------------------------------
// getMediaAttachmentFromFileEvent
// ---------------------------------------------------------------------------

describe("getMediaAttachmentFromFileEvent", () => {
  /** Builds a minimal kind 1063 event from a MediaAttachment. */
  function buildKind1063Event(
    attachment: MediaAttachment,
    overrideTags?: string[][],
  ): Parameters<typeof getMediaAttachmentFromFileEvent>[0] {
    const tags: string[][] = [
      ...(attachment.url ? [["url", attachment.url]] : []),
      ...(attachment.type ? [["m", attachment.type]] : []),
      ...(attachment.sha256 ? [["x", attachment.sha256]] : []),
      ...(attachment.size !== undefined
        ? [["size", String(attachment.size)]]
        : []),
      ...(attachment.dimensions ? [["dim", attachment.dimensions]] : []),
      ...(attachment.blurhash ? [["blurhash", attachment.blurhash]] : []),
      ...(attachment.alt ? [["alt", attachment.alt]] : []),
      ["filename", attachment.filename],
      ["n", attachment.nonce],
      ["v", attachment.version],
      ...(overrideTags ?? []),
    ];
    return {
      kind: 1063,
      content: "",
      tags,
      id: "0".repeat(64),
      pubkey: "0".repeat(64),
      created_at: 0,
      sig: "0".repeat(128),
    };
  }

  it("returns null when v tag is absent", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    // Remove the v tag
    event.tags = event.tags.filter((t) => t[0] !== "v");
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when v tag does not match MIP04_VERSION", () => {
    const sha = bytesToHex(sha256(randomBytes(32)));
    const event = {
      kind: 1063,
      content: "",
      tags: [
        ["x", sha],
        ["m", "image/jpeg"],
        ["filename", "photo.jpg"],
        ["n", bytesToHex(randomBytes(12))],
        ["v", "mip04-v1"],
      ],
      id: "0".repeat(64),
      pubkey: "0".repeat(64),
      created_at: 0,
      sig: "0".repeat(128),
    };
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when n tag is absent", () => {
    const attachment: MediaAttachment = {
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    event.tags = event.tags.filter((t) => t[0] !== "n");
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when n is too short (not 12 bytes encoded)", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    // Replace n with an 11-byte (22 char) nonce
    event.tags = event.tags.map((t) =>
      t[0] === "n" ? ["n", bytesToHex(randomBytes(11))] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when n is too long (more than 12 bytes encoded)", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    // Replace n with a 13-byte (26 char) nonce
    event.tags = event.tags.map((t) =>
      t[0] === "n" ? ["n", bytesToHex(randomBytes(13))] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when n is not valid hex", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    event.tags = event.tags.map((t) =>
      t[0] === "n" ? ["n", "zzzzzzzzzzzzzzzzzzzzzzzz"] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when x (sha256) tag is absent", () => {
    const attachment: MediaAttachment = {
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    event.tags = event.tags.filter((t) => t[0] !== "x");
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when x is wrong length", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    // Replace x with a 31-byte (62 char) hash
    event.tags = event.tags.map((t) =>
      t[0] === "x" ? ["x", bytesToHex(randomBytes(31))] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when x is not valid hex", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    event.tags = event.tags.map((t) =>
      t[0] === "x" ? ["x", "g".repeat(64)] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when m (MIME type) tag is absent", () => {
    const attachment: MediaAttachment = {
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    event.tags = event.tags.filter((t) => t[0] !== "m");
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when m is not a valid MIME type", () => {
    const event = buildKind1063Event({
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    });
    event.tags = event.tags.map((t) =>
      t[0] === "m" ? ["m", "notamimetype"] : t,
    );
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns null when filename tag is absent", () => {
    const attachment: MediaAttachment = {
      sha256: bytesToHex(sha256(randomBytes(32))),
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce: bytesToHex(randomBytes(12)),
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    event.tags = event.tags.filter((t) => t[0] !== "filename");
    expect(getMediaAttachmentFromFileEvent(event)).toBeNull();
  });

  it("returns a valid attachment for a well-formed event", () => {
    const sha = bytesToHex(sha256(randomBytes(32)));
    const nonce = bytesToHex(randomBytes(12));
    const attachment: MediaAttachment = {
      url: `https://example.com/blob/${sha}`,
      sha256: sha,
      type: "image/jpeg",
      filename: "photo.jpg",
      nonce,
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    const result = getMediaAttachmentFromFileEvent(event);

    expect(result).not.toBeNull();
    expect(result!.filename).toBe("photo.jpg");
    expect(result!.nonce).toBe(nonce);
    expect(result!.version).toBe(MIP04_VERSION);
    expect(result!.sha256).toBe(sha);
    expect(result!.type).toBe("image/jpeg");
    expect(result!.url).toBe(`https://example.com/blob/${sha}`);
  });

  it("copies standard NIP-94 fields via applesauce", () => {
    const sha = bytesToHex(sha256(randomBytes(32)));
    const nonce = bytesToHex(randomBytes(12));
    const attachment: MediaAttachment = {
      sha256: sha,
      type: "video/mp4",
      dimensions: "1280x720",
      blurhash: "LEHV6nWB2yk8",
      alt: "A test clip",
      size: 8192,
      filename: "clip.mp4",
      nonce,
      version: MIP04_VERSION,
    };
    const event = buildKind1063Event(attachment);
    const result = getMediaAttachmentFromFileEvent(event);

    expect(result).not.toBeNull();
    expect(result!.dimensions).toBe("1280x720");
    expect(result!.blurhash).toBe("LEHV6nWB2yk8");
    expect(result!.alt).toBe("A test clip");
    expect(result!.size).toBe(8192);
    expect(result!.type).toBe("video/mp4");
    expect(result!.sha256).toBe(sha);
  });
});

describe("MarmotGroup.decryptMedia", () => {
  it("deduplicates concurrent decrypts for the same attachment", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const stateStore = new GroupStateStore(
      new KeyValueGroupStateBackend(new InMemoryKeyValueStore()),
    );
    const group = new MarmotGroup(clientState, {
      stateStore,
      signer: {
        getPublicKey: async () => "a".repeat(64),
        signEvent: async (event) => event as NostrEvent,
      },
      ciphersuite,
      media: new GroupMediaStore(),
      network: {
        request: async () => [],
        subscription: () => {
          throw new Error("not implemented");
        },
        publish: async () => ({}),
        getUserInboxRelays: async () => [],
      },
    });

    const file = randomBytes(128);
    const attachment = makeAttachment(file, "image/png", "image.png");
    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      attachment,
    );
    const { encrypted, attachment: filled } = encryptMediaFile(
      file,
      fileKey,
      attachment,
    );

    const addMediaSpy = vi.spyOn(group.media, "addMedia");
    const [first, second] = await Promise.all([
      group.decryptMedia(encrypted, filled),
      group.decryptMedia(encrypted, filled),
    ]);

    expect(first.data).toEqual(file);
    expect(second.data).toEqual(file);
    expect(addMediaSpy).toHaveBeenCalledTimes(1);
  });
});
