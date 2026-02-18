import {
  type CustomExtension,
  type GroupContextExtension,
  makeCustomExtension,
} from "ts-mls";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { isValidRelayUrl } from "../utils/relay-url.js";
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_VERSION,
  MarmotGroupData,
} from "./protocol.js";

// Encoder/decoder for MarmotGroupData (MIP-01)
//
// CRITICAL: This MUST follow TLS presentation language encoding:
//
// struct {
//   uint16 version;
//   opaque nostr_group_id[32];
//   opaque name<0..2^16-1>;
//   opaque description<0..2^16-1>;
//   opaque admin_pubkeys<0..2^16-1>;
//   RelayUrl relays<0..2^16-1>;
//   opaque image_hash<0..32>;
//   opaque image_key<0..32>;
//   opaque image_nonce<0..12>;
//   opaque image_upload_key<0..32>;
// } NostrGroupData;

const encodeUtf8 = (str: string): Uint8Array => new TextEncoder().encode(str);
const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes);

function assertFixed(
  field: string,
  value: Uint8Array,
  expectedLen: number,
): void {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${field} must be a Uint8Array`);
  }
  if (value.length !== expectedLen) {
    throw new Error(`${field} must be exactly ${expectedLen} bytes`);
  }
}

function assertZeroOrFixed(
  field: string,
  value: Uint8Array,
  expectedLen: number,
): void {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${field} must be a Uint8Array`);
  }
  if (value.length !== 0 && value.length !== expectedLen) {
    throw new Error(`${field} must be empty or exactly ${expectedLen} bytes`);
  }
}

function encodeUint16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  const view = new DataView(out.buffer);
  view.setUint16(0, value, false);
  return out;
}

function decodeUint16(
  data: Uint8Array,
  offset: number,
): [number, number] | undefined {
  if (offset + 2 > data.length) return undefined;
  const view = new DataView(data.buffer, data.byteOffset);
  return [view.getUint16(offset, false), offset + 2];
}

