/** @module @category Core - Encrypted Media */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { expand as hkdf_expand } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import { mlsExporter, type CiphersuiteImpl, type ClientState } from "ts-mls";
import type { FileMetadataFields } from "applesauce-common/helpers";
import { canonicalizeMimeType } from "./canonical.js";
import {
  MIP04_VERSION,
  type EncryptMediaFileResult,
  type MediaAttachment,
} from "./types.js";

const enc = new TextEncoder();

/** Scheme label used in all MIP-04 v2 cryptographic contexts. */
const MIP04_V2_SCHEME = enc.encode("mip04-v2");

/** MLS exporter label and context used to obtain the base exporter secret. */
const MLS_EXPORTER_LABEL = "marmot";
const MLS_EXPORTER_CONTEXT = enc.encode("encrypted-media");

/**
 * Builds the ChaCha20-Poly1305 AAD for MIP-04 v2 from a {@link MediaAttachment}.
 *
 * @internal
 */
function buildMip04Aad(attachment: MediaAttachment): Uint8Array {
  const fileHashBytes = hexToBytes(attachment.sha256!);
  const canonicalMime = enc.encode(canonicalizeMimeType(attachment.type!));
  const filenameBytes = enc.encode(attachment.filename);
  const sep = new Uint8Array([0x00]);

  // aad = "mip04-v2" || 0x00 || file_hash_bytes || 0x00 || mime_type_bytes || 0x00 || filename_bytes
  return concatBytes(
    MIP04_V2_SCHEME,
    sep,
    fileHashBytes,
    sep,
    canonicalMime,
    sep,
    filenameBytes,
  );
}

/**
 * Derives the per-file encryption key for a media file shared in a group
 * message (MIP-04 v2).
 *
 * Key derivation:
 * ```
 * exporter_secret = MLS-Exporter("marmot", "encrypted-media", 32)
 * context = "mip04-v2" || 0x00 || file_hash_bytes || 0x00 ||
 *           mime_type_bytes || 0x00 || filename_bytes || 0x00 || "key"
 * file_key = HKDF-Expand(exporter_secret, context, 32)
 * ```
 *
 * The key is deterministic for a given epoch + file, so re-encrypting the
 * same file in the same epoch produces the same key but a different
 * ciphertext (due to the random nonce).
 *
 * The `sha256`, `type`, and `filename` fields of the attachment must be set.
 * The MIME type is canonicalized automatically.
 *
 * @param clientState - The current MLS `ClientState` for the group
 * @param ciphersuite - The ciphersuite implementation used by the group
 * @param attachment - The attachment containing `sha256`, `type`, and `filename`
 * @returns 32-byte ChaCha20-Poly1305 encryption key
 */
export async function deriveMediaEncryptionKey(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
  attachment: Pick<MediaAttachment, "sha256" | "type" | "filename">,
): Promise<Uint8Array> {
  if (!attachment.sha256) throw new Error("attachment.sha256 is required");
  if (!attachment.type) throw new Error("attachment.type is required");

  const exporterSecret = await mlsExporter(
    clientState.keySchedule.exporterSecret,
    MLS_EXPORTER_LABEL,
    MLS_EXPORTER_CONTEXT,
    32,
    ciphersuite,
  );

  const fileHashBytes = hexToBytes(attachment.sha256);
  const canonicalMime = enc.encode(canonicalizeMimeType(attachment.type));
  const filenameBytes = enc.encode(attachment.filename);
  const sep = new Uint8Array([0x00]);

  const context = concatBytes(
    MIP04_V2_SCHEME,
    sep,
    fileHashBytes,
    sep,
    canonicalMime,
    sep,
    filenameBytes,
    sep,
    enc.encode("key"),
  );

  return hkdf_expand(sha256, exporterSecret, context, 32);
}

