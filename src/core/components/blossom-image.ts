/** @module @category Core - App Components */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

import { BinaryReader, BinaryWriter } from "../binary.js";

/**
 * Codec for `marmot.group.blossom.image.v1` (`0x8002`) — the encrypted group
 * image stored as one opaque Blossom blob. All fields empty encodes the absent
 * (cleared) image.
 *
 * Wire (Marmot binary profile), each field a QUIC-varint length + bytes:
 *   opaque image_hash<0..32>;        // SHA-256 of the encrypted blob
 *   opaque image_key<0..32>;         // ChaCha20-Poly1305 key
 *   opaque image_nonce<0..12>;       // ChaCha20-Poly1305 nonce
 *   opaque image_upload_key<0..32>;  // secret key that signs Blossom auth
 *   opaque media_type<0..128>;       // canonical media type of the plaintext
 *
 * A present image MUST have every key field at its exact length and a non-empty,
 * canonical `media_type`; mixed partial states are invalid.
 *
 * @see refs/marmot/app-components/group-blossom-image-v1.md
 * @see MDK `crates/traits/src/app_components/blossom_image.rs`
 */

const IMAGE_HASH_LEN = 32;
const IMAGE_KEY_LEN = 32;
const IMAGE_NONCE_LEN = 12;
const IMAGE_UPLOAD_KEY_LEN = 32;
const MEDIA_TYPE_MAX_LEN = 128;
const MEDIA_TYPE_PART_MAX_LEN = 64;

/** AEAD version label for group images (`group-blossom-image-v1.md`, "Image bytes"). */
const GROUP_IMAGE_VERSION = "marmot-group-image-v1";

/** Decoded `marmot.group.blossom.image.v1` state. */
export interface GroupBlossomImageV1 {
  /** SHA-256 of the encrypted blob (its Blossom content id), or empty when absent. */
  imageHash: Uint8Array;
  /** ChaCha20-Poly1305 content key, or empty when absent. */
  imageKey: Uint8Array;
  /** ChaCha20-Poly1305 nonce, or empty when absent. */
  imageNonce: Uint8Array;
  /** Secret key authorizing Blossom writes for this blob, or empty when absent. */
  imageUploadKey: Uint8Array;
  /** Canonical media type of the decrypted image, or `""` when absent. */
  mediaType: string;
}

/** The absent (cleared) image state. */
export function emptyGroupBlossomImageV1(): GroupBlossomImageV1 {
  return {
    imageHash: new Uint8Array(0),
    imageKey: new Uint8Array(0),
    imageNonce: new Uint8Array(0),
    imageUploadKey: new Uint8Array(0),
    mediaType: "",
  };
}

/** Whether `image` carries an image (any field non-empty). */
export function isGroupBlossomImagePresent(
  image: GroupBlossomImageV1,
): boolean {
  return (
    image.imageHash.length > 0 ||
    image.imageKey.length > 0 ||
    image.imageNonce.length > 0 ||
    image.imageUploadKey.length > 0 ||
    image.mediaType.length > 0
  );
}

/** WHATWG ASCII whitespace: TAB, LF, FF, CR, SPACE. */
function isAsciiWhitespace(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d ||
    code === 0x20
  );
}

/** RFC 9110 `tchar`. */
function isTokenChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    "!#$%&'*+-.^_`|~".includes(String.fromCharCode(code))
  );
}

/**
 * Canonicalizes a media type for the group image component and its AEAD AAD:
 * drop parameters after the first `;`, trim ASCII whitespace, require exactly
 * one `/` between non-empty token `type` and `subtype` (each at most 64 bytes,
 * whole at most 128), ASCII-lowercase, and map `image/jpg` to `image/jpeg`.
 *
 * This is byte-for-byte MDK's `canonicalize_marmot_media_type`, which is what
 * White Noise applies when it validates a `0x8002` commit. It is stricter than
 * the five steps in `features/encrypted-media-v1.md` (token characters, single
 * slash, length bounds); using the looser rule here would let this library
 * accept image state that MDK members reject, forking the group.
 *
 * @throws Error if the value is not a valid media type.
 */
export function canonicalizeGroupImageMediaType(value: string): string {
  const semicolon = value.indexOf(";");
  let start = 0;
  let end = semicolon === -1 ? value.length : semicolon;
  while (start < end && isAsciiWhitespace(value.charCodeAt(start))) start++;
  while (end > start && isAsciiWhitespace(value.charCodeAt(end - 1))) end--;
  const mediaType = value.slice(start, end);

  const slash = mediaType.indexOf("/");
  if (slash === -1 || mediaType.indexOf("/", slash + 1) !== -1)
    throw new Error("media type must contain exactly one slash");
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  if (type.length === 0 || subtype.length === 0)
    throw new Error("media type and subtype must be non-empty");
  if (
    type.length > MEDIA_TYPE_PART_MAX_LEN ||
    subtype.length > MEDIA_TYPE_PART_MAX_LEN ||
    mediaType.length > MEDIA_TYPE_MAX_LEN
  )
    throw new Error("media type exceeds Marmot length bounds");
  for (let i = 0; i < mediaType.length; i++) {
    if (i === slash) continue;
    if (!isTokenChar(mediaType.charCodeAt(i)))
      throw new Error("media type contains an invalid token byte");
  }
  const canonical = mediaType.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return canonical === "image/jpg" ? "image/jpeg" : canonical;
}