// QUIC varint encoding (RFC 9000 §16)
function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid varint value: ${value}`);
  }

  if (value <= 63) {
    return new Uint8Array([value & 0x3f]);
  }

  if (value <= 16383) {
    const out = new Uint8Array(2);
    const v = 0x4000 | (value & 0x3fff);
    out[0] = (v >> 8) & 0xff;
    out[1] = v & 0xff;
    return out;
  }

  if (value <= 1073741823) {
    const out = new Uint8Array(4);
    const v = 0x80000000 | (value & 0x3fffffff);
    out[0] = (v >>> 24) & 0xff;
    out[1] = (v >>> 16) & 0xff;
    out[2] = (v >>> 8) & 0xff;
    out[3] = v & 0xff;
    return out;
  }

  throw new Error(`varint too large: ${value}`);
}

function decodeVarint(
  data: Uint8Array,
  offset: number,
): [number, number] | undefined {
  if (offset >= data.length) return undefined;
  const first = data[offset];
  if (first === undefined) return undefined;

  const prefix = first >>> 6;
  const len = prefix === 0 ? 1 : prefix === 1 ? 2 : prefix === 2 ? 4 : 8;

  if (offset + len > data.length) return undefined;

  if (len === 1) {
    return [first & 0x3f, offset + 1];
  }

  if (len === 2) {
    const v = ((first & 0x3f) << 8) | data[offset + 1];
    return [v >>> 0, offset + 2];
  }

  if (len === 4) {
    const v =
      ((first & 0x3f) << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3];
    return [v >>> 0, offset + 4];
  }

  // 8-byte varints are not expected for any field we encode (2^16-1 limits);
  // reject to avoid unsafe integer handling.
  throw new Error("Unsupported 8-byte QUIC varint");
}

function encodeOpaque16(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) {
    throw new Error(`opaque value too long: ${bytes.length} bytes`);
  }
  const out = new Uint8Array(2 + bytes.length);
  out.set(encodeUint16(bytes.length), 0);
  out.set(bytes, 2);
  return out;
}

function decodeOpaque16(
  data: Uint8Array,
  offset: number,
): [Uint8Array, number] | undefined {
  const lenRes = decodeUint16(data, offset);
  if (!lenRes) return undefined;
  const [len, next] = lenRes;
  if (next + len > data.length) return undefined;
  return [data.slice(next, next + len), next + len];
}

function encodeOpaqueVar(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) {
    throw new Error(`opaque value too long: ${bytes.length} bytes`);
  }
  const prefix = encodeVarint(bytes.length);
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}

function decodeOpaqueVar(
  data: Uint8Array,
  offset: number,
): [Uint8Array, number] | undefined {
  const lenRes = decodeVarint(data, offset);
  if (!lenRes) return undefined;
  const [len, next] = lenRes;
  if (len > 0xffff) throw new Error(`opaque value too long: ${len} bytes`);
  if (next + len > data.length) return undefined;
  return [data.slice(next, next + len), next + len];
}

function isHexKey(str: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(str);
}

function encodeCommaSeparated(strings: string[]): Uint8Array {
  return encodeOpaque16(encodeUtf8(strings.join(",")));
}

function decodeCommaSeparated(
  data: Uint8Array,
  offset: number,
): [string[], number] | undefined {
  const res = decodeOpaque16(data, offset);
  if (!res) return undefined;
  const [bytes, next] = res;
  const str = decodeUtf8(bytes);
  if (str.length === 0) return [[], next];
  return [str.split(","), next];
}

function encodeAdminPubkeysV2(adminPubkeys: string[]): Uint8Array {
  for (const pk of adminPubkeys) {
    if (!isHexKey(pk)) throw new Error("Invalid admin public key format");
  }

  const bytes = new Uint8Array(adminPubkeys.length * 32);
  adminPubkeys.forEach((pk, i) => {
    bytes.set(hexToBytes(pk), i * 32);
  });

  return encodeOpaqueVar(bytes);
}

function decodeAdminPubkeysV2(bytes: Uint8Array): string[] {
  if (bytes.length % 32 !== 0) {
    throw new Error("admin_pubkeys length must be a multiple of 32");
  }
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    out.push(bytesToHex(bytes.slice(i, i + 32)));
  }
  return out;
}

function encodeRelaysV2(relays: string[]): Uint8Array {
  for (const relay of relays) {
    if (!isValidRelayUrl(relay)) throw new Error("Invalid relay URL");
  }

  const encodedRelays = relays.map((r) => encodeUtf8(r));
  const innerParts = encodedRelays.map((b) => encodeOpaqueVar(b));
  const innerLen = innerParts.reduce((sum, p) => sum + p.length, 0);

  if (innerLen > 0xffff) {
    throw new Error(`relays vector too long: ${innerLen} bytes`);
  }

  const outerPrefix = encodeVarint(innerLen);
  const out = new Uint8Array(outerPrefix.length + innerLen);
  out.set(outerPrefix, 0);
  let offset = outerPrefix.length;
  for (const part of innerParts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeRelaysV2(
  data: Uint8Array,
  offset: number,
): [string[], number] | undefined {
  const outerLenRes = decodeVarint(data, offset);
  if (!outerLenRes) return undefined;
  const [outerLen, outerNext] = outerLenRes;
  if (outerLen > 0xffff) throw new Error(`relays vector too long: ${outerLen}`);
  const end = outerNext + outerLen;
  if (end > data.length) return undefined;

  const relays: string[] = [];
  let innerOffset = outerNext;
  while (innerOffset < end) {
    const partRes = decodeOpaqueVar(data, innerOffset);
    if (!partRes) return undefined;
    const [urlBytes, next] = partRes;
    const url = decodeUtf8(urlBytes);
    if (!isValidRelayUrl(url)) throw new Error("Invalid relay URL");
    relays.push(url);
    innerOffset = next;
  }
  if (innerOffset !== end) {
    throw new Error("relays vector contains trailing bytes");
  }
  return [relays, end];
}

/**
 * Encodes MarmotGroupData to bytes.
 *
 * @param data - The MarmotGroupData to encode
 * @returns Encoded bytes
 */
export function encodeMarmotGroupData(data: MarmotGroupData): Uint8Array {
  assertFixed("nostr_group_id", data.nostrGroupId, 32);
  assertZeroOrFixed("image_hash", data.imageHash, 32);
  assertZeroOrFixed("image_key", data.imageKey, 32);
  assertZeroOrFixed("image_nonce", data.imageNonce, 12);
  assertZeroOrFixed("image_upload_key", data.imageUploadKey, 32);

  const version = encodeUint16(data.version);
  const nostrGroupId = data.nostrGroupId;
  const name =
    data.version >= 2
      ? encodeOpaqueVar(encodeUtf8(data.name))
      : encodeOpaque16(encodeUtf8(data.name));
  const description =
    data.version >= 2
      ? encodeOpaqueVar(encodeUtf8(data.description))
      : encodeOpaque16(encodeUtf8(data.description));

  const adminPubkeys =
    data.version >= 2
      ? encodeAdminPubkeysV2(data.adminPubkeys)
      : encodeCommaSeparated(data.adminPubkeys);

  // v1: comma-separated string
  // v2: varint-vector of individually length-prefixed URLs
  const relays =
    data.version >= 2
      ? encodeRelaysV2(data.relays)
      : encodeCommaSeparated(data.relays);

  const imageHash =
    data.version >= 2
      ? encodeOpaqueVar(data.imageHash)
      : (() => {
          assertFixed("image_hash", data.imageHash, 32);
          return data.imageHash;
        })();
  const imageKey =
    data.version >= 2
      ? encodeOpaqueVar(data.imageKey)
      : (() => {
          assertFixed("image_key", data.imageKey, 32);
          return data.imageKey;
        })();
  const imageNonce =
    data.version >= 2
      ? encodeOpaqueVar(data.imageNonce)
      : (() => {
          assertFixed("image_nonce", data.imageNonce, 12);
          return data.imageNonce;
        })();
  const imageUploadKey =
    data.version >= 2
      ? encodeOpaqueVar(data.imageUploadKey)
      : new Uint8Array(0);

  const result = new Uint8Array(
    version.length +
      nostrGroupId.length +
      name.length +
      description.length +
      adminPubkeys.length +
      relays.length +
      imageHash.length +
      imageKey.length +
      imageNonce.length +
      imageUploadKey.length,
  );

  let offset = 0;
  result.set(version, offset);
  offset += version.length;
  result.set(nostrGroupId, offset);
  offset += nostrGroupId.length;
  result.set(name, offset);
  offset += name.length;
  result.set(description, offset);
  offset += description.length;
  result.set(adminPubkeys, offset);
  offset += adminPubkeys.length;
  result.set(relays, offset);
  offset += relays.length;
  result.set(imageHash, offset);
  offset += imageHash.length;
  result.set(imageKey, offset);
  offset += imageKey.length;
  result.set(imageNonce, offset);
  offset += imageNonce.length;
  if (imageUploadKey.length > 0) {
    result.set(imageUploadKey, offset);
  }

  return result;
}

/**
 * Decodes MarmotGroupData from bytes.
 *
 * @param data - The bytes to decode
 * @returns Decoded MarmotGroupData
 * @throws Error if decoding fails
 */
export function decodeMarmotGroupData(data: Uint8Array): MarmotGroupData {
  const versionRes = decodeUint16(data, 0);
  if (!versionRes) throw new Error("Extension data too short");
  const [version, versionOffset] = versionRes;
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported MarmotGroupData version: ${version}`);
  }

  let offset = versionOffset;

  const nostrGroupId = data.slice(offset, offset + 32);
  if (nostrGroupId.length !== 32) throw new Error("Extension data too short");
  offset += 32;

  const nameResult =
    version >= 2 ? decodeOpaqueVar(data, offset) : decodeOpaque16(data, offset);
  if (!nameResult) throw new Error("Extension data too short");
  const [nameBytes, nameOffset] = nameResult;
  const name = decodeUtf8(nameBytes);
  offset = nameOffset;

  const descriptionResult =
    version >= 2 ? decodeOpaqueVar(data, offset) : decodeOpaque16(data, offset);
  if (!descriptionResult) throw new Error("Extension data too short");
  const [descriptionBytes, descriptionOffset] = descriptionResult;
  const description = decodeUtf8(descriptionBytes);
  offset = descriptionOffset;

  const adminPubkeysResult =
    version >= 2 ? decodeOpaqueVar(data, offset) : decodeOpaque16(data, offset);
  if (!adminPubkeysResult) throw new Error("Extension data too short");
  const [adminPubkeysBytes, adminPubkeysOffset] = adminPubkeysResult;
  const adminPubkeys =
    version >= 2
      ? decodeAdminPubkeysV2(adminPubkeysBytes)
      : (() => {
          const str = decodeUtf8(adminPubkeysBytes);
          if (str.length === 0) return [];
          return str.split(",");
        })();
  offset = adminPubkeysOffset;

  const relaysResult =
    version >= 2
      ? decodeRelaysV2(data, offset)
      : decodeCommaSeparated(data, offset);
  if (!relaysResult) throw new Error("Extension data too short");
  const [relays, relaysOffset] = relaysResult;
  offset = relaysOffset;

  const imageHashRes =
    version >= 2
      ? decodeOpaqueVar(data, offset)
      : ([data.slice(offset, offset + 32), offset + 32] as const);
  if (!imageHashRes) throw new Error("Extension data too short");
  const [imageHash, imageHashOffset] = imageHashRes;
  if (version === 1) assertFixed("image_hash", imageHash, 32);
  if (version >= 2) assertZeroOrFixed("image_hash", imageHash, 32);
  offset = imageHashOffset;

  const imageKeyRes =
    version >= 2
      ? decodeOpaqueVar(data, offset)
      : ([data.slice(offset, offset + 32), offset + 32] as const);
  if (!imageKeyRes) throw new Error("Extension data too short");
  const [imageKey, imageKeyOffset] = imageKeyRes;
  if (version === 1) assertFixed("image_key", imageKey, 32);
  if (version >= 2) assertZeroOrFixed("image_key", imageKey, 32);
  offset = imageKeyOffset;

  const imageNonceRes =
    version >= 2
      ? decodeOpaqueVar(data, offset)
      : ([data.slice(offset, offset + 12), offset + 12] as const);
  if (!imageNonceRes) throw new Error("Extension data too short");
  const [imageNonce, imageNonceOffset] = imageNonceRes;
  if (version === 1) assertFixed("image_nonce", imageNonce, 12);
  if (version >= 2) assertZeroOrFixed("image_nonce", imageNonce, 12);
  offset = imageNonceOffset;

  const imageUploadKeyRes =
    version >= 2
      ? decodeOpaqueVar(data, offset)
      : ([new Uint8Array(0), offset] as const);
  if (!imageUploadKeyRes) throw new Error("Extension data too short");
  const [imageUploadKey, imageUploadKeyOffset] = imageUploadKeyRes;
  if (version >= 2) assertZeroOrFixed("image_upload_key", imageUploadKey, 32);
  offset = imageUploadKeyOffset;

  return {
    version,
    nostrGroupId,
    name,
    description,
    adminPubkeys,
    relays,
    imageHash,
    imageKey,
    imageNonce,
    imageUploadKey,
  };
}

