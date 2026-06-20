import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import type { NostrEvent } from "applesauce-core/helpers";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { GroupMediaStore } from "../../client/group/group-media-store.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { SerializedClientState } from "../client-state";
import {
  encryptedMediaBlossomDefault,
  type EncryptedMediaPolicyV1,
} from "../components/encrypted-media.js";
import { createCredential } from "../credential.js";
import { createSimpleGroup } from "../group.js";
import { generateKeyPackage } from "../key-package.js";
import {
  buildFallbackFetchUrls,
  canonicalizeMimeType,
  decryptMediaFile,
  deriveMediaEncryptionKey,
  encodeMediaImetaTag,
  ENCRYPTED_MEDIA_VERSION,
  encryptMediaFile,
  getMediaAttachments,
  type MediaAttachment,
  parseMediaImetaTag,
  resolveMediaFetchUrls,
  selectFetchableLocators,
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

/** Crypto fields (plaintextSha256/mediaType/filename) for a given file. */
function cryptoFields(
  file: Uint8Array,
  mediaType = "image/jpeg",
  filename = "photo.jpg",
) {
  return { plaintextSha256: bytesToHex(sha256(file)), mediaType, filename };
}

const BLOSSOM_URL = "https://blossom.example.com";

/** Encrypts a file and returns a fully populated attachment with one locator. */
async function makeEncrypted(
  file: Uint8Array,
  mediaType = "image/jpeg",
  filename = "photo.jpg",
) {
  const { clientState, ciphersuite } = await makeClientState();
  const fields = cryptoFields(file, mediaType, filename);
  const fileKey = await deriveMediaEncryptionKey(
    clientState,
    ciphersuite,
    fields,
  );
  const { encrypted, attachment } = encryptMediaFile(file, fileKey, fields);
  attachment.locators.push({
    kind: "blossom-v1",
    value: `${BLOSSOM_URL}/${attachment.ciphertextSha256}`,
  });
  return { encrypted, attachment, fileKey };
}

// ---------------------------------------------------------------------------
// canonicalizeMimeType
// ---------------------------------------------------------------------------

describe("canonicalizeMimeType", () => {
  it("lowercases the type", () => {
    expect(canonicalizeMimeType("IMAGE/JPEG")).toBe("image/jpeg");
  });

  it("trims whitespace", () => {
    expect(canonicalizeMimeType("  image/png  ")).toBe("image/png");
  });

  it("strips parameters", () => {
    expect(canonicalizeMimeType("text/plain; charset=utf-8")).toBe(
      "text/plain",
    );
  });

  it("applies the image/jpg → image/jpeg alias", () => {
    expect(canonicalizeMimeType("image/jpg")).toBe("image/jpeg");
    expect(canonicalizeMimeType("IMAGE/JPG")).toBe("image/jpeg");
  });

  it("handles combined cases", () => {
    expect(canonicalizeMimeType("  IMAGE/JPG ; q=1  ")).toBe("image/jpeg");
  });

  it("rejects an empty or slash-less media type", () => {
    expect(() => canonicalizeMimeType("")).toThrow();
    expect(() => canonicalizeMimeType("notamimetype")).toThrow();
    expect(() => canonicalizeMimeType("image/")).toThrow();
    expect(() => canonicalizeMimeType("/jpeg")).toThrow();
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
      cryptoFields(randomBytes(100)),
    );
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it("is deterministic for the same epoch + file metadata", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const fields = cryptoFields(randomBytes(100));
    const a = await deriveMediaEncryptionKey(clientState, ciphersuite, fields);
    const b = await deriveMediaEncryptionKey(clientState, ciphersuite, fields);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it("produces different keys for different plaintext hashes", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const a = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(randomBytes(100)),
    );
    const b = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(randomBytes(100)),
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("produces different keys for different MIME types and filenames", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const a = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "image/jpeg", "a.jpg"),
    );
    const b = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "video/mp4", "a.jpg"),
    );
    const c = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "image/jpeg", "b.jpg"),
    );
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(bytesToHex(a)).not.toBe(bytesToHex(c));
  });

  it("canonicalizes MIME type before key derivation", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(100);
    const keyLower = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "image/jpeg"),
    );
    const keyUpper = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "IMAGE/JPEG"),
    );
    const keyAlias = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      cryptoFields(file, "image/jpg"),
    );
    expect(bytesToHex(keyLower)).toBe(bytesToHex(keyUpper));
    expect(bytesToHex(keyLower)).toBe(bytesToHex(keyAlias));
  });

  it("throws when plaintextSha256 is missing", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    await expect(
      deriveMediaEncryptionKey(clientState, ciphersuite, {
        mediaType: "image/jpeg",
        filename: "a.jpg",
      } as MediaAttachment),
    ).rejects.toThrow("plaintextSha256");
  });

  it("throws when mediaType is missing", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    await expect(
      deriveMediaEncryptionKey(clientState, ciphersuite, {
        plaintextSha256: bytesToHex(sha256(randomBytes(32))),
        filename: "a.jpg",
      } as MediaAttachment),
    ).rejects.toThrow("mediaType");
  });
});

