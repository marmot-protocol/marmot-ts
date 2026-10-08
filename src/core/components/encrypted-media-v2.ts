/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";
import { BLOSSOM_LOCATOR_KIND_V1 } from "./encrypted-media.js";

/**
 * Codec for `marmot.group.encrypted-media.v2` (`0x800b`) — the current group
 * encrypted-media policy: the fixed media format, the allowed blob locator
 * kinds, and the ordered default blob-store endpoints.
 *
 * Wire (Marmot binary profile), identical in shape to v1 but under its own
 * component id and format constant:
 *
 * ```text
 * struct { opaque locator_kind<V>; } MediaLocatorKindV2;
 * struct { opaque locator_kind<V>; opaque base_url<1..2048>; } BlobStoreEndpointV2;
 * struct {
 *   opaque              media_format<V>;            // "encrypted-media-v2"
 *   MediaLocatorKindV2  allowed_locator_kinds<V>;
 *   BlobStoreEndpointV2 default_blob_endpoints<V>;
 * } EncryptedMediaPolicyV2;
 * ```
 *
 * Differences from v1 that matter for interop:
 * - endpoint URLs may be `http` or `https` with any host. Whether a client
 *   actually contacts an endpoint is local destination policy, not component
 *   validity, so loopback/private hosts are NOT rejected here.
 * - endpoint URLs with a query string are invalid (v1 accepts them).
 * - both lists keep the producer's order; they are not sorted.
 *
 * @see refs/marmot/app-components/group-encrypted-media-v2.md
 * @see refs/mdk/crates/traits/src/app_components/encrypted_media_v2.rs
 */

export const ENCRYPTED_MEDIA_FORMAT_V2 = "encrypted-media-v2";

/**
 * Built-in encrypted-media Blossom endpoints for new groups, in upload
 * fallback order — the same list MDK uses (`DEFAULT_BLOSSOM_SERVER_URLS` in
 * `marmot-app/src/media/mod.rs`). Each accepts opaque
 * `application/octet-stream` blobs, which encrypted media requires.
 */
export const DEFAULT_ENCRYPTED_MEDIA_BLOB_ENDPOINTS: readonly string[] = [
  "https://blossom.divine.video",
  "https://blossom.ditto.pub",
  "https://cdn.hzrd149.com",
];

const MEDIA_FORMAT_MAX_LEN = 64;
const LOCATOR_KIND_MAX_LEN = 64;
const ENDPOINT_URL_MAX_LEN = 2048;
const MAX_LOCATOR_KINDS = 16;
const MAX_BLOB_ENDPOINTS = 16;
// Upper bounds on the nested vectors before decoding them (MDK
// `ENCRYPTED_MEDIA_*_VECTOR_MAX_LEN`): every item carries a varint length
// prefix of at most 2 bytes at these sizes.
const LOCATOR_KINDS_VECTOR_MAX_LEN =
  MAX_LOCATOR_KINDS * (LOCATOR_KIND_MAX_LEN + 2);
const ENDPOINT_ENTRY_MAX_LEN =
  LOCATOR_KIND_MAX_LEN + 2 + (ENDPOINT_URL_MAX_LEN + 2);
const BLOB_ENDPOINTS_VECTOR_MAX_LEN =
  MAX_BLOB_ENDPOINTS * (ENDPOINT_ENTRY_MAX_LEN + 2);

export interface BlobStoreEndpointV2 {
  locatorKind: string;
  baseUrl: string;
}

export interface EncryptedMediaPolicyV2 {
  mediaFormat: string;
  allowedLocatorKinds: string[];
  defaultBlobEndpoints: BlobStoreEndpointV2[];
}

function utf8Len(value: string): number {
  return encodeUtf8(value).length;
}

/** Strict locator-kind rule: 1..64 bytes of `[a-z0-9-]`. No repair. */
function validateLocatorKind(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (utf8Len(value) > LOCATOR_KIND_MAX_LEN) {
    throw new Error(`${label} exceeds ${LOCATOR_KIND_MAX_LEN} bytes`);
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(
      `${label} must contain only lowercase ASCII letters, digits, and '-'`,
    );
  }
}

/** Producer-side locator-kind normalization (trim + ASCII lowercase). */
function normalizeLocatorKind(value: string, label: string): string {
  const kind = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  validateLocatorKind(kind, label);
  return kind;
}

/**
 * Producer-side WHATWG parse-and-serialize normalization for a v2 blob
 * endpoint base URL. Accepts `http` and `https`; rejects credentials, a
 * missing host, a query, or a fragment. Reachability and permission to contact
 * the endpoint are deliberately NOT validity rules (MDK
 * `validate_and_normalize_blob_endpoint_url_v2`).
 *
 * @returns The normalized URL (WHATWG serialization keeps a trailing `/`).
 */
