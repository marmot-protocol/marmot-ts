/** @module @category Core - App Components */
import {
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "../binary.js";
import { validateAndNormalizeHttpsUrl } from "./internal.js";

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
    rejectQuery: true,
    trimTrailingSlash: true,
    label: "encrypted media endpoint URL",
  });
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

  const endpoints = new BinaryWriter();
  for (const endpoint of normalized.defaultBlobEndpoints) {
    const encoded = new BinaryWriter()
      .opaque(encodeUtf8(endpoint.locatorKind))
      .opaque(encodeUtf8(endpoint.baseUrl))
      .build();
    endpoints.opaque(encoded);
  }

  // encode_component_vectors: bare concatenation of opaque(part) for each part.
  return new BinaryWriter()
    .opaque(encodeUtf8(normalized.mediaFormat))
    .opaque(allowed.build())
    .opaque(endpoints.build())
    .build();
}

/** Decodes `marmot.group.encrypted-media.v1` component `data` bytes. */
export function decodeEncryptedMediaPolicyV1(
  data: Uint8Array,
): EncryptedMediaPolicyV1 {
  const reader = new BinaryReader(data);
  const mediaFormat = decodeUtf8(reader.opaque());
  const allowedBytes = reader.opaque();
  const endpointsBytes = reader.opaque();
  reader.end();

  const allowedLocatorKinds: string[] = [];
  const allowedReader = new BinaryReader(allowedBytes);
  while (allowedReader.hasMore()) {
    allowedLocatorKinds.push(decodeUtf8(allowedReader.opaque()));
  }

  const defaultBlobEndpoints: BlobStoreEndpointV1[] = [];
  const endpointsReader = new BinaryReader(endpointsBytes);
  while (endpointsReader.hasMore()) {
    const endpointReader = new BinaryReader(endpointsReader.opaque());
    const locatorKind = decodeUtf8(endpointReader.opaque());
    const baseUrl = decodeUtf8(endpointReader.opaque());
    endpointReader.end();
    defaultBlobEndpoints.push({ locatorKind, baseUrl });
  }

  // Re-run normalization/validation, matching the Rust decoder's final `new(...)`.
  return normalizePolicy({
    mediaFormat,
    allowedLocatorKinds,
    defaultBlobEndpoints,
  });
}
