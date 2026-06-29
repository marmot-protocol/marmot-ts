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
import { canonicalizeMimeType } from "./canonical.js";
import {
  ENCRYPTED_MEDIA_VERSION,
  type EncryptMediaFileResult,
  type MediaAttachment,
} from "./types.js";

const enc = new TextEncoder();

/** Scheme label used in all `encrypted-media-v1` cryptographic contexts. */
const SCHEME = enc.encode(ENCRYPTED_MEDIA_VERSION);
const SEP = new Uint8Array([0x00]);

/** MLS exporter label and context used to obtain the base media secret. */
const MLS_EXPORTER_LABEL = "marmot";
const MLS_EXPORTER_CONTEXT = enc.encode("encrypted-media");

/** The crypto-relevant subset of a {@link MediaAttachment}. */
type MediaCryptoFields = Pick<
  MediaAttachment,
  "plaintextSha256" | "mediaType" | "filename"
>;

/**
 * Builds the `0x00`-separated field block shared by the key-derivation context
 * and the AEAD AAD: `plaintext_sha256_bytes || 0x00 || media_type || 0x00 ||
 * filename`. The MIME type is canonicalized; no length prefixes are used.
 *
 * @internal
 */
function mediaFieldBlock(fields: MediaCryptoFields): Uint8Array {
  if (!fields.plaintextSha256)
    throw new Error("attachment.plaintextSha256 is required");
  if (!fields.mediaType) throw new Error("attachment.mediaType is required");

  const plaintextHashBytes = hexToBytes(fields.plaintextSha256);
  const canonicalMime = enc.encode(canonicalizeMimeType(fields.mediaType));
  const filenameBytes = enc.encode(fields.filename);

  return concatBytes(
    plaintextHashBytes,
    SEP,
    canonicalMime,
    SEP,
    filenameBytes,
  );
}

/**
 * Builds the ChaCha20-Poly1305 AAD for `encrypted-media-v1`:
 * `"encrypted-media-v1" || 0x00 || plaintext_sha256_bytes || 0x00 ||
 * media_type || 0x00 || filename`.
 *
 * @internal
 */
function buildAad(fields: MediaCryptoFields): Uint8Array {
  return concatBytes(SCHEME, SEP, mediaFieldBlock(fields));
}

/**
 * Derives the per-file encryption key for an `encrypted-media-v1` attachment.
 *
 * ```
 * media_secret = MLS-Exporter("marmot", "encrypted-media", 32) at source_epoch
 * file_key     = HKDF-Expand(media_secret,
 *                  "encrypted-media-v1" || 0x00 || plaintext_sha256_bytes ||
 *                  0x00 || media_type || 0x00 || filename || 0x00 || "key", 32)
 * ```
 *
 * HKDF is HKDF-SHA256 with `media_secret` used directly as the PRK (Expand
 * only, no Extract). The key is deterministic for a given source epoch + file.
 *
 * The source epoch is the MLS epoch of the application message that carried the
 * attachment. The caller MUST pass the `ClientState` for that epoch: on send,
 * the current state; on receive, the retained state for the message's source
 * epoch (see `features/encrypted-media.md` — Key Derivation).
 *
 * @param clientState - The MLS `ClientState` for the attachment's source epoch
 * @param ciphersuite - The ciphersuite implementation used by the group
 * @param attachment - Provides `plaintextSha256`, `mediaType`, and `filename`
 * @returns 32-byte ChaCha20-Poly1305 encryption key
 */
export async function deriveMediaEncryptionKey(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
  attachment: MediaCryptoFields,
): Promise<Uint8Array> {
  const mediaSecret = await mlsExporter(
    clientState.keySchedule.exporterSecret,
    MLS_EXPORTER_LABEL,
    MLS_EXPORTER_CONTEXT,
    32,
    ciphersuite,
  );

  // info = scheme || 0x00 || plaintext_sha256 || 0x00 || media_type || 0x00 ||
  //        filename || 0x00 || "key"
  const info = concatBytes(
    SCHEME,
    SEP,
    mediaFieldBlock(attachment),
    SEP,
    enc.encode("key"),
  );

  return hkdf_expand(sha256, mediaSecret, info, 32);
}

