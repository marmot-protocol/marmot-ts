/** @module @category Core - Encrypted Media */

// Type model for encrypted-media-v1 attachments.
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
  encryptMediaFile,
  decryptMediaFile,
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
