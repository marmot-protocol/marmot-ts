/** @module @category Core - Encrypted Media */
import {
  canonicalizeMimeType,
  isValidHex,
  validateMediaFilename,
} from "./canonical.js";
import {
  BLOSSOM_LOCATOR_KIND,
  ENCRYPTED_MEDIA_VERSION,
  type MediaAttachment,
  type MediaLocator,
} from "./types.js";

/** Single-occurrence `imeta` field names for `encrypted-media-v2`. */
const SINGLE_FIELDS = [
  "v",
  "ciphertext_sha256",
  "plaintext_sha256",
  "nonce",
  "m",
  "filename",
  "dim",
  "thumbhash",
] as const;

/**
 * Serializes a {@link MediaAttachment} into an `encrypted-media-v2` `imeta`
 * tag array (`features/encrypted-media.md` — Message Shape).
 *
 * Field order follows the spec: `v`, `locator`…, `ciphertext_sha256`,
 * `plaintext_sha256`, `nonce`, `m`, `filename`, optional `dim`, optional
 * `thumbhash`. The attachment MUST carry at least one locator.
 *
 * @param attachment - A populated attachment (locators filled in after upload)
 * @returns A Nostr tag array beginning with `"imeta"`
 */
export function encodeMediaImetaTag(attachment: MediaAttachment): string[] {
  if (attachment.version !== ENCRYPTED_MEDIA_VERSION)
    throw new Error("invalid media version");
  if (attachment.locators.length === 0) {
    throw new Error("encodeMediaImetaTag: attachment has no locators");
  }
  const parts: string[] = ["imeta", `v ${ENCRYPTED_MEDIA_VERSION}`];
  for (const locator of attachment.locators) {
    parts.push(`locator ${locator.kind} ${locator.value}`);
  }
  parts.push(`ciphertext_sha256 ${attachment.ciphertextSha256}`);
  parts.push(`plaintext_sha256 ${attachment.plaintextSha256}`);
  parts.push(`nonce ${attachment.nonce}`);
  parts.push(`m ${attachment.mediaType}`);
  parts.push(`filename ${attachment.filename}`);
  if (attachment.dim !== undefined) parts.push(`dim ${attachment.dim}`);
  if (attachment.thumbhash !== undefined)
    parts.push(`thumbhash ${attachment.thumbhash}`);
  decodeMediaImetaTag(parts);
  return parts;
}

/** Parses one `locator <kind> <value>` field value into a {@link MediaLocator}. */
function parseLocator(value: string): MediaLocator {
  const sp = value.indexOf(" ");
  if (sp <= 0) throw new Error("locator must be '<kind> <value>'");
  const kind = value.slice(0, sp);
  const locValue = value.slice(sp + 1);
  if (kind.length === 0) throw new Error("locator kind must not be empty");
  if (locValue.length === 0) throw new Error("locator value must not be empty");
  if (!URL.canParse(locValue))
    throw new Error("locator value must parse as a URL");
  if (kind === BLOSSOM_LOCATOR_KIND) {
    const url = new URL(locValue);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("blossom locator must use http or https");
  }
  return { kind, value: locValue };
}

/** Strict v2 reference validation. Contact policy is applied only before I/O. */
function decodeMediaImetaTag(tag: string[]): MediaAttachment {
  if (tag[0] !== "imeta") throw new Error("not an imeta tag");

  const single = new Map<string, string>();
  const locators: MediaLocator[] = [];

  for (const part of tag.slice(1)) {
    const sp = part.indexOf(" ");
    const key = sp === -1 ? part : part.slice(0, sp);
    const value = sp === -1 ? "" : part.slice(sp + 1);

    if (
      sp === -1 &&
      (key === "locator" || (SINGLE_FIELDS as readonly string[]).includes(key))
    )
      throw new Error("media field is missing its value");
    if (key === "blurhash") {
      throw new Error("blurhash is invalid in encrypted-media-v2");
    }
    if (key === "locator") {
      locators.push(parseLocator(value));
      continue;
    }
    if ((SINGLE_FIELDS as readonly string[]).includes(key)) {
      if (single.has(key)) {
        throw new Error(`duplicate single-occurrence field: ${key}`);
      }
      single.set(key, value);
    }
    // Unknown fields are ignored (only blurhash is explicitly forbidden).
  }

  if (single.get("v") !== ENCRYPTED_MEDIA_VERSION) {
    throw new Error("missing or non-encrypted-media-v2 version");
  }
  if (locators.length === 0) throw new Error("no locator present");

  const ciphertextSha256 = single.get("ciphertext_sha256");
  const plaintextSha256 = single.get("plaintext_sha256");
  const nonce = single.get("nonce");
  const mediaTypeRaw = single.get("m");
  const filename = single.get("filename");

  if (!ciphertextSha256 || !isValidHex(ciphertextSha256, 32))
    throw new Error("ciphertext_sha256 must be a 32-byte hex value");
  if (!plaintextSha256 || !isValidHex(plaintextSha256, 32))
    throw new Error("plaintext_sha256 must be a 32-byte hex value");
  if (!nonce || !isValidHex(nonce, 12))
    throw new Error("nonce must be 24 hex characters");
  if (!mediaTypeRaw) throw new Error("m (media type) is required");
  if (!filename) throw new Error("filename is required");

  // Canonicalize the media type (also rejects an empty / slash-less value).
  const mediaType = canonicalizeMimeType(mediaTypeRaw);
  if (mediaType !== mediaTypeRaw) throw new Error("non-canonical media type");
  validateMediaFilename(filename);

  return {
    version: ENCRYPTED_MEDIA_VERSION,
    locators,
    ciphertextSha256,
    plaintextSha256,
    nonce,
    mediaType,
    filename,
    ...(single.has("dim") ? { dim: single.get("dim")! } : {}),
    ...(single.has("thumbhash") ? { thumbhash: single.get("thumbhash")! } : {}),
  };
}

/**
 * Parse one v2 reference. Invalid references are attachment-local: retain the
 * carrying caption and all valid sibling attachments.
 */
export function parseMediaImetaTag(tag: string[]): MediaAttachment | null {
  try {
    return decodeMediaImetaTag(tag);
  } catch {
    return null;
  }
}

/**
 * Extracts all valid `encrypted-media-v2` attachments from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped.
 *
 * @param tags - The `tags` array from a Nostr event or rumor
 * @returns Array of valid {@link MediaAttachment} objects (may be empty)
 */
export function getMediaAttachments(tags: string[][]): MediaAttachment[] {
  return tags
    .filter((t) => t[0] === "imeta")
    .map(parseMediaImetaTag)
    .filter((a): a is MediaAttachment => a !== null);
}
