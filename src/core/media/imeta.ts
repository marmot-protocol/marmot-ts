/** @module @category Core - Encrypted Media */
import {
  getFileMetadataFromImetaTag,
  parseFileMetadataTags,
} from "applesauce-common/helpers";
import type { NostrEvent } from "applesauce-core/helpers";
import { isValidHex, isValidMimeType } from "./canonical.js";
import { MIP04_VERSION, type MediaAttachment } from "./types.js";

/**
 * Splits the space-separated entries of an `imeta` tag into a key→value map.
 *
 * Each entry after the leading `"imeta"` element has the form `"key value"`.
 * applesauce uses the same approach internally; we replicate it here to
 * extract MIP-04-specific fields (`filename`, `n`, `v`) that applesauce does
 * not know about and therefore silently drops from its returned
 * {@link FileMetadata} object.
 *
 * @internal
 */
function parseRawImetaEntries(tag: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of tag.slice(1)) {
    const match = part.match(/^(.+?)\s(.+)$/);
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

/**
 * Parses an `imeta` tag array into a {@link MediaAttachment}.
 *
 * The MIP-04-specific fields (`filename`, `n`, `v`) are read directly from
 * the raw tag entries because applesauce's {@link getFileMetadataFromImetaTag}
 * only copies known NIP-92 fields and silently drops unknown keys. Standard
 * NIP-92 fields (`url`, `type`/`m`, `sha256`/`x`, `size`, `dimensions`/`dim`,
 * `blurhash`, `thumbnail`/`thumb`, `alt`, etc.) are delegated to applesauce.
 *
 * Returns `null` if:
 * - The tag is not a valid `imeta` tag (first element is not `"imeta"`)
 * - The `v` field is absent or does not match {@link MIP04_VERSION}
 * - The `n` (nonce) field is absent or is not exactly 24 characters (hex-encoded 12-byte nonce)
 * - The `filename` field is absent or empty
 * - The `x` (sha256) field is absent or is not exactly 64 characters (hex-encoded 32-byte hash)
 * - The `m` (MIME type) field is absent or is not a valid `type/subtype` string
 *
 * Per the MIP-04 spec, clients MUST reject deprecated `mip04-v1` tags.
 *
 * @param tag - A raw `imeta` tag array from a Nostr event (e.g. `rumor.tags`)
 * @returns A fully-typed {@link MediaAttachment}, or `null` if the tag is
 *   not a valid MIP-04 v2 attachment
 */
export function parseMediaImetaTag(tag: string[]): MediaAttachment | null {
  if (tag[0] !== "imeta") return null;

  // Parse raw entries to read MIP-04 fields that applesauce strips.
  const raw = parseRawImetaEntries(tag);

  const version = raw.get("v");
  const nonce = raw.get("n");
  const filename = raw.get("filename");

  if (version !== MIP04_VERSION) return null;
  if (!nonce || !isValidHex(nonce, 12)) return null;
  if (!filename || filename.length === 0) return null;

  // Delegate standard NIP-92 field parsing to applesauce.
  const base = getFileMetadataFromImetaTag(tag);

  if (!base.sha256 || !isValidHex(base.sha256, 32)) return null;
  // m must be a valid MIME type
  if (!base.type || !isValidMimeType(base.type)) return null;

  return {
    ...base,
    sha256: base.sha256,
    type: base.type,
    filename,
    nonce,
    version: MIP04_VERSION,
  };
}

/**
 * Extracts all valid MIP-04 v2 attachments from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail MIP-04 validation (wrong or
 * absent `v` field, missing `n`/`filename`) are silently skipped.
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

/**
 * Extracts a MIP-04 v2 attachment from a NIP-94 kind 1063 file-metadata event.
 *
 * Kind 1063 events use flat tags (`url`, `m`, `x`, `filename`, `n`, `v`, …)
 * rather than the space-separated `imeta` format. Standard NIP-94 fields are
 * parsed by applesauce's {@link parseFileMetadataTags}; the MIP-04-specific fields
 * (`filename`, `n`, `v`) are read directly from the flat tag list.
 *
 * Returns `null` if:
 * - The `v` tag is absent or does not match {@link MIP04_VERSION}
 * - The `n` (nonce) tag is absent or is not exactly 24 characters (hex-encoded 12-byte nonce)
 * - The `filename` tag is absent or empty
 * - The `x` (sha256) tag is absent or is not exactly 64 characters (hex-encoded 32-byte hash)
 * - The `m` (MIME type) tag is absent or is not a valid `type/subtype` string
 *
 * @param event - A kind 1063 Nostr event
 * @returns A fully-typed {@link MediaAttachment}, or `null` if the event
 *   does not carry a valid MIP-04 v2 attachment
 */
export function getMediaAttachmentFromFileEvent(
  event: NostrEvent,
): MediaAttachment | null {
  /** Helper: return the value of the first tag with the given name, or undefined. */
  const getTag = (name: string): string | undefined =>
    event.tags.find((t) => t[0] === name)?.[1];

  const version = getTag("v");
  const nonce = getTag("n");
  const filename = getTag("filename");

  if (version !== MIP04_VERSION) return null;
  if (!nonce || !isValidHex(nonce, 12)) return null;
  if (!filename || filename.length === 0) return null;

  // Delegate standard NIP-94 tag parsing to applesauce. Parse the flat tags
  // directly rather than via `getFileMetadata`, which requires a `url` tag that
  // a MIP-04 attachment event may legitimately omit.
  const base = parseFileMetadataTags(event.tags);

  if (!base.sha256 || !isValidHex(base.sha256, 32)) return null;
  // m must be a valid MIME type
  if (!base.type || !isValidMimeType(base.type)) return null;

  return {
    ...base,
    sha256: base.sha256,
    type: base.type,
    filename,
    nonce,
    version: MIP04_VERSION,
  };
}
