/** @module @category Core - Marmot Group Data */
import {
  type CustomExtension,
  type GroupContextExtension,
  makeCustomExtension,
} from "ts-mls";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { isValidRelayUrl } from "../utils/relay-url.js";
import {
  BinaryDecodeError,
  BinaryReader,
  BinaryWriter,
  decodeUtf8,
  encodeUtf8,
} from "./binary.js";
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_VERSION,
  MarmotGroupData,
} from "./protocol.js";

// Encoder/decoder for MarmotGroupData (MIP-01), v2 wire format.
//
// Marmot-owned bytes use the Marmot binary profile (`core/binary.ts`): TLS
// presentation-language structs with QUIC variable-length vector prefixes.
//
// struct {
//   uint16 version;                 // MUST be 2
//   opaque nostr_group_id[32];
//   opaque name<V>;
//   opaque description<V>;
//   opaque admin_pubkeys<V>;        // concatenated 32-byte keys
//   RelayUrl relays<V>;             // each url is opaque<V>
//   opaque image_hash<V>;           // empty or 32 bytes
//   opaque image_key<V>;            // empty or 32 bytes
//   opaque image_nonce<V>;          // empty or 12 bytes
//   opaque image_upload_key<V>;     // empty or 32 bytes
// } NostrGroupData;

/** Defensive upper bound (bytes) on each variable field, preserved from v1. */
const MAX_FIELD = { max: 0xffff };

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

function isHexKey(str: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(str);
}

function encodeAdminPubkeys(adminPubkeys: string[]): Uint8Array {
  for (const pk of adminPubkeys) {
    if (!isHexKey(pk)) throw new Error("Invalid admin public key format");
  }
  const bytes = new Uint8Array(adminPubkeys.length * 32);
  adminPubkeys.forEach((pk, i) => bytes.set(hexToBytes(pk), i * 32));
  return bytes;
}

function decodeAdminPubkeys(bytes: Uint8Array): string[] {
  if (bytes.length % 32 !== 0) {
    throw new Error("admin_pubkeys length must be a multiple of 32");
  }
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    out.push(bytesToHex(bytes.slice(i, i + 32)));
  }
  return out;
}

/**
 * Encodes MarmotGroupData to bytes.
 *
 * @param data - The MarmotGroupData to encode
 * @returns Encoded bytes
 */
export function encodeMarmotGroupData(data: MarmotGroupData): Uint8Array {
  if (data.version !== MARMOT_GROUP_DATA_VERSION) {
    throw new Error(
      `Unsupported MarmotGroupData version: ${data.version} (only v${MARMOT_GROUP_DATA_VERSION} is supported)`,
    );
  }
  assertFixed("nostr_group_id", data.nostrGroupId, 32);
  assertZeroOrFixed("image_hash", data.imageHash, 32);
  assertZeroOrFixed("image_key", data.imageKey, 32);
  assertZeroOrFixed("image_nonce", data.imageNonce, 12);
  assertZeroOrFixed("image_upload_key", data.imageUploadKey, 32);

  const adminBytes = encodeAdminPubkeys(data.adminPubkeys);

  const relayItems = data.relays.map((relay) => {
    if (!isValidRelayUrl(relay)) throw new Error("Invalid relay URL");
    return new BinaryWriter().opaque(encodeUtf8(relay)).build();
  });

  return new BinaryWriter()
    .uint16(data.version)
    .bytes(data.nostrGroupId)
    .opaque(encodeUtf8(data.name), MAX_FIELD)
    .opaque(encodeUtf8(data.description), MAX_FIELD)
    .opaque(adminBytes, MAX_FIELD)
    .vector(relayItems, MAX_FIELD)
    .opaque(data.imageHash)
    .opaque(data.imageKey)
    .opaque(data.imageNonce)
    .opaque(data.imageUploadKey)
    .build();
}

/**
 * Decodes MarmotGroupData from bytes.
 *
 * @param data - The bytes to decode
 * @returns Decoded MarmotGroupData
 * @throws Error if decoding fails
 */
export function decodeMarmotGroupData(data: Uint8Array): MarmotGroupData {
  try {
    const r = new BinaryReader(data);

    const version = r.uint16();
    if (version !== MARMOT_GROUP_DATA_VERSION) {
      throw new Error(`Unsupported MarmotGroupData version: ${version}`);
    }

    const nostrGroupId = r.bytes(32);
    const name = decodeUtf8(r.opaque(MAX_FIELD));
    const description = decodeUtf8(r.opaque(MAX_FIELD));
    const adminPubkeys = decodeAdminPubkeys(r.opaque(MAX_FIELD));
    const relays = r.vector((item) => {
      const url = decodeUtf8(item.opaque());
      if (!isValidRelayUrl(url)) throw new Error("Invalid relay URL");
      return url;
    }, MAX_FIELD);

    const imageHash = r.opaque();
    assertZeroOrFixed("image_hash", imageHash, 32);
    const imageKey = r.opaque();
    assertZeroOrFixed("image_key", imageKey, 32);
    const imageNonce = r.opaque();
    assertZeroOrFixed("image_nonce", imageNonce, 12);
    const imageUploadKey = r.opaque();
    assertZeroOrFixed("image_upload_key", imageUploadKey, 32);

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
  } catch (e) {
    // Preserve the historical contract: truncated/malformed bytes throw a
    // message matching /Extension data too short/. Domain errors (invalid
    // relay URL, version, field size) are plain Errors and propagate as-is.
    if (e instanceof BinaryDecodeError) {
      throw new Error(`Extension data too short or malformed: ${e.message}`);
    }
    throw e;
  }
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
