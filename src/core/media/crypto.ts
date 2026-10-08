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
import { canonicalizeMimeType, canonicalizeMimeTypeV2 } from "./canonical.js";
import {
  ENCRYPTED_MEDIA_VERSION_V1,
  ENCRYPTED_MEDIA_VERSION_V2,
  type EncryptedMediaVersion,
  type EncryptMediaFileResult,
  type MediaAttachment,
  parseEncryptedMediaVersion,
} from "./types.js";

const enc = new TextEncoder();
const SEP = new Uint8Array([0x00]);

/** MLS exporter label and context used to obtain the base media secret. */
const MLS_EXPORTER_LABEL = "marmot";
const MLS_EXPORTER_CONTEXT = enc.encode("encrypted-media");

/**
 * The crypto-relevant subset of a {@link MediaAttachment}. `version` selects
 * the scheme label and validation profile; when omitted it defaults to
 * `encrypted-media-v1` so pre-v2 callers keep their exact behaviour.
 */
type MediaCryptoFields = Pick<
  MediaAttachment,
  "plaintextSha256" | "mediaType" | "filename"
> & { version?: EncryptedMediaVersion };

/** Resolves and checks the media version of a crypto input. @internal */
function versionOf(fields: { version?: string }): EncryptedMediaVersion {
  if (fields.version === undefined) return ENCRYPTED_MEDIA_VERSION_V1;
  const version = parseEncryptedMediaVersion(fields.version);
  if (!version) {
    throw new Error(
      `unsupported encrypted media version: ${JSON.stringify(fields.version)}`,
    );
  }
  return version;
}

/**
 * Throws unless `filename` satisfies the version's filename profile. v2:
 * 1..255 UTF-8 bytes with no U+0000, preserved exactly. v1: non-empty after
 * trimming (MDK `validate_outbound_file_name`).
 *
 * @internal
 */
export function assertMediaFilename(
  filename: string,
  version: EncryptedMediaVersion,
): void {
  if (version === ENCRYPTED_MEDIA_VERSION_V2) {
    const len = enc.encode(filename).length;
    if (len === 0 || len > 255 || filename.includes("\0")) {
      throw new Error(
        "media file name must be 1..255 UTF-8 bytes and contain no NUL",
      );
    }
  } else if (filename.trim().length === 0) {
    throw new Error("media file name cannot be empty");
  }
}

/**
 * The media-type bytes that feed key derivation and the AAD. v1 canonicalizes
 * the given value; v2 requires it to already be canonical and never repairs it
 * (`features/encrypted-media.md` "Media Type Canonicalization").
 *
 * @internal
 */
function cryptoMediaType(
  mediaType: string,
  version: EncryptedMediaVersion,
): string {
  if (version === ENCRYPTED_MEDIA_VERSION_V1)
    return canonicalizeMimeType(mediaType);
  if (canonicalizeMimeTypeV2(mediaType) !== mediaType) {
    throw new Error("media type is not canonical for encrypted-media-v2");
  }
  return mediaType;
}

/**
 * Builds the `0x00`-separated field block shared by the key-derivation context
 * and the AEAD AAD: `plaintext_sha256_bytes || 0x00 || media_type || 0x00 ||
 * filename`. No length prefixes are used.
 *
 * @internal
 */