export function validateAndNormalizeBlobEndpointUrlV2(raw: string): string {
  const label = "encrypted media endpoint URL";
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (utf8Len(trimmed) > ENDPOINT_URL_MAX_LEN) {
    throw new Error(`${label} exceeds ${ENDPOINT_URL_MAX_LEN} bytes`);
  }
  if (!URL.canParse(trimmed)) throw new Error(`${label} is invalid`);
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} scheme must be http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.hostname === "") throw new Error(`${label} must include a host`);
  // WHATWG drops an empty `?` / `#` from `search` / `hash`, but still
  // serializes them; check the serialized form so `https://h/?` is rejected
  // like the Rust `url` crate's `query().is_some()` does.
  const normalized = url.toString();
  if (url.search !== "" || normalized.includes("?")) {
    throw new Error(`${label} must not include a query`);
  }
  if (url.hash !== "" || normalized.includes("#")) {
    throw new Error(`${label} must not include a fragment`);
  }
  if (utf8Len(normalized) > ENDPOINT_URL_MAX_LEN) {
    throw new Error(`${label} exceeds ${ENDPOINT_URL_MAX_LEN} bytes`);
  }
  return normalized;
}

/** Normalizes + validates a policy the way MDK `EncryptedMediaPolicyV2::new` does. */
function normalizePolicy(
  policy: EncryptedMediaPolicyV2,
): EncryptedMediaPolicyV2 {
  const mediaFormat = policy.mediaFormat.trim();
  if (mediaFormat !== ENCRYPTED_MEDIA_FORMAT_V2) {
    throw new Error(
      `encrypted media format must be ${ENCRYPTED_MEDIA_FORMAT_V2}`,
    );
  }

  const allowed: string[] = [];
  for (const kind of policy.allowedLocatorKinds) {
    const normalized = normalizeLocatorKind(kind, "allowed locator kind");
    if (!allowed.includes(normalized)) allowed.push(normalized);
  }
  if (allowed.length === 0) {
    throw new Error(
      "encrypted media policy must allow at least one locator kind",
    );
  }
  if (allowed.length > MAX_LOCATOR_KINDS) {
    throw new Error(
      `encrypted media policy allows more than ${MAX_LOCATOR_KINDS} locator kinds`,
    );
  }

  const endpoints: BlobStoreEndpointV2[] = [];
  for (const endpoint of policy.defaultBlobEndpoints) {
    const locatorKind = normalizeLocatorKind(
      endpoint.locatorKind,
      "endpoint locator kind",
    );
    if (!allowed.includes(locatorKind)) {
      throw new Error("encrypted media endpoint locator kind is not allowed");
    }
    const baseUrl = validateAndNormalizeBlobEndpointUrlV2(endpoint.baseUrl);
    if (
      !endpoints.some(
        (e) => e.locatorKind === locatorKind && e.baseUrl === baseUrl,
      )
    ) {
      endpoints.push({ locatorKind, baseUrl });
    }
  }
  if (endpoints.length === 0) {
    throw new Error(
      "encrypted media policy must include at least one default blob endpoint",
    );
  }
  if (endpoints.length > MAX_BLOB_ENDPOINTS) {
    throw new Error(
      `encrypted media policy includes more than ${MAX_BLOB_ENDPOINTS} default blob endpoints`,
    );
  }

  return {
    mediaFormat,
    allowedLocatorKinds: allowed,
    defaultBlobEndpoints: endpoints,
  };
}

/**
 * Builds a validated {@link EncryptedMediaPolicyV2}: trims the format,
 * normalizes and de-duplicates locator kinds and endpoints (keeping first
 * occurrence order), and validates every bound. Throws on invalid input.
 */
export function createEncryptedMediaPolicyV2(
  policy: EncryptedMediaPolicyV2,
): EncryptedMediaPolicyV2 {
  return normalizePolicy(policy);
}

/**
 * Builds the default Blossom-backed v2 policy for the given endpoint base URLs
 * (MDK `EncryptedMediaPolicyV2::blossom_default`). Endpoint order is the
 * upload/fetch fallback priority and is preserved.
 */
export function encryptedMediaV2BlossomDefault(
  baseUrls: string[],
): EncryptedMediaPolicyV2 {
  return normalizePolicy({
    mediaFormat: ENCRYPTED_MEDIA_FORMAT_V2,
    allowedLocatorKinds: [BLOSSOM_LOCATOR_KIND_V1],
    defaultBlobEndpoints: baseUrls.map((baseUrl) => ({
      locatorKind: BLOSSOM_LOCATOR_KIND_V1,
      baseUrl,
    })),
  });
}

