/** @module @category Core - Encrypted Media */
import type { FileMetadataFields } from "applesauce-common/helpers";

/** The version string written to the `v` field of MIP-04 imeta tags. */
export const MIP04_VERSION = "mip04-v2" as const;

/**
 * MIP-04 media attachment — a {@link FileMetadataFields} extended with the extra
 * fields required by the MIP-04 v2 encryption scheme.
 *
 * Use `createImetaTagForAttachment` from applesauce to serialize this into
 * an `imeta` tag for a group message, and `getFileMetadataFromImetaTag` to
 * parse it back. The `n` and `v` fields are passed through via the imeta
 * name-value pair format defined in NIP-92.
 */
export type MediaAttachment = Omit<FileMetadataFields, "sha256" | "type"> &
  Required<Pick<FileMetadataFields, "sha256" | "type">> & {
    /**
     * Original filename (e.g. `"photo.jpg"`).
     * Used in key derivation and AEAD associated data — must match exactly.
     */
    filename: string;
    /**
     * Hex-encoded 12-byte encryption nonce (24 hex characters).
     * Stored in the `n` field of the `imeta` tag.
     * Generated randomly by `encryptMediaFile` and required for decryption.
     */
    nonce: string;
    /**
     * MIP-04 encryption version. Always `"mip04-v2"` for new attachments.
     * Stored in the `v` field of the `imeta` tag.
     */
    version: typeof MIP04_VERSION;
  };

/**
 * Result of `encryptMediaFile`.
 */
export type EncryptMediaFileResult = {
  /** The encrypted blob. Upload this to Blossom and use `SHA256(encrypted)` as the blob address. */
  encrypted: Uint8Array;
  /**
   * Populated {@link MediaAttachment} ready to be passed to
   * `createImetaTagForAttachment` (after setting the `url` field to the
   * Blossom upload URL).
   *
   * The `sha256` field contains the hex-encoded SHA-256 of the **plaintext**
   * file (the `x` imeta field), used for integrity verification after
   * decryption.
   *
   * The `nonce` field contains the hex-encoded 12-byte nonce used during
   * encryption.
   */
  attachment: MediaAttachment;
};