/**
 * Encrypts a media file for sharing in a Marmot group message (MIP-04 v2).
 *
 * Uses ChaCha20-Poly1305 AEAD with a randomly generated nonce. The
 * associated data (AAD) binds the scheme version, file hash, MIME type, and
 * filename to prevent metadata tampering.
 *
 * Typical usage:
 * ```ts
 * import { sha256 } from "@noble/hashes/sha2";
 * import { bytesToHex } from "@noble/hashes/utils";
 * import { createImetaTagForAttachment } from "applesauce-common/helpers";
 *
 * const attachment: Mip04MediaAttachment = {
 *   sha256: bytesToHex(sha256(fileBytes)),
 *   type: "image/jpeg",
 *   filename: "photo.jpg",
 *   nonce: "",          // filled by encryptMediaFile
 *   version: MIP04_VERSION,
 * };
 * const fileKey = await deriveMip04FileKey(clientState, ciphersuite, attachment);
 * const { encrypted, attachment: filled } = encryptMediaFile(fileBytes, fileKey, attachment);
 * // Upload `encrypted` to Blossom, then:
 * const imetaTag = createImetaTagForAttachment({ ...filled, url: blossomUrl });
 * ```
 *
 * @param file - The plaintext file bytes to encrypt
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param attachment - Attachment metadata; must have `sha256`, `type`, and `filename` set
 * @returns Encrypted blob and a fully populated {@link MediaAttachment}
 */
export function encryptMediaFile(
  file: Uint8Array,
  fileKey: Uint8Array,
  attachment: Pick<MediaAttachment, "sha256" | "type" | "filename"> &
    Partial<FileMetadataFields>,
): EncryptMediaFileResult {
  if (!attachment.sha256) throw new Error("attachment.sha256 is required");
  if (!attachment.type) throw new Error("attachment.type is required");

  const full: MediaAttachment = {
    ...attachment,
    filename: attachment.filename,
    type: canonicalizeMimeType(attachment.type),
    sha256: attachment.sha256,
    nonce: "", // filled below
    version: MIP04_VERSION,
  };

  const nonce = randomBytes(12);
  full.nonce = bytesToHex(nonce);

  const aad = buildMip04Aad(full);
  const encrypted = chacha20poly1305(fileKey, nonce, aad).encrypt(file);

  return { encrypted, attachment: full };
}

/**
 * Decrypts a media file received in a Marmot group message (MIP-04 v2).
 *
 * Verifies the ChaCha20-Poly1305 authentication tag and then confirms the
 * SHA-256 of the decrypted content matches the `sha256` field from the
 * attachment, as required by MIP-04.
 *
 * The `sha256`, `type`, `filename`, and `nonce` fields must all be present.
 * Parse these from the `imeta` tag using `getFileMetadataFromImetaTag` from
 * applesauce, then cast/extend to {@link MediaAttachment}.
 *
 * @param encrypted - The encrypted blob downloaded from Blossom
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param attachment - The MIP-04 attachment from the group message's `imeta` tag
 * @returns The decrypted file bytes
 * @throws If AEAD authentication fails, required fields are missing, or the
 *         decrypted content hash does not match `attachment.sha256`
 */
export function decryptMediaFile(
  encrypted: Uint8Array,
  fileKey: Uint8Array,
  attachment: MediaAttachment,
): Uint8Array {
  if (!attachment.sha256) throw new Error("attachment.sha256 is required");
  if (!attachment.type) throw new Error("attachment.type is required");
  if (!attachment.nonce) throw new Error("attachment.nonce is required");

  const nonce = hexToBytes(attachment.nonce);
  if (nonce.length !== 12) {
    throw new Error(
      `attachment.nonce must be 24 hex characters (12 bytes), got ${attachment.nonce.length} characters`,
    );
  }

  const aad = buildMip04Aad(attachment);
  const decrypted = chacha20poly1305(fileKey, nonce, aad).decrypt(encrypted);

  // MIP-04 §Integrity Verification: SHA256(decrypted_content) MUST equal sha256 field
  if (!equalBytes(sha256(decrypted), hexToBytes(attachment.sha256))) {
    throw new Error(
      "MIP-04 integrity check failed: decrypted content hash does not match expected hash",
    );
  }

  return decrypted;
}