/** Encodes an {@link EncryptedMediaPolicyV2} to its component `data` bytes. */
export function encodeEncryptedMediaPolicyV2(
  policy: EncryptedMediaPolicyV2,
): Uint8Array {
  const normalized = normalizePolicy(policy);

  const allowed = new BinaryWriter();
  for (const kind of normalized.allowedLocatorKinds) {
    allowed.opaque(encodeUtf8(kind));
  }

  // `Type items<V>`: one outer length for the vector, then the bare
  // concatenation of each endpoint's two opaque fields.
  const endpoints = new BinaryWriter();
  for (const endpoint of normalized.defaultBlobEndpoints) {
    endpoints.opaque(encodeUtf8(endpoint.locatorKind));
    endpoints.opaque(encodeUtf8(endpoint.baseUrl));
  }

  return new BinaryWriter()
    .opaque(encodeUtf8(normalized.mediaFormat))
    .opaque(allowed.build())
    .opaque(endpoints.build())
    .build();
}

/**
 * Strictly decodes `marmot.group.encrypted-media.v2` component `data` bytes.
 *
 * A decoder of signed, state-selecting bytes: it rejects anything that is not
 * already canonical and never trims, case-folds, normalizes, de-duplicates or
 * reorders (`foundation/canonical-encoding.md` "Canonical decoding"; MDK
 * `decode_encrypted_media_policy_v2`). v1 bytes are rejected because their
 * format constant differs.
 */
export function decodeEncryptedMediaPolicyV2(
  data: Uint8Array,
): EncryptedMediaPolicyV2 {
  const reader = new BinaryReader(data);
  const mediaFormat = decodeUtf8(reader.opaque({ max: MEDIA_FORMAT_MAX_LEN }));
  const allowedBytes = reader.opaque({ max: LOCATOR_KINDS_VECTOR_MAX_LEN });
  const endpointsBytes = reader.opaque({ max: BLOB_ENDPOINTS_VECTOR_MAX_LEN });
  reader.end();

  if (mediaFormat !== ENCRYPTED_MEDIA_FORMAT_V2) {
    throw new Error(
      `encrypted media format must be ${ENCRYPTED_MEDIA_FORMAT_V2}`,
    );
  }

  const allowedLocatorKinds: string[] = [];
  const allowedReader = new BinaryReader(allowedBytes);
  while (allowedReader.hasMore()) {
    const kind = decodeUtf8(
      allowedReader.opaque({ max: LOCATOR_KIND_MAX_LEN }),
    );
    validateLocatorKind(kind, "allowed locator kind");
    if (allowedLocatorKinds.includes(kind)) {
      throw new Error(
        "encrypted media policy has a duplicate allowed locator kind",
      );
    }
    allowedLocatorKinds.push(kind);
  }
  if (allowedLocatorKinds.length === 0) {
    throw new Error(
      "encrypted media policy must allow at least one locator kind",
    );
  }
  if (allowedLocatorKinds.length > MAX_LOCATOR_KINDS) {
    throw new Error(
      `encrypted media policy allows more than ${MAX_LOCATOR_KINDS} locator kinds`,
    );
  }

  const defaultBlobEndpoints: BlobStoreEndpointV2[] = [];
  const endpointsReader = new BinaryReader(endpointsBytes);
  while (endpointsReader.hasMore()) {
    const locatorKind = decodeUtf8(
      endpointsReader.opaque({ max: LOCATOR_KIND_MAX_LEN }),
    );
    const baseUrl = decodeUtf8(
      endpointsReader.opaque({ max: ENDPOINT_URL_MAX_LEN }),
    );
    validateLocatorKind(locatorKind, "endpoint locator kind");
    if (!allowedLocatorKinds.includes(locatorKind)) {
      throw new Error("encrypted media endpoint locator kind is not allowed");
    }
    if (validateAndNormalizeBlobEndpointUrlV2(baseUrl) !== baseUrl) {
      throw new Error("encrypted media endpoint base URL is not normalized");
    }
    if (
      defaultBlobEndpoints.some(
        (e) => e.locatorKind === locatorKind && e.baseUrl === baseUrl,
      )
    ) {
      throw new Error(
        "encrypted media policy has a duplicate default blob endpoint",
      );
    }
    defaultBlobEndpoints.push({ locatorKind, baseUrl });
  }
  if (defaultBlobEndpoints.length === 0) {
    throw new Error(
      "encrypted media policy must include at least one default blob endpoint",
    );
  }
  if (defaultBlobEndpoints.length > MAX_BLOB_ENDPOINTS) {
    throw new Error(
      `encrypted media policy includes more than ${MAX_BLOB_ENDPOINTS} default blob endpoints`,
    );
  }

  return { mediaFormat, allowedLocatorKinds, defaultBlobEndpoints };
}