/**
 * Encrypts a media file for an `encrypted-media-v1` attachment.
 *
 * Uses ChaCha20-Poly1305 AEAD with a random 12-byte nonce. The AAD binds the
 * scheme version, plaintext hash, canonical MIME type, and filename. Computes
 * `ciphertextSha256 = SHA256(encrypted)` and returns a {@link MediaAttachment}
 * with `locators` left empty for the caller to fill after upload.
 *
 * @param file - The plaintext file bytes to encrypt
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param fields - Provides `plaintextSha256`, `mediaType`, and `filename`;
 *   optional `dim`/`thumbhash` are carried through onto the result
 * @returns Encrypted blob and a populated {@link MediaAttachment}
 */
export function encryptMediaFile(
  file: Uint8Array,
  fileKey: Uint8Array,
  fields: MediaCryptoFields &
    Pick<Partial<MediaAttachment>, "dim" | "thumbhash">,
): EncryptMediaFileResult {
  if (!fields.plaintextSha256)
    throw new Error("attachment.plaintextSha256 is required");
  if (!fields.mediaType) throw new Error("attachment.mediaType is required");

  const mediaType = canonicalizeMimeType(fields.mediaType);
  const nonce = randomBytes(12);
  const aad = buildAad({ ...fields, mediaType });
  const encrypted = chacha20poly1305(fileKey, nonce, aad).encrypt(file);

  const attachment: MediaAttachment = {
    version: ENCRYPTED_MEDIA_VERSION,
    locators: [],
    ciphertextSha256: bytesToHex(sha256(encrypted)),
    plaintextSha256: fields.plaintextSha256,
    nonce: bytesToHex(nonce),
    mediaType,
    filename: fields.filename,
    ...(fields.dim !== undefined ? { dim: fields.dim } : {}),
    ...(fields.thumbhash !== undefined ? { thumbhash: fields.thumbhash } : {}),
  };

  return { encrypted, attachment };
}

/**
 * Validates the receive-side fields, decodes the nonce, and verifies the
 * fetched bytes match `ciphertextSha256` — the key-independent checks shared by
 * the single-key and multi-key decrypt paths.
 *
 * @internal
 * @returns The decoded 12-byte nonce and the AEAD AAD
 */
function prepareMediaDecrypt(
  encrypted: Uint8Array,
  attachment: MediaAttachment,
): { nonce: Uint8Array; aad: Uint8Array } {
  if (!attachment.plaintextSha256)
    throw new Error("attachment.plaintextSha256 is required");
  if (!attachment.ciphertextSha256)
    throw new Error("attachment.ciphertextSha256 is required");
  if (!attachment.mediaType)
    throw new Error("attachment.mediaType is required");
  if (!attachment.nonce) throw new Error("attachment.nonce is required");

  const nonce = hexToBytes(attachment.nonce);
  if (nonce.length !== 12) {
    throw new Error(
      `attachment.nonce must be 24 hex characters (12 bytes), got ${attachment.nonce.length} characters`,
    );
  }

  // Ciphertext integrity: fetched bytes MUST match ciphertext_sha256. This is
  // key-independent, so it runs once even when multiple candidate keys follow.
  if (!equalBytes(sha256(encrypted), hexToBytes(attachment.ciphertextSha256))) {
    throw new Error(
      "encrypted-media-v1 integrity check failed: ciphertext hash does not match ciphertext_sha256",
    );
  }

  return { nonce, aad: buildAad(attachment) };
}

