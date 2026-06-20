/** @module @category Core - Encrypted Media */
import {
  isLoopbackHost,
  rejectNonRoutableHost,
} from "../components/host-safety.js";
import { canonicalizeMimeType, isValidHex } from "./canonical.js";
import {
  BLOSSOM_LOCATOR_KIND,
  ENCRYPTED_MEDIA_VERSION,
  type MediaAttachment,
  type MediaLocator,
} from "./types.js";

/** Single-occurrence `imeta` field names for `encrypted-media-v1`. */
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
 * Serializes a {@link MediaAttachment} into an `encrypted-media-v1` `imeta`
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
  return parts;
}

/**
 * Throws if a `blossom-v1` locator URL points at a hostile fetch target — an
 * unsafe host or cleartext `http` (`features/encrypted-media.md` — Validation;
 * `foundation/host-safety.md`). Unlike the policy component's dev endpoints,
 * loopback is unsafe here, so the only acceptable blossom locator is `https`
 * to a routable host. This is the one locator property that invalidates a
 * reference, because the fetch request itself is the harm.
 *
 * @internal
 */
function rejectUnsafeBlossomLocator(url: URL): void {
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "https") {
    // Cleartext http (loopback or not) and any non-https scheme are rejected.
    throw new Error("blossom-v1 locator must use https");
  }
  // Rejects loopback, private, CGNAT, link-local, documentation, multicast, etc.
  rejectNonRoutableHost(url.hostname, "blossom-v1 locator");
  // Defensive: rejectNonRoutableHost already covers loopback IPs/localhost.
  if (isLoopbackHost(url.hostname)) {
    throw new Error("blossom-v1 locator must not point at loopback");
  }
}

/** Parses one `locator <kind> <value>` field value into a {@link MediaLocator}. */
function parseLocator(value: string): MediaLocator {
  const sp = value.indexOf(" ");
  if (sp <= 0) throw new Error("locator must be '<kind> <value>'");
  const kind = value.slice(0, sp);
  const locValue = value.slice(sp + 1).trim();
  if (kind.length === 0) throw new Error("locator kind must not be empty");
  if (locValue.length === 0) throw new Error("locator value must not be empty");
  if (!URL.canParse(locValue))
    throw new Error("locator value must parse as a URL");
  if (kind === BLOSSOM_LOCATOR_KIND) {
    rejectUnsafeBlossomLocator(new URL(locValue));
  }
  return { kind, value: locValue };
}

/**
 * Strictly decodes an `encrypted-media-v1` attachment from an `imeta` tag.
 *
 * Throws on any structural-integrity or host-safety violation
 * (`features/encrypted-media.md` — Validation): wrong/legacy/missing version,
 * `blurhash` present, a duplicated single-occurrence field, malformed hashes or
 * nonce, missing required fields, no locator, a malformed locator, or a
 * `blossom-v1` locator pointing at an unsafe host. Fetchability of a locator
 * kind against group policy is NOT checked here (see `selectFetchableLocators`).
 *
 * @internal
 */
function decodeMediaImetaTag(tag: string[]): MediaAttachment {
  if (tag[0] !== "imeta") throw new Error("not an imeta tag");

  const single = new Map<string, string>();
  const locators: MediaLocator[] = [];

  for (const part of tag.slice(1)) {
    const sp = part.indexOf(" ");
    const key = sp === -1 ? part : part.slice(0, sp);
    const value = sp === -1 ? "" : part.slice(sp + 1);

    if (key === "blurhash") {
      throw new Error("blurhash is invalid in encrypted-media-v1");
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
    throw new Error("missing or non-encrypted-media-v1 version");
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
 * Parses an `imeta` tag into a {@link MediaAttachment}, or returns `null` if the
 * tag is not a valid `encrypted-media-v1` attachment.
 *
 * A `null` result means the media reference is invalid and MUST be dropped (the
 * containing message should be dropped too for a host-safety failure). See
 * {@link decodeMediaImetaTag} for the exact conditions.
 *
 * @param tag - A raw `imeta` tag array from a Nostr event
 */
export function parseMediaImetaTag(tag: string[]): MediaAttachment | null {
  try {
    return decodeMediaImetaTag(tag);
  } catch {
    return null;
  }
}

/**
 * Extracts all valid `encrypted-media-v1` attachments from a tag list.
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
