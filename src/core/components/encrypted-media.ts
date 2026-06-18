/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";
import { validateAndNormalizeHttpsUrl } from "./url.js";

/**
 * Codec for `marmot.group.encrypted-media.v1` (`0x8008`) — the group's
 * encrypted-media policy: the media format, the allowed blob locator kinds, and
 * the default blob-store endpoints.
 *
 * Wire (Marmot binary profile):
 *   opaque media_format<V>;                 // must be "encrypted-media-v1"
 *   opaque allowed_locator_kinds<V>;        // concat of opaque kind<V>
 *   opaque default_blob_endpoints<V>;       // concat of opaque endpoint<V>
 *   // each endpoint = opaque locator_kind<V> ++ opaque base_url<V>
 *
 * Locator kinds are normalized (trim, ASCII-lowercase, `[a-z0-9-]`, ≤64 bytes)
 * and deduped; endpoint URLs are validated + normalized (loopback `http`
 * allowed). At least one allowed kind and one endpoint are required.
 *
 * @see darkmatter `crates/traits/src/app_components.rs` `encode_encrypted_media_policy_v1`
 */

export const ENCRYPTED_MEDIA_FORMAT_V1 = "encrypted-media-v1";
export const BLOSSOM_LOCATOR_KIND_V1 = "blossom-v1";

const LOCATOR_KIND_MAX_LEN = 64;
const ENDPOINT_URL_MAX_LEN = 2048;
const MAX_LOCATOR_KINDS = 16;
const MAX_BLOB_ENDPOINTS = 16;

export interface BlobStoreEndpointV1 {
  locatorKind: string;
  baseUrl: string;
}

export interface EncryptedMediaPolicyV1 {
  mediaFormat: string;
  allowedLocatorKinds: string[];
  defaultBlobEndpoints: BlobStoreEndpointV1[];
}

function normalizeLocatorKind(value: string, label: string): string {
  const kind = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (kind.length === 0) throw new Error(`${label} must not be empty`);
  if (encodeUtf8(kind).length > LOCATOR_KIND_MAX_LEN) {
    throw new Error(`${label} exceeds ${LOCATOR_KIND_MAX_LEN} bytes`);
  }
  if (!/^[a-z0-9-]+$/.test(kind)) {
    throw new Error(
      `${label} must contain only lowercase ASCII letters, digits, and '-'`,
    );
  }
  return kind;
}

function normalizeEndpointUrl(raw: string): string {
  return validateAndNormalizeHttpsUrl(raw, {
    maxLen: ENDPOINT_URL_MAX_LEN,
    allowLoopbackHttp: true,
    trimInput: true,
    label: "encrypted media endpoint URL",
  });
}

/**
 * Canonical locator-kind rule (group-encrypted-media-v1.md): 1..64 bytes,
 * lowercase ASCII letters, digits, and `-`. Pure validation — no trimming or
 * case-folding — so it can run on the strict decode path (darkmatter
 * `validate_locator_kind`).
 */
function validateLocatorKind(value: string, label: string): void {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (encodeUtf8(value).length > LOCATOR_KIND_MAX_LEN) {
    throw new Error(`${label} exceeds ${LOCATOR_KIND_MAX_LEN} bytes`);
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new Error(
      `${label} must contain only lowercase ASCII letters, digits, and '-'`,
    );
  }
}

/**
 * Strict decode-side check that a stored endpoint base URL is already
 * canonical: it validates AND is byte-equal to its own producer-side
 * normalization. A non-normalized URL is rejected, never repaired (darkmatter
 * `validate_blob_endpoint_url_is_canonical`).
 */
function validateEndpointUrlIsCanonical(baseUrl: string): void {
  if (normalizeEndpointUrl(baseUrl) !== baseUrl) {
    throw new Error("encrypted media endpoint base URL is not normalized");
  }
}