/**
 * AEAD-opens a verified `encrypted-media-v1` blob with one candidate key and
 * checks the plaintext hash. Returns the plaintext on success, or `undefined`
 * when the key fails authentication (the caller may try another epoch's key).
 * A successful AEAD open whose plaintext hash mismatches is a genuine integrity
 * failure and throws.
 *
 * @internal
 */
function openMediaFile(
  encrypted: Uint8Array,
  fileKey: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintextSha256: string,
): Uint8Array | undefined {
  let decrypted: Uint8Array;
  try {
    decrypted = chacha20poly1305(fileKey, nonce, aad).decrypt(encrypted);
  } catch {
    // ChaCha20-Poly1305 authentication failed — wrong key for this ciphertext.
    return undefined;
  }

  // The AEAD tag authenticated, so this is the right key; the plaintext hash
  // MUST match. A mismatch here is corruption, not a wrong-key signal.
  if (!equalBytes(sha256(decrypted), hexToBytes(plaintextSha256))) {
    throw new Error(
      "encrypted-media-v1 integrity check failed: plaintext hash does not match plaintext_sha256",
    );
  }

  return decrypted;
}

/**
 * Decrypts a fetched `encrypted-media-v1` blob.
 *
 * Performs the receive-side integrity checks in order
 * (`features/encrypted-media.md` — Validation):
 *
 * 1. the fetched bytes match `ciphertextSha256`
 * 2. ChaCha20-Poly1305 authentication succeeds
 * 3. the decrypted bytes match `plaintextSha256`
 *
 * @param encrypted - The encrypted blob downloaded from a blob store
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}
 * @param attachment - The parsed attachment from the message's `imeta` tag
 * @returns The decrypted file bytes
 * @throws If any integrity check fails or required fields are missing
 */
export function decryptMediaFile(
  encrypted: Uint8Array,
  fileKey: Uint8Array,
  attachment: MediaAttachment,
): Uint8Array {
  const { nonce, aad } = prepareMediaDecrypt(encrypted, attachment);
  const decrypted = openMediaFile(
    encrypted,
    fileKey,
    nonce,
    aad,
    attachment.plaintextSha256,
  );
  if (!decrypted) {
    throw new Error(
      "encrypted-media-v1 decryption failed: ciphertext did not authenticate under the supplied key",
    );
  }
  return decrypted;
}

/**
 * Decrypts a fetched `encrypted-media-v1` blob, trying each candidate key in
 * order until one authenticates the ciphertext.
 *
 * The media file key is derived from the source-epoch media exporter secret
 * (`features/encrypted-media.md` — Key Derivation), but the source epoch is not
 * carried in the `imeta` tag. Rather than thread the source epoch through every
 * caller, the receiver supplies one key per still-retained epoch (current epoch
 * first) and relies on the AEAD tag to identify the right one. The ciphertext
 * hash is verified once; only the cheap AEAD open is retried per key.
 *
 * @param encrypted - The encrypted blob downloaded from a blob store
 * @param fileKeys - Candidate keys from {@link deriveMediaEncryptionKey}, one
 *   per retained epoch; tried in order. MUST be non-empty.
 * @param attachment - The parsed attachment from the message's `imeta` tag
 * @returns The decrypted file bytes from the first key that authenticates
 * @throws If no candidate key authenticates the ciphertext, or a check fails
 */
export function decryptMediaFileWithKeys(
  encrypted: Uint8Array,
  fileKeys: Uint8Array[],
  attachment: MediaAttachment,
): Uint8Array {
  if (fileKeys.length === 0)
    throw new Error("decryptMediaFileWithKeys: at least one key is required");

  const { nonce, aad } = prepareMediaDecrypt(encrypted, attachment);

  for (const fileKey of fileKeys) {
    const decrypted = openMediaFile(
      encrypted,
      fileKey,
      nonce,
      aad,
      attachment.plaintextSha256,
    );
    if (decrypted) return decrypted;
  }

  throw new Error(
    "encrypted-media-v1 decryption failed: ciphertext did not authenticate under any retained epoch key",
  );
}