/** Checks a present image's field lengths and returns its canonical media type. */
function validatePresentImage(image: GroupBlossomImageV1): string {
  if (
    image.imageHash.length !== IMAGE_HASH_LEN ||
    image.imageKey.length !== IMAGE_KEY_LEN ||
    image.imageNonce.length !== IMAGE_NONCE_LEN ||
    image.imageUploadKey.length !== IMAGE_UPLOAD_KEY_LEN ||
    image.mediaType.length === 0
  )
    throw new Error("group image component has invalid partial state");
  return canonicalizeGroupImageMediaType(image.mediaType);
}

/**
 * Encodes a {@link GroupBlossomImageV1} to component `data` bytes. A present
 * image's media type is canonicalized before encoding.
 */
export function encodeGroupBlossomImageV1(
  image: GroupBlossomImageV1,
): Uint8Array {
  const present = isGroupBlossomImagePresent(image);
  const mediaType = present ? validatePresentImage(image) : "";
  const empty = new Uint8Array(0);
  return new BinaryWriter()
    .opaque(present ? image.imageHash : empty, { max: IMAGE_HASH_LEN })
    .opaque(present ? image.imageKey : empty, { max: IMAGE_KEY_LEN })
    .opaque(present ? image.imageNonce : empty, { max: IMAGE_NONCE_LEN })
    .opaque(present ? image.imageUploadKey : empty, {
      max: IMAGE_UPLOAD_KEY_LEN,
    })
    .opaque(new TextEncoder().encode(mediaType), { max: MEDIA_TYPE_MAX_LEN })
    .build();
}

/**
 * Decodes `marmot.group.blossom.image.v1` component `data` bytes, rejecting
 * partial states and a non-canonical media type.
 */
export function decodeGroupBlossomImageV1(
  data: Uint8Array,
): GroupBlossomImageV1 {
  const reader = new BinaryReader(data);
  const imageHash = reader.opaque({ max: IMAGE_HASH_LEN });
  const imageKey = reader.opaque({ max: IMAGE_KEY_LEN });
  const imageNonce = reader.opaque({ max: IMAGE_NONCE_LEN });
  const imageUploadKey = reader.opaque({ max: IMAGE_UPLOAD_KEY_LEN });
  const mediaTypeBytes = reader.opaque({ max: MEDIA_TYPE_MAX_LEN });
  reader.end();

  let mediaType: string;
  try {
    mediaType = new TextDecoder("utf-8", { fatal: true }).decode(
      mediaTypeBytes,
    );
  } catch {
    throw new Error("group image media type is not UTF-8");
  }
  const image = { imageHash, imageKey, imageNonce, imageUploadKey, mediaType };
  if (!isGroupBlossomImagePresent(image)) return image;
  if (validatePresentImage(image) !== mediaType)
    throw new Error("group image media type is not canonical");
  return image;
}

function groupImageAad(mediaType: string): Uint8Array {
  return new TextEncoder().encode(`${GROUP_IMAGE_VERSION}\0${mediaType}`);
}

/** The result of {@link encryptGroupBlossomImage}. */
export interface EncryptedGroupBlossomImage {
  /** The opaque blob to upload; its SHA-256 is `image.imageHash`. */
  encryptedBlob: Uint8Array;
  /** The component state to commit. */
  image: GroupBlossomImageV1;
}

/**
 * Encrypts a group image for `marmot.group.blossom.image.v1` with a fresh
 * random key, nonce and upload key. Upload `encryptedBlob` to a Blossom server
 * under `image.imageHash` (signing the upload authorization with
 * `image.imageUploadKey`), then commit `image`.
 */
export function encryptGroupBlossomImage(
  plaintext: Uint8Array,
  mediaType: string,
): EncryptedGroupBlossomImage {
  if (plaintext.length === 0) throw new Error("group image cannot be empty");
  const canonical = canonicalizeGroupImageMediaType(mediaType);
  const imageKey = randomBytes(IMAGE_KEY_LEN);
  const imageNonce = randomBytes(IMAGE_NONCE_LEN);
  const encryptedBlob = chacha20poly1305(
    imageKey,
    imageNonce,
    groupImageAad(canonical),
  ).encrypt(plaintext);
  return {
    encryptedBlob,
    image: {
      imageHash: sha256(encryptedBlob),
      imageKey,
      imageNonce,
      imageUploadKey: randomBytes(IMAGE_UPLOAD_KEY_LEN),
      mediaType: canonical,
    },
  };
}

/**
 * Verifies a fetched blob against `image.imageHash` and decrypts it.
 *
 * @throws Error if the image is absent, the hash does not match, or the AEAD
 *   check fails. Per the spec this is an application-level fetch failure; it
 *   never invalidates the component state.
 */
export function decryptGroupBlossomImage(
  encryptedBlob: Uint8Array,
  image: GroupBlossomImageV1,
): Uint8Array {
  if (!isGroupBlossomImagePresent(image))
    throw new Error("group image is absent");
  const mediaType = validatePresentImage(image);
  if (!equalBytes(sha256(encryptedBlob), image.imageHash))
    throw new Error("group image blob does not match image_hash");
  return chacha20poly1305(
    image.imageKey,
    image.imageNonce,
    groupImageAad(mediaType),
  ).decrypt(encryptedBlob);
}
