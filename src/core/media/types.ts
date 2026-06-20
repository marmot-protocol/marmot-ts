/** @module @category Core - Encrypted Media */

/**
 * Media format / version string for the current encrypted-media scheme.
 *
 * Written to the `v` field of an attachment `imeta` tag and mixed into the
 * key-derivation context and AEAD associated data. New media references MUST
 * use this value; V1 clients MUST reject any legacy media-version string (see
 * darkmatter `features/encrypted-media.md`).
 */
export const ENCRYPTED_MEDIA_VERSION = "encrypted-media-v1" as const;

/** The initial (and only v1) locator kind. */
export const BLOSSOM_LOCATOR_KIND = "blossom-v1" as const;

/**
 * A single blob locator from an attachment `imeta` tag.
 *
 * Serialized as `locator <kind> <value>`. For `blossom-v1` the value is an
 * encrypted-blob URL; other kinds carry backend-specific values. A message MAY
 * list multiple locators for the same attachment; the order is preserved.
 */
export interface MediaLocator {
  /** Locator kind, e.g. `"blossom-v1"`. Lowercase ASCII letters, digits, `-`. */
  kind: string;
  /** Locator value — a URL for `blossom-v1`. */
  value: string;
}

/**
 * A decoded `encrypted-media-v1` attachment (one `imeta` tag).
 *
 * Built by {@link encryptMediaFile} (locators are filled in by the caller after
 * upload), serialized with `encodeMediaImetaTag`, and read back with
 * `parseMediaImetaTag`.
 */
export interface MediaAttachment {
  /** Always {@link ENCRYPTED_MEDIA_VERSION}. */
  version: typeof ENCRYPTED_MEDIA_VERSION;
  /**
   * One or more ordered locators (`locator <kind> <value>`). Empty only on the
   * attachment returned by {@link encryptMediaFile} before the blob is uploaded;
   * a parsed attachment always has at least one.
   */
  locators: MediaLocator[];
  /**
   * Hex-encoded SHA-256 of the **ciphertext** (64 hex chars). The preferred
   * content id for blob storage; fetched bytes are verified against it.
   */
  ciphertextSha256: string;
  /**
   * Hex-encoded SHA-256 of the **plaintext** file (64 hex chars). Feeds the
   * `file_key` derivation and the AEAD AAD; verified after decryption.
   */
  plaintextSha256: string;
  /**
   * Hex-encoded 12-byte ChaCha20-Poly1305 nonce (exactly 24 hex chars).
   */
  nonce: string;
  /**
   * Canonical media (MIME) type — see `canonicalizeMimeType`. Feeds the
   * `file_key` derivation and the AEAD AAD.
   */
  mediaType: string;
  /** Display filename. Feeds the `file_key` derivation and the AEAD AAD. */
  filename: string;
  /** Optional `<width>x<height>` render hint. */
  dim?: string;
  /** Optional thumbhash preview value. */
  thumbhash?: string;
}

/** Result of {@link encryptMediaFile}. */
export type EncryptMediaFileResult = {
  /**
   * The encrypted blob. Upload this to a blob store; `SHA256(encrypted)` (also
   * available as `attachment.ciphertextSha256`) is the preferred content id.
   */
  encrypted: Uint8Array;
  /**
   * A populated {@link MediaAttachment} with `ciphertextSha256`,
   * `plaintextSha256`, `nonce`, `mediaType`, and `filename` set, and
   * `locators` empty. The caller adds one or more {@link MediaLocator} entries
   * after uploading `encrypted`, then serializes the attachment with
   * `encodeMediaImetaTag`.
   */
  attachment: MediaAttachment;
};
