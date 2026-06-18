/** @module @category Core - Encrypted Media */

// Type model for MIP-04 v2 media attachments.
export {
  MIP04_VERSION,
  type MediaAttachment,
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

// NIP-92 / NIP-94 imeta tag read I/O.
export {
  parseMediaImetaTag,
  getMediaAttachments,
  getMediaAttachmentFromFileEvent,
} from "./media/imeta.js";
