/** @module @category Core - Encrypted Media */

// Type model for encrypted-media-v2 attachments.
export {
  ENCRYPTED_MEDIA_VERSION,
  BLOSSOM_LOCATOR_KIND,
  type MediaAttachment,
  type MediaLocator,
  type EncryptMediaFileResult,
} from "./media/types.js";

// MIME canonicalization (the validation helpers stay internal to media/).
export { canonicalizeMimeType } from "./media/canonical.js";

// Security-critical crypto: MLS-exporter→HKDF→ChaCha20 key derivation and the
// randomBytes/cipher AEAD site. Auditable against darkmatter media/crypto.rs.
export {
  deriveMediaEncryptionKey,
  deriveMediaFileKey,
  encryptMediaFile,
  decryptMediaFile,
  decryptMediaFileWithKeys,
} from "./media/crypto.js";

// imeta tag (de)serialization and strict validation.
export {
  encodeMediaImetaTag,
  parseMediaImetaTag,
  getMediaAttachments,
} from "./media/imeta.js";

// Locator fetchability + blob-endpoint fallback resolution.
export {
  SUPPORTED_LOCATOR_KINDS,
  selectFetchableLocators,
  buildFallbackFetchUrls,
  resolveMediaFetchUrls,
  type FetchableLocatorOptions,
} from "./media/locator.js";

/** Frozen historical v1 format. Never use these to send current-profile media. */
export {
  ENCRYPTED_MEDIA_VERSION as ENCRYPTED_MEDIA_VERSION_V1,
  type MediaAttachment as MediaAttachmentV1,
  type MediaLocator as MediaLocatorV1,
  type EncryptMediaFileResult as EncryptMediaFileResultV1,
} from "./media/v1/types.js";
export { canonicalizeMimeType as canonicalizeMimeTypeV1 } from "./media/v1/canonical.js";
export {
  type MediaCryptoFields as MediaCryptoFieldsV1,
  deriveMediaEncryptionKey as deriveMediaEncryptionKeyV1,
  encryptMediaFile as encryptMediaFileV1,
  decryptMediaFile as decryptMediaFileV1,
  decryptMediaFileWithKeys as decryptMediaFileWithKeysV1,
} from "./media/v1/crypto.js";
export {
  encodeMediaImetaTag as encodeMediaImetaTagV1,
  parseMediaImetaTag as parseMediaImetaTagV1,
  getMediaAttachments as getMediaAttachmentsV1,
} from "./media/v1/imeta.js";

export {
  mediaSourceStateToken,
  StaleMediaPreparationError,
} from "./media/source-state.js";

export {
  ENCRYPTED_MEDIA_VERSION as ENCRYPTED_MEDIA_VERSION_V2,
  type MediaAttachment as MediaAttachmentV2,
  type EncryptMediaFileResult as EncryptMediaFileResultV2,
} from "./media/types.js";
export {
  deriveMediaEncryptionKey as deriveMediaEncryptionKeyV2,
  encryptMediaFile as encryptMediaFileV2,
  decryptMediaFile as decryptMediaFileV2,
} from "./media/crypto.js";
export { parseMediaImetaTag as parseMediaImetaTagV2 } from "./media/imeta.js";
export {
  parseHistoricalMediaImetaTag,
  type HistoricalMediaAttachment,
} from "./media/history.js";

export {
  type FetchableLocatorOptions as FetchableLocatorOptionsV1,
  selectFetchableLocators as selectFetchableLocatorsV1,
  buildFallbackFetchUrls as buildFallbackFetchUrlsV1,
  resolveMediaFetchUrls as resolveMediaFetchUrlsV1,
} from "./media/v1/locator.js";