export type CreateMarmotGroupDataOptions = Partial<
  Omit<MarmotGroupData, "version">
>;

/** Creates a valid MarmotGroupData byte payload (MIP-01). */
export function createMarmotGroupData(
  opts: CreateMarmotGroupDataOptions = {},
): Uint8Array {
  const data: MarmotGroupData = {
    version: MARMOT_GROUP_DATA_VERSION,
    nostrGroupId: opts.nostrGroupId ?? new Uint8Array(32),
    name: opts.name ?? "",
    description: opts.description ?? "",
    adminPubkeys: opts.adminPubkeys ?? [],
    relays: opts.relays ?? [],
    imageHash: opts.imageHash ?? new Uint8Array(0),
    imageKey: opts.imageKey ?? new Uint8Array(0),
    imageNonce: opts.imageNonce ?? new Uint8Array(0),
    imageUploadKey: opts.imageUploadKey ?? new Uint8Array(0),
  };
  return encodeMarmotGroupData(data);
}

/** Returns true if pubkey is included in adminPubkeys (case-insensitive). */
export function isAdmin(groupData: MarmotGroupData, pubkey: string): boolean {
  const pk = pubkey.toLowerCase();
  return groupData.adminPubkeys.some((a) => a.toLowerCase() === pk);
}

/**
 * Converts MarmotGroupData to an Extension object for use in MLS groups.
 *
 * @param data - The Marmot group data to convert
 * @returns Extension object with Marmot Group Data Extension type and encoded data
 */
export function marmotGroupDataToExtension(
  data: MarmotGroupData,
): GroupContextExtension {
  return makeCustomExtension({
    extensionType: MARMOT_GROUP_DATA_EXTENSION_TYPE,
    extensionData: encodeMarmotGroupData(data),
  });
}

/** Type guard for the Marmot Group Data custom extension (0xf2ee). */
export function isMarmotGroupDataExtension(
  ext: GroupContextExtension,
): ext is CustomExtension {
  return (
    typeof ext.extensionType === "number" &&
    ext.extensionType === MARMOT_GROUP_DATA_EXTENSION_TYPE &&
    ext.extensionData instanceof Uint8Array
  );
}

/** Extracts and validates the Marmot Group Data extension payload bytes. */
export function getMarmotGroupDataExtensionBytes(
  ext: GroupContextExtension,
): Uint8Array {
  if (!isMarmotGroupDataExtension(ext)) {
    throw new Error("Not a MarmotGroupData extension");
  }
  return ext.extensionData;
}
