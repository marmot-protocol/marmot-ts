/** @module @category Core - Encrypted Media */
import {
  isLoopbackHost,
  rejectNonRoutableHost,
} from "../components/host-safety.js";
import {
  canonicalizeMimeType,
  canonicalizeMimeTypeV2,
  isValidHex,
  isValidHexAnyCase,
} from "./canonical.js";
import { assertMediaFilename } from "./crypto.js";
import {
  BLOSSOM_LOCATOR_KIND,
  ENCRYPTED_MEDIA_VERSION_V1,
  ENCRYPTED_MEDIA_VERSION_V2,
  type EncryptedMediaVersion,
  type MediaAttachment,
  type MediaLocator,
  parseEncryptedMediaVersion,
} from "./types.js";

/** Single-occurrence `imeta` field names (both versions). */
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
 * Why an `imeta` tag was rejected. The categories and their precedence match
 * MDK's `MediaAttachmentRejectionKind` so every implementation reports the same
 * verdict for the same tag (`refs/mdk/fixtures/encrypted-media/imeta-v2.json`).
 */
export type MediaAttachmentRejectionKind =
  | "invalid_structure"
  | "unsupported_format"
  | "missing_field"
  | "duplicate_field"
  | "malformed_field";

/** A typed `imeta` rejection. Rejection is attachment-local. */
export class MediaAttachmentRejection extends Error {
  constructor(
    readonly kind: MediaAttachmentRejectionKind,
    message: string,
  ) {
    super(message);
    this.name = "MediaAttachmentRejection";
  }
}

/** One `imeta` attachment of a message, in tag order, accepted or rejected. */
export type MediaAttachmentOutcome =
  | { kind: "accepted"; attachmentIndex: number; attachment: MediaAttachment }
  | {
      kind: "rejected";
      attachmentIndex: number;
      rejection: MediaAttachmentRejection;
    };

function reject(kind: MediaAttachmentRejectionKind, message: string): never {
  throw new MediaAttachmentRejection(kind, message);
}

/**
 * Serializes a {@link MediaAttachment} into an `imeta` tag array
 * (`features/encrypted-media.md` — Message Shape).
 *
 * Field order follows the spec and MDK: `v`, `locator`…, `ciphertext_sha256`,
 * `plaintext_sha256`, `nonce`, `m`, `filename`, optional `dim`, optional
 * `thumbhash`. The `v` value is `attachment.version`. The attachment MUST carry
 * at least one locator.
 *
 * @param attachment - A populated attachment (locators filled in after upload)
 * @returns A Nostr tag array beginning with `"imeta"`
 */