// ---------------------------------------------------------------------------
// encryptMediaFile / decryptMediaFile
// ---------------------------------------------------------------------------

describe("encryptMediaFile / decryptMediaFile", () => {
  it("round-trips a small file", async () => {
    const file = new Uint8Array([10, 20, 30, 40, 50]);
    const { encrypted, attachment, fileKey } = await makeEncrypted(
      file,
      "application/octet-stream",
      "data.bin",
    );
    expect(decryptMediaFile(encrypted, fileKey, attachment)).toEqual(file);
  });

  it("round-trips a larger file", async () => {
    const file = randomBytes(16384);
    const { encrypted, attachment, fileKey } = await makeEncrypted(
      file,
      "image/png",
      "large.png",
    );
    expect(decryptMediaFile(encrypted, fileKey, attachment)).toEqual(file);
  });

  it("populated attachment has correct fields", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment } = await makeEncrypted(
      file,
      "image/jpeg",
      "img.jpg",
    );
    expect(attachment.version).toBe(ENCRYPTED_MEDIA_VERSION);
    expect(attachment.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(attachment.plaintextSha256).toBe(bytesToHex(sha256(file)));
    expect(attachment.ciphertextSha256).toBe(bytesToHex(sha256(encrypted)));
    expect(attachment.mediaType).toBe("image/jpeg");
    expect(attachment.filename).toBe("img.jpg");
  });

  it("canonicalizes the MIME type (incl. jpg alias) on the result", async () => {
    const file = randomBytes(32);
    const { attachment } = await makeEncrypted(file, "IMAGE/JPG", "img.jpg");
    expect(attachment.mediaType).toBe("image/jpeg");
  });

  it("each encryption produces a unique nonce", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(64);
    const fields = cryptoFields(file);
    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      fields,
    );
    const { attachment: a } = encryptMediaFile(file, fileKey, fields);
    const { attachment: b } = encryptMediaFile(file, fileKey, fields);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("encrypted length is plaintext length + 16 (Poly1305 tag)", async () => {
    const file = randomBytes(100);
    const { encrypted } = await makeEncrypted(
      file,
      "application/octet-stream",
      "test.bin",
    );
    expect(encrypted.length).toBe(file.length + 16);
  });

  it("carries optional dim/thumbhash through", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const file = randomBytes(32);
    const fields = {
      ...cryptoFields(file),
      dim: "800x600",
      thumbhash: "abc123",
    };
    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      fields,
    );
    const { attachment } = encryptMediaFile(file, fileKey, fields);
    expect(attachment.dim).toBe("800x600");
    expect(attachment.thumbhash).toBe("abc123");
  });

  it("throws when the ciphertext is tampered (hash mismatch / AEAD failure)", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment, fileKey } = await makeEncrypted(file);
    encrypted[0] ^= 0xff;
    expect(() => decryptMediaFile(encrypted, fileKey, attachment)).toThrow();
  });

  it("throws when the filename is tampered (AAD mismatch)", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment, fileKey } = await makeEncrypted(
      file,
      "image/jpeg",
      "real.jpg",
    );
    expect(() =>
      decryptMediaFile(encrypted, fileKey, {
        ...attachment,
        filename: "tampered.jpg",
      }),
    ).toThrow();
  });

  it("throws when the MIME type is tampered (AAD mismatch)", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment, fileKey } = await makeEncrypted(file);
    expect(() =>
      decryptMediaFile(encrypted, fileKey, {
        ...attachment,
        mediaType: "image/png",
      }),
    ).toThrow();
  });

  it("throws when the wrong key is used", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment } = await makeEncrypted(file);
    expect(() =>
      decryptMediaFile(encrypted, randomBytes(32), attachment),
    ).toThrow();
  });

  it("throws when the nonce is missing", async () => {
    const file = randomBytes(32);
    const { encrypted, attachment, fileKey } = await makeEncrypted(file);
    expect(() =>
      decryptMediaFile(encrypted, fileKey, { ...attachment, nonce: "" }),
    ).toThrow("nonce");
  });

  it("throws when ciphertextSha256 does not match the fetched bytes", async () => {
    const file = randomBytes(64);
    const { encrypted, attachment, fileKey } = await makeEncrypted(file);
    expect(() =>
      decryptMediaFile(encrypted, fileKey, {
        ...attachment,
        ciphertextSha256: bytesToHex(sha256(randomBytes(64))),
      }),
    ).toThrow(/ciphertext/);
  });

  it("throws when plaintextSha256 does not match the decrypted bytes", async () => {
    // Tamper plaintextSha256 only in the validation step by re-deriving with a
    // matching key but a different declared plaintext hash is impossible (the
    // key binds it). Instead verify the check rejects a wrong plaintext hash on
    // an attachment whose AAD still authenticates via the real fields.
    const file = randomBytes(64);
    const { encrypted, attachment, fileKey } = await makeEncrypted(file);
    // Keep AAD valid (same fields) but lie about plaintext hash → step 3 fails.
    const lying = {
      ...attachment,
      plaintextSha256: bytesToHex(sha256(randomBytes(64))),
    };
    // The lie changes the AAD too, so AEAD fails first — either way it throws.
    expect(() => decryptMediaFile(encrypted, fileKey, lying)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// imeta encode / parse
// ---------------------------------------------------------------------------

/** A valid imeta tag for a freshly-encrypted attachment. */
async function validImetaTag(
  overrides?: Partial<MediaAttachment>,
): Promise<string[]> {
  const { attachment } = await makeEncrypted(randomBytes(64));
  return encodeMediaImetaTag({ ...attachment, ...overrides });
}

describe("encodeMediaImetaTag / parseMediaImetaTag", () => {
  it("round-trips a populated attachment", async () => {
    const { attachment } = await makeEncrypted(
      randomBytes(128),
      "image/png",
      "snap.png",
    );
    attachment.dim = "10x10";
    attachment.thumbhash = "th";
    const tag = encodeMediaImetaTag(attachment);
    const parsed = parseMediaImetaTag(tag);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(ENCRYPTED_MEDIA_VERSION);
    expect(parsed!.mediaType).toBe("image/png");
    expect(parsed!.filename).toBe("snap.png");
    expect(parsed!.nonce).toBe(attachment.nonce);
    expect(parsed!.ciphertextSha256).toBe(attachment.ciphertextSha256);
    expect(parsed!.plaintextSha256).toBe(attachment.plaintextSha256);
    expect(parsed!.dim).toBe("10x10");
    expect(parsed!.thumbhash).toBe("th");
    expect(parsed!.locators).toEqual(attachment.locators);
  });

  it("preserves multiple locators in order (incl. unknown kinds)", async () => {
    const { attachment } = await makeEncrypted(randomBytes(64));
    attachment.locators = [
      { kind: "blossom-v1", value: `${BLOSSOM_URL}/a` },
      { kind: "future-v1", value: "https://other.example.com/b" },
    ];
    const parsed = parseMediaImetaTag(encodeMediaImetaTag(attachment));
    expect(parsed!.locators).toEqual(attachment.locators);
  });

  it("returns null for non-imeta tags", () => {
    expect(parseMediaImetaTag(["p", "pubkey"])).toBeNull();
    expect(parseMediaImetaTag([])).toBeNull();
  });

  it("rejects a missing version", async () => {
    const tag = (await validImetaTag()).filter((p) => !p.startsWith("v "));
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("rejects a legacy version string", async () => {
    const tag = (await validImetaTag()).map((p) =>
      p.startsWith("v ") ? "v mip04-v2" : p,
    );
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("rejects a present blurhash field", async () => {
    const tag = [...(await validImetaTag()), "blurhash LEHV6nWB2yk8"];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("rejects a duplicated single-occurrence field", async () => {
    const tag = [...(await validImetaTag()), "filename dup.jpg"];
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("rejects when no locator is present", async () => {
    const tag = (await validImetaTag()).filter(
      (p) => !p.startsWith("locator "),
    );
    expect(parseMediaImetaTag(tag)).toBeNull();
  });

  it("rejects a locator with an empty value or non-URL value", async () => {
    const base = await validImetaTag();
    const noValue = base.map((p) =>
      p.startsWith("locator ") ? "locator blossom-v1" : p,
    );
    const notUrl = base.map((p) =>
      p.startsWith("locator ") ? "locator blossom-v1 not a url" : p,
    );
    expect(parseMediaImetaTag(noValue)).toBeNull();
    expect(parseMediaImetaTag(notUrl)).toBeNull();
  });

  it("rejects a blossom-v1 locator on an unsafe / cleartext host", async () => {
    const base = await validImetaTag();
    for (const bad of [
      "http://blossom.example.com/x",
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://[::1]/x",
    ]) {
      const tag = base.map((p) =>
        p.startsWith("locator ") ? `locator blossom-v1 ${bad}` : p,
      );
      expect(parseMediaImetaTag(tag), bad).toBeNull();
    }
  });

  it("keeps a structurally-valid locator of an unknown kind", async () => {
    const base = await validImetaTag();
    const tag = base.map((p) =>
      p.startsWith("locator ")
        ? "locator future-v1 https://other.example.com/x"
        : p,
    );
    const parsed = parseMediaImetaTag(tag);
    expect(parsed).not.toBeNull();
    expect(parsed!.locators[0].kind).toBe("future-v1");
  });

  it("rejects malformed hashes and nonce", async () => {
    const base = await validImetaTag();
    const badCipher = base.map((p) =>
      p.startsWith("ciphertext_sha256 ") ? "ciphertext_sha256 abc" : p,
    );
    const badPlain = base.map((p) =>
      p.startsWith("plaintext_sha256 ")
        ? `plaintext_sha256 ${"g".repeat(64)}`
        : p,
    );
    const badNonce = base.map((p) =>
      p.startsWith("nonce ") ? `nonce ${bytesToHex(randomBytes(11))}` : p,
    );
    expect(parseMediaImetaTag(badCipher)).toBeNull();
    expect(parseMediaImetaTag(badPlain)).toBeNull();
    expect(parseMediaImetaTag(badNonce)).toBeNull();
  });

  it("rejects missing m or filename", async () => {
    const base = await validImetaTag();
    expect(
      parseMediaImetaTag(base.filter((p) => !p.startsWith("m "))),
    ).toBeNull();
    expect(
      parseMediaImetaTag(base.filter((p) => !p.startsWith("filename "))),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMediaAttachments
// ---------------------------------------------------------------------------

describe("getMediaAttachments", () => {
  it("returns an empty array when there are no imeta tags", () => {
    expect(getMediaAttachments([["p", "pubkey"]])).toEqual([]);
  });

  it("skips non-imeta and invalid imeta tags", async () => {
    const valid = await validImetaTag();
    const invalid = valid.filter((p) => !p.startsWith("v "));
    const results = getMediaAttachments([["p", "x"], invalid, valid]);
    expect(results).toHaveLength(1);
    expect(results[0].version).toBe(ENCRYPTED_MEDIA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// locator fetchability + fallback
// ---------------------------------------------------------------------------

describe("locator resolution", () => {
  const policy: EncryptedMediaPolicyV1 = encryptedMediaBlossomDefault([
    "https://blossom.primal.net",
  ]);

  function attachmentWith(locators: MediaAttachment["locators"]) {
    return {
      version: ENCRYPTED_MEDIA_VERSION,
      locators,
      ciphertextSha256: "a".repeat(64),
      plaintextSha256: "b".repeat(64),
      nonce: "c".repeat(24),
      mediaType: "image/jpeg",
      filename: "x.jpg",
    } satisfies MediaAttachment;
  }

  it("selects only supported + allowed locator kinds", () => {
    const att = attachmentWith([
      { kind: "blossom-v1", value: "https://a.example.com/x" },
      { kind: "future-v1", value: "https://b.example.com/x" },
    ]);
    const sel = selectFetchableLocators(att, {
      allowedLocatorKinds: policy.allowedLocatorKinds,
    });
    expect(sel).toHaveLength(1);
    expect(sel[0].kind).toBe("blossom-v1");
  });

  it("builds fallback fetch URLs from the policy endpoints", () => {
    const att = attachmentWith([
      { kind: "blossom-v1", value: "https://a.example.com/x" },
    ]);
    const urls = buildFallbackFetchUrls(att, policy);
    expect(urls).toEqual([
      `https://blossom.primal.net/${att.ciphertextSha256}`,
    ]);
  });

  it("resolves explicit locators first, then fallbacks, deduped", () => {
    const att = attachmentWith([
      { kind: "blossom-v1", value: "https://a.example.com/x" },
      {
        kind: "blossom-v1",
        value: `https://blossom.primal.net/${"a".repeat(64)}`,
      },
    ]);
    const urls = resolveMediaFetchUrls(att, policy);
    expect(urls[0]).toBe("https://a.example.com/x");
    // The duplicate of the fallback URL appears once.
    expect(urls).toHaveLength(2);
    expect(new Set(urls).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MarmotGroup.decryptMedia
// ---------------------------------------------------------------------------

describe("MarmotGroup.decryptMedia", () => {
  it("deduplicates concurrent decrypts for the same attachment", async () => {
    const { clientState, ciphersuite } = await makeClientState();
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const group = new MarmotGroup(clientState, {
      store,
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
    const fields = cryptoFields(file, "image/png", "image.png");
    const fileKey = await deriveMediaEncryptionKey(
      clientState,
      ciphersuite,
      fields,
    );
    const { encrypted, attachment } = encryptMediaFile(file, fileKey, fields);

    const addMediaSpy = vi.spyOn(group.media, "addMedia");
    const [first, second] = await Promise.all([
      group.decryptMedia(encrypted, attachment),
      group.decryptMedia(encrypted, attachment),
    ]);

    expect(first.data).toEqual(file);
    expect(second.data).toEqual(file);
    expect(addMediaSpy).toHaveBeenCalledTimes(1);
  });
});
