/** @module @category Core - Encrypted Media */

// Type model for encrypted-media attachments (v1 and v2).
export {
  ENCRYPTED_MEDIA_VERSION,
  ENCRYPTED_MEDIA_VERSION_V1,
  ENCRYPTED_MEDIA_VERSION_V2,
  BLOSSOM_LOCATOR_KIND,
  parseEncryptedMediaVersion,
  type EncryptedMediaVersion,
  type MediaAttachment,
  type MediaLocator,
  type EncryptMediaFileResult,
} from "./media/types.js";

// MIME canonicalization (the validation helpers stay internal to media/).
export {
  canonicalizeMimeType,
  canonicalizeMimeTypeV2,
} from "./media/canonical.js";

// Security-critical crypto: MLS-exporter→HKDF→ChaCha20 key derivation and the
// randomBytes/cipher AEAD site. Auditable against MDK media/crypto.rs.
export {
  deriveMediaEncryptionKey,
  deriveMediaFileKeyFromSecret,
  exportMediaSecret,
  encryptMediaFile,
  decryptMediaFile,
  decryptMediaFileWithKeys,
} from "./media/crypto.js";

// imeta tag (de)serialization and strict validation.
export {
  encodeMediaImetaTag,
  parseMediaImetaTag,
  parseMediaAttachment,
  getMediaAttachments,
  getMediaAttachmentOutcomes,
  MediaAttachmentRejection,
  type MediaAttachmentRejectionKind,
  type MediaAttachmentOutcome,
} from "./media/imeta.js";

// Locator fetchability + blob-endpoint fallback resolution.
export {
  SUPPORTED_LOCATOR_KINDS,
  selectFetchableLocators,
  buildFallbackFetchUrls,
  resolveMediaFetchUrls,
  buildBlossomBlobUrl,
  buildBlossomUploadUrl,
  blossomContentHashFromUrl,
  isSafeBlossomFetchUrl,
  type EncryptedMediaPolicy,
  type FetchableLocatorOptions,
} from "./media/locator.js";