/** Normalizes + validates a policy the way the Rust `EncryptedMediaPolicyV1::new` does. */
function normalizePolicy(
  policy: EncryptedMediaPolicyV1,
): EncryptedMediaPolicyV1 {
  const mediaFormat = policy.mediaFormat.trim();
  if (mediaFormat !== ENCRYPTED_MEDIA_FORMAT_V1) {
    throw new Error(
      `encrypted media format must be ${ENCRYPTED_MEDIA_FORMAT_V1}`,
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

  const endpoints: BlobStoreEndpointV1[] = [];
  for (const endpoint of policy.defaultBlobEndpoints) {
    const locatorKind = normalizeLocatorKind(
      endpoint.locatorKind,
      "endpoint locator kind",
    );
    if (!allowed.includes(locatorKind)) {
      throw new Error("encrypted media endpoint locator kind is not allowed");
    }
    const baseUrl = normalizeEndpointUrl(endpoint.baseUrl);
    const normalized = { locatorKind, baseUrl };
    if (
      !endpoints.some(
        (e) => e.locatorKind === locatorKind && e.baseUrl === baseUrl,
      )
    ) {
      endpoints.push(normalized);
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

/** Builds the default Blossom-backed policy for the given endpoint base URLs. */
export function encryptedMediaBlossomDefault(
  baseUrls: string[],
): EncryptedMediaPolicyV1 {
  return normalizePolicy({
    mediaFormat: ENCRYPTED_MEDIA_FORMAT_V1,
    allowedLocatorKinds: [BLOSSOM_LOCATOR_KIND_V1],
    defaultBlobEndpoints: baseUrls.map((baseUrl) => ({
      locatorKind: BLOSSOM_LOCATOR_KIND_V1,
      baseUrl,
    })),
  });
}

/** Encodes an {@link EncryptedMediaPolicyV1} to its component `data` bytes. */
export function encodeEncryptedMediaPolicyV1(
  policy: EncryptedMediaPolicyV1,
): Uint8Array {
  const normalized = normalizePolicy(policy);

  const allowed = new BinaryWriter();
  for (const kind of normalized.allowedLocatorKinds) {
    allowed.opaque(encodeUtf8(kind));
  }

  // Each endpoint is the bare concatenation opaque(locator_kind) ++
  // opaque(base_url) with NO per-item length wrapper — one outer length for the
  // whole vector, then the concatenated items (darkmatter #171; spec
  // `Type items<V>`). The sibling `allowed_locator_kinds` uses the same shape.
  const endpoints = new BinaryWriter();
  for (const endpoint of normalized.defaultBlobEndpoints) {
    endpoints.opaque(encodeUtf8(endpoint.locatorKind));
    endpoints.opaque(encodeUtf8(endpoint.baseUrl));
  }

  // encode_component_vectors: bare concatenation of opaque(part) for each part.
  return new BinaryWriter()
    .opaque(encodeUtf8(normalized.mediaFormat))
    .opaque(allowed.build())
    .opaque(endpoints.build())
    .build();
}

/**
 * Decodes `marmot.group.encrypted-media.v1` component `data` bytes strictly.
 *
 * Per darkmatter `decode_encrypted_media_policy_v1` and
 * `foundation/canonical-encoding.md` ("Canonical decoding"), this is a decoder
 * of signed, state-selecting Marmot bytes: it MUST reject input that is not
 * already canonical and MUST NOT trim, case-fold, normalize, deduplicate, or
 * reorder anything. Every check is a validation; a failure throws. Repairing
 * non-canonical state here (as the old producer-`normalizePolicy` reuse did)
 * forks commit acceptance against conformant implementations.
 */
export function decodeEncryptedMediaPolicyV1(
  data: Uint8Array,
): EncryptedMediaPolicyV1 {
  const reader = new BinaryReader(data);
  const mediaFormat = decodeUtf8(reader.opaque());
  const allowedBytes = reader.opaque();
  const endpointsBytes = reader.opaque();
  reader.end();

  if (mediaFormat !== ENCRYPTED_MEDIA_FORMAT_V1) {
    throw new Error(
      `encrypted media format must be ${ENCRYPTED_MEDIA_FORMAT_V1}`,
    );
  }

  const allowedLocatorKinds: string[] = [];
  const allowedReader = new BinaryReader(allowedBytes);
  while (allowedReader.hasMore()) {
    const kind = decodeUtf8(allowedReader.opaque());
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

  // Endpoints: bare concatenation of opaque(locator_kind) ++ opaque(base_url),
  // no per-item length wrapper (darkmatter #171).
  const defaultBlobEndpoints: BlobStoreEndpointV1[] = [];
  const endpointsReader = new BinaryReader(endpointsBytes);
  while (endpointsReader.hasMore()) {
    const locatorKind = decodeUtf8(endpointsReader.opaque());
    const baseUrl = decodeUtf8(endpointsReader.opaque());
    validateLocatorKind(locatorKind, "endpoint locator kind");
    if (!allowedLocatorKinds.includes(locatorKind)) {
      throw new Error("encrypted media endpoint locator kind is not allowed");
    }
    validateEndpointUrlIsCanonical(baseUrl);
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