function mediaFieldBlock(fields: MediaCryptoFields): Uint8Array {
  if (!fields.plaintextSha256)
    throw new Error("attachment.plaintextSha256 is required");
  if (!fields.mediaType) throw new Error("attachment.mediaType is required");
  const version = versionOf(fields);
  if (version === ENCRYPTED_MEDIA_VERSION_V2)
    assertMediaFilename(fields.filename, version);

  const plaintextHashBytes = hexToBytes(fields.plaintextSha256);
  if (plaintextHashBytes.length !== 32)
    throw new Error("attachment.plaintextSha256 must be 32 bytes");
  const canonicalMime = enc.encode(cryptoMediaType(fields.mediaType, version));
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
 * Builds the ChaCha20-Poly1305 AAD:
 * `version || 0x00 || plaintext_sha256_bytes || 0x00 || media_type || 0x00 ||
 * filename`, where `version` is `"encrypted-media-v1"` or
 * `"encrypted-media-v2"`.
 *
 * @internal
 */
function buildAad(fields: MediaCryptoFields): Uint8Array {
  return concatBytes(
    enc.encode(versionOf(fields)),
    SEP,
    mediaFieldBlock(fields),
  );
}

/**
 * Derives the per-file encryption key for an encrypted-media attachment.
 *
 * ```
 * media_secret = MLS-Exporter("marmot", "encrypted-media", 32) at source_epoch
 * file_key     = HKDF-Expand(media_secret,
 *                  version || 0x00 || plaintext_sha256_bytes ||
 *                  0x00 || media_type || 0x00 || filename || 0x00 || "key", 32)
 * ```
 *
 * `version` is `attachment.version` (`"encrypted-media-v1"` when omitted, or
 * `"encrypted-media-v2"`). The exporter secret is the same for both versions.
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
 * @param attachment - Provides `version`, `plaintextSha256`, `mediaType`, and
 *   `filename`
 * @returns 32-byte ChaCha20-Poly1305 encryption key
 */
export async function deriveMediaEncryptionKey(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
  attachment: MediaCryptoFields,
): Promise<Uint8Array> {
  const mediaSecret = await exportMediaSecret(clientState, ciphersuite);
  return deriveMediaFileKeyFromSecret(mediaSecret, attachment);
}

/**
 * Derives the per-file key from an already-exported 32-byte media secret
 * (`MLS-Exporter("marmot", "encrypted-media", 32)` at the source epoch). This is
 * the HKDF-Expand half of {@link deriveMediaEncryptionKey}, exposed so callers
 * that cache media secrets per epoch (as MDK does) can derive keys without the
 * `ClientState`, and so the derivation can be checked against fixed vectors.
 *
 * @param mediaSecret - 32-byte media exporter secret for the source epoch
 * @param attachment - Provides `version`, `plaintextSha256`, `mediaType`, `filename`
 */
export function deriveMediaFileKeyFromSecret(
  mediaSecret: Uint8Array,
  attachment: MediaCryptoFields,
): Uint8Array {
  // info = version || 0x00 || plaintext_sha256 || 0x00 || media_type || 0x00 ||
  //        filename || 0x00 || "key"
  const info = concatBytes(
    enc.encode(versionOf(attachment)),
    SEP,
    mediaFieldBlock(attachment),
    SEP,
    enc.encode("key"),
  );

  return hkdf_expand(sha256, mediaSecret, info, 32);
}

/**
 * Exports the group media secret `MLS-Exporter("marmot", "encrypted-media",
 * 32)` for `clientState`'s epoch. Key material: never log or transmit it.
 */
export async function exportMediaSecret(
  clientState: ClientState,
  ciphersuite: CiphersuiteImpl,
): Promise<Uint8Array> {
  return mlsExporter(
    clientState.keySchedule.exporterSecret,
    MLS_EXPORTER_LABEL,
    MLS_EXPORTER_CONTEXT,
    32,
    ciphersuite,
  );
}

/**
 * Encrypts a media file for an encrypted-media attachment.
 *
 * Uses ChaCha20-Poly1305 AEAD with a fresh random 12-byte nonce. The AAD binds
 * the format version, plaintext hash, canonical MIME type, and filename.
 * Computes `ciphertextSha256 = SHA256(encrypted)` and returns a
 * {@link MediaAttachment} with `locators` left empty for the caller to fill
 * after upload.
 *
 * @param file - The plaintext file bytes to encrypt
 * @param fileKey - 32-byte key from {@link deriveMediaEncryptionKey}, derived
 *   for the same `version`, hash, media type and filename
 * @param fields - Provides `plaintextSha256`, `mediaType`, `filename`, and
 *   `version` (default `encrypted-media-v1`); optional `dim`/`thumbhash` are
 *   carried through onto the result. For v2 the media type is canonicalized
 *   with the v2 algorithm before use and the filename profile is enforced.
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

  const version = versionOf(fields);
  assertMediaFilename(fields.filename, version);
  const mediaType =
    version === ENCRYPTED_MEDIA_VERSION_V2
      ? canonicalizeMimeTypeV2(fields.mediaType)
      : canonicalizeMimeType(fields.mediaType);
  const nonce = randomBytes(12);
  const aad = buildAad({ ...fields, version, mediaType });
  const encrypted = chacha20poly1305(fileKey, nonce, aad).encrypt(file);

  const attachment: MediaAttachment = {
    version,
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
      `${versionOf(attachment)} integrity check failed: ciphertext hash does not match ciphertext_sha256`,
    );
  }

  return { nonce, aad: buildAad(attachment) };
}

/**
 * AEAD-opens a verified encrypted-media blob with one candidate key and
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
  version: EncryptedMediaVersion,
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
      `${version} integrity check failed: plaintext hash does not match plaintext_sha256`,
    );
  }

  return decrypted;
}

/**
 * Decrypts a fetched encrypted-media blob (v1 or v2, per `attachment.version`).
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
    versionOf(attachment),
  );
  if (!decrypted) {
    throw new Error(
      `${versionOf(attachment)} decryption failed: ciphertext did not authenticate under the supplied key`,
    );
  }
  return decrypted;
}

/**
 * Decrypts a fetched encrypted-media blob, trying each candidate key in
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
      versionOf(attachment),
    );
    if (decrypted) return decrypted;
  }

  throw new Error(
    `${versionOf(attachment)} decryption failed: ciphertext did not authenticate under any retained epoch key`,
  );
}