export function encodeMediaImetaTag(attachment: MediaAttachment): string[] {
  if (attachment.locators.length === 0) {
    throw new Error("encodeMediaImetaTag: attachment has no locators");
  }
  const version = parseEncryptedMediaVersion(
    attachment.version ?? ENCRYPTED_MEDIA_VERSION_V1,
  );
  if (!version) {
    throw new Error(
      `encodeMediaImetaTag: unsupported media version ${JSON.stringify(attachment.version)}`,
    );
  }
  const parts: string[] = ["imeta", `v ${version}`];
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
 * Throws if a v1 `blossom-v1` locator URL points at a hostile fetch target — an
 * unsafe host or cleartext `http` (`features/encrypted-media-v1.md`). v2 moved
 * destination safety to fetch time, so this applies to v1 only.
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

/** Parses one v1 `locator <kind> <value>` field value. */
function parseLocatorV1(value: string): MediaLocator {
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
 * Decodes the frozen `encrypted-media-v1` shape. Behaviour is unchanged from
 * the pre-v2 parser; failures are reported as `malformed_field` unless the
 * structure is clearly wrong.
 */
function decodeImetaV1(tag: string[]): MediaAttachment {
  const single = new Map<string, string>();
  const locators: MediaLocator[] = [];

  for (const part of tag.slice(1)) {
    const sp = part.indexOf(" ");
    const key = sp === -1 ? part : part.slice(0, sp);
    const value = sp === -1 ? "" : part.slice(sp + 1);

    if (key === "blurhash") {
      reject("malformed_field", "blurhash is invalid in encrypted-media-v1");
    }
    if (key === "locator") {
      try {
        locators.push(parseLocatorV1(value));
      } catch (err) {
        reject("malformed_field", (err as Error).message);
      }
      continue;
    }
    if ((SINGLE_FIELDS as readonly string[]).includes(key)) {
      if (single.has(key)) {
        reject("duplicate_field", `duplicate single-occurrence field: ${key}`);
      }
      single.set(key, value);
    }
    // Unknown fields are ignored (only blurhash is explicitly forbidden).
  }

  if (locators.length === 0) reject("missing_field", "no locator present");

  const ciphertextSha256 = single.get("ciphertext_sha256");
  const plaintextSha256 = single.get("plaintext_sha256");
  const nonce = single.get("nonce");
  const mediaTypeRaw = single.get("m");
  const filename = single.get("filename");

  if (!ciphertextSha256 || !isValidHex(ciphertextSha256, 32))
    reject("malformed_field", "ciphertext_sha256 must be a 32-byte hex value");
  if (!plaintextSha256 || !isValidHex(plaintextSha256, 32))
    reject("malformed_field", "plaintext_sha256 must be a 32-byte hex value");
  if (!nonce || !isValidHex(nonce, 12))
    reject("malformed_field", "nonce must be 24 hex characters");
  if (!mediaTypeRaw) reject("missing_field", "m (media type) is required");
  if (!filename) reject("missing_field", "filename is required");

  // Canonicalize the media type (also rejects an empty / slash-less value).
  let mediaType: string;
  try {
    mediaType = canonicalizeMimeType(mediaTypeRaw);
  } catch (err) {
    reject("malformed_field", (err as Error).message);
  }

  return {
    version: ENCRYPTED_MEDIA_VERSION_V1,
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
 * Structural check of one v2 locator (MDK `validate_locator` for V2): kind and
 * value are non-empty, the value parses as a URL, and a `blossom-v1` URL uses
 * `http` or `https`. Destination safety and the locator's place in the group
 * policy are fetch-time decisions and never invalidate the reference.
 */
function validateLocatorV2(locator: MediaLocator): void {
  if (locator.kind.trim() === "" || locator.value.trim() === "") {
    reject("malformed_field", "media locator kind and value cannot be empty");
  }
  if (!URL.canParse(locator.value)) {
    reject("malformed_field", "media locator URL is invalid");
  }
  if (locator.kind === BLOSSOM_LOCATOR_KIND) {
    const protocol = new URL(locator.value).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      reject(
        "malformed_field",
        "Blossom media locator URL scheme must be http or https",
      );
    }
  }
}

/** Field names whose bare (value-less) form is a structural error in v2. */
const V2_VALUE_FIELDS = new Set<string>([
  "locator",
  "ciphertext_sha256",
  "plaintext_sha256",
  "nonce",
  "m",
  "filename",
  "dim",
  "thumbhash",
]);

/**
 * Decodes an `encrypted-media-v2` tag, mirroring MDK `parse_media_attachment`
 * field for field: values are kept exactly as received (no trimming or MIME
 * repair), a present-empty `dim`/`thumbhash` stays `""`, and a duplicate
 * single-occurrence field is rejected rather than first- or last-wins.
 */
function decodeImetaV2(tag: string[]): MediaAttachment {
  const locators: MediaLocator[] = [];
  const single = new Map<string, string>();

  for (const field of tag.slice(1)) {
    if (field === "blurhash" || field.startsWith("blurhash ")) {
      reject("malformed_field", "encrypted media uses thumbhash, not blurhash");
    }
    if (field.startsWith("locator ")) {
      const rest = field.slice("locator ".length);
      const sp = rest.indexOf(" ");
      if (sp === -1) {
        reject(
          "invalid_structure",
          "media locator must include kind and value",
        );
      }
      locators.push({ kind: rest.slice(0, sp), value: rest.slice(sp + 1) });
      continue;
    }
    const sp = field.indexOf(" ");
    if (sp === -1) {
      if (V2_VALUE_FIELDS.has(field)) {
        reject(
          "invalid_structure",
          `media field ${field} is missing its value`,
        );
      }
      continue;
    }
    const key = field.slice(0, sp);
    const value = field.slice(sp + 1);
    if (key === "v") continue; // judged in the version pre-pass
    if ((SINGLE_FIELDS as readonly string[]).includes(key)) {
      if (single.has(key)) {
        reject("duplicate_field", `media tag must contain exactly one ${key}`);
      }
      single.set(key, value);
    }
  }

  const required = (name: string): string => {
    const value = single.get(name);
    if (value === undefined || value === "") {
      reject("missing_field", `media tag missing ${name}`);
    }
    return value;
  };
  const ciphertextSha256 = required("ciphertext_sha256");
  const plaintextSha256 = required("plaintext_sha256");
  const nonce = required("nonce");
  const filename = required("filename");
  const mediaType = required("m");

  // Reference validation, in MDK `MediaAttachmentReference::validate` order.
  if (!isValidHexAnyCase(ciphertextSha256, 32))
    reject("malformed_field", "media ciphertext_sha256 must be 32 hex bytes");
  if (!isValidHexAnyCase(plaintextSha256, 32))
    reject("malformed_field", "media plaintext_sha256 must be 32 hex bytes");
  if (!isValidHexAnyCase(nonce, 12))
    reject("malformed_field", "media nonce must be 12 bytes");
  if (locators.length === 0) {
    reject(
      "missing_field",
      "media attachment must include at least one locator",
    );
  }
  for (const locator of locators) validateLocatorV2(locator);
  try {
    assertMediaFilename(filename, ENCRYPTED_MEDIA_VERSION_V2);
  } catch (err) {
    reject("malformed_field", (err as Error).message);
  }
  let canonical: string | undefined;
  try {
    canonical = canonicalizeMimeTypeV2(mediaType);
  } catch (err) {
    reject("malformed_field", (err as Error).message);
  }
  if (canonical !== mediaType) {
    reject(
      "malformed_field",
      "media type is not canonical for encrypted-media-v2",
    );
  }

  return {
    version: ENCRYPTED_MEDIA_VERSION_V2,
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
 * Strictly decodes an encrypted-media attachment from an `imeta` tag, throwing
 * a typed {@link MediaAttachmentRejection} on failure.
 *
 * The `v` field is judged first, so the verdict for a tag with no `v`, a
 * duplicated `v`, or an unknown version (including legacy MIP-04 shapes) does
 * not depend on field order (MDK `parse_media_attachment`). `encrypted-media-v1`
 * tags are then decoded with the frozen v1 rules and `encrypted-media-v2` tags
 * with the v2 rules (`features/encrypted-media.md` — Validation). Fetchability
 * of a locator against group policy is NOT checked here.
 *
 * @throws {MediaAttachmentRejection}
 */
export function parseMediaAttachment(tag: string[]): MediaAttachment {
  if (tag[0] !== "imeta")
    reject("invalid_structure", "media tag must be imeta");

  let version: EncryptedMediaVersion | undefined;
  for (const field of tag.slice(1)) {
    if (field === "v") {
      reject("invalid_structure", "media field v is missing its value");
    }
    if (!field.startsWith("v ")) continue;
    if (version !== undefined) {
      reject("duplicate_field", "media tag must contain exactly one version");
    }
    version = parseEncryptedMediaVersion(field.slice(2));
    if (!version)
      reject("unsupported_format", "media version is not supported");
  }
  if (!version) reject("unsupported_format", "media tag missing v");

  return version === ENCRYPTED_MEDIA_VERSION_V2
    ? decodeImetaV2(tag)
    : decodeImetaV1(tag);
}

/**
 * Parses an `imeta` tag into a {@link MediaAttachment} (v1 or v2), or returns
 * `null` if the tag is not a valid encrypted-media reference. Use
 * {@link parseMediaAttachment} to learn why a tag was rejected.
 *
 * @param tag - A raw `imeta` tag array from a Nostr event
 */
export function parseMediaImetaTag(tag: string[]): MediaAttachment | null {
  try {
    return parseMediaAttachment(tag);
  } catch {
    return null;
  }
}

/**
 * Extracts all valid encrypted-media attachments (v1 and v2) from a tag list.
 *
 * Non-`imeta` tags and `imeta` tags that fail validation are skipped. Use
 * {@link getMediaAttachmentOutcomes} to keep rejected attachments' positions.
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
 * Projects a message's `imeta` tags into ordered per-attachment outcomes (MDK
 * `media_attachment_outcomes_from_tags`). `attachmentIndex` is the position
 * among the message's `imeta` tags. A rejected attachment never hides its
 * valid siblings or the carrying message (v2 rejection is attachment-local).
 */
export function getMediaAttachmentOutcomes(
  tags: string[][],
): MediaAttachmentOutcome[] {
  return tags
    .filter((t) => t[0] === "imeta")
    .map((tag, attachmentIndex): MediaAttachmentOutcome => {
      try {
        return {
          kind: "accepted",
          attachmentIndex,
          attachment: parseMediaAttachment(tag),
        };
      } catch (err) {
        const rejection =
          err instanceof MediaAttachmentRejection
            ? err
            : new MediaAttachmentRejection(
                "malformed_field",
                err instanceof Error ? err.message : String(err),
              );
        return { kind: "rejected", attachmentIndex, rejection };
      }
    });
}
