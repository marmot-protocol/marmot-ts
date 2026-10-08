/** @module @category Core - Encrypted Media */

/**
 * The frozen legacy `encrypted-media-v1` format label
 * (`features/encrypted-media-v1.md`). Used by groups that carry the
 * `marmot.group.encrypted-media.v1` (`0x8008`) policy.
 */
export const ENCRYPTED_MEDIA_VERSION_V1 = "encrypted-media-v1" as const;

/**
 * The current `encrypted-media-v2` format label (`features/encrypted-media.md`).
 * Used by groups that carry the `marmot.group.encrypted-media.v2` (`0x800b`)
 * policy, which is every current-profile group MDK creates.
 */
export const ENCRYPTED_MEDIA_VERSION_V2 = "encrypted-media-v2" as const;

/** A media format label this implementation can produce and consume. */
export type EncryptedMediaVersion =
  typeof ENCRYPTED_MEDIA_VERSION_V1 | typeof ENCRYPTED_MEDIA_VERSION_V2;

/**
 * Legacy name for {@link ENCRYPTED_MEDIA_VERSION_V1}. It stays the v1 label,
 * like MDK's `ENCRYPTED_MEDIA_VERSION`: a group's media version is selected by
 * its encrypted-media component, not by this constant.
 */
export const ENCRYPTED_MEDIA_VERSION = ENCRYPTED_MEDIA_VERSION_V1;

/** Returns `value` as an {@link EncryptedMediaVersion}, or `undefined`. */
export function parseEncryptedMediaVersion(
  value: string,
): EncryptedMediaVersion | undefined {
  return value === ENCRYPTED_MEDIA_VERSION_V1 ||
    value === ENCRYPTED_MEDIA_VERSION_V2
    ? value
    : undefined;
}

/** The initial locator kind, shared by v1 and v2. */
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
 * A decoded encrypted-media attachment (one `imeta` tag), v1 or v2.
 *
 * Built by {@link encryptMediaFile} (locators are filled in by the caller after
 * upload), serialized with `encodeMediaImetaTag`, and read back with
 * `parseMediaImetaTag`.
 */
export interface MediaAttachment {
  /**
   * The media format (`v` field). Selects the key-derivation / AAD label and
   * the validation profile. Not interchangeable: a v1 reference never decrypts
   * as v2 or vice versa.
   */
  version: EncryptedMediaVersion;
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
