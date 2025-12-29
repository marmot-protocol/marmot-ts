import { randomBytes } from "@noble/hashes/utils.js";
import { relaySet } from "applesauce-core/helpers";
import { Extension } from "ts-mls";
import { isHexKey } from "./credential.js";
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
  MARMOT_GROUP_DATA_VERSION,
  MarmotGroupData,
} from "./protocol.js";

/**
 * Marmot Group Data Extension Implementation (MIP-01)
 *
 * This module implements the mandatory Marmot Group Data Extension which links
 * MLS groups to Nostr metadata and provides cryptographically secure group state.
 *
 * Extension Identifier: 0xF2EE
 *
 * Note: Image encryption/decryption functions will be added in MIP-04 implementation.
 *
 * @see https://github.com/marmot-protocol/marmot/blob/master/01.md#marmot-group-data-extension
 */

/**
 * Encodes a Marmot Group Data Extension according to TLS presentation language.
 *
 * @param data - The group data to encode
 * @returns TLS-encoded extension data
 * @throws Error if validation fails
 */
export function encodeMarmotGroupData(data: MarmotGroupData): Uint8Array {
  // Validate input
  validateMarmotGroupData(data);

  const textEncoder = new TextEncoder();

  // Encode version (2 bytes, big-endian)
  const versionBytes = new Uint8Array(2);
  new DataView(versionBytes.buffer).setUint16(0, data.version, false);

  // nostr_group_id (32 bytes)
  if (data.nostrGroupId.length !== 32) {
    throw new Error("nostr_group_id must be exactly 32 bytes");
  }
  const nostrGroupId = data.nostrGroupId;

  // Encode name (variable-length with 2-byte length prefix)
  const nameBytes = textEncoder.encode(data.name);
  const nameWithLength = encodeVariableLengthField(nameBytes);

  // Encode description (variable-length with 2-byte length prefix)
  const descBytes = textEncoder.encode(data.description);
  const descWithLength = encodeVariableLengthField(descBytes);

  // Encode admin_pubkeys (comma-separated hex strings with 2-byte length prefix)
  const adminStr = data.adminPubkeys.join(",");
  const adminBytes = textEncoder.encode(adminStr);
  const adminWithLength = encodeVariableLengthField(adminBytes);

  // Encode relays (comma-separated URLs with 2-byte length prefix)
  const relaysStr = data.relays.join(",");
  const relaysBytes = textEncoder.encode(relaysStr);
  const relaysWithLength = encodeVariableLengthField(relaysBytes);

  // Image fields (variable-length)
  // Encode image_hash (0 or 32 bytes with 2-byte length prefix)
  const imageHashBytes = data.imageHash || new Uint8Array(0);
  if (imageHashBytes.length !== 0 && imageHashBytes.length !== 32) {
    throw new Error("image_hash must be 0 or 32 bytes");
  }
  const imageHashWithLength = encodeVariableLengthField(imageHashBytes);

  // Encode image_key (0 or 32 bytes with 2-byte length prefix)
  const imageKeyBytes = data.imageKey || new Uint8Array(0);
  if (imageKeyBytes.length !== 0 && imageKeyBytes.length !== 32) {
    throw new Error("image_key must be 0 or 32 bytes");
  }
  const imageKeyWithLength = encodeVariableLengthField(imageKeyBytes);

  // Encode image_nonce (0 or 12 bytes with 2-byte length prefix)
  const imageNonceBytes = data.imageNonce || new Uint8Array(0);
  if (imageNonceBytes.length !== 0 && imageNonceBytes.length !== 12) {
    throw new Error("image_nonce must be 0 or 12 bytes");
  }
  const imageNonceWithLength = encodeVariableLengthField(imageNonceBytes);

  // Calculate total length
  const totalLength =
    versionBytes.length +
    nostrGroupId.length +
    nameWithLength.length +
    descWithLength.length +
    adminWithLength.length +
    relaysWithLength.length +
    imageHashWithLength.length +
    imageKeyWithLength.length +
    imageNonceWithLength.length;

  // Concatenate all parts
  const result = new Uint8Array(totalLength);
  let offset = 0;

  result.set(versionBytes, offset);
  offset += versionBytes.length;

  result.set(nostrGroupId, offset);
  offset += nostrGroupId.length;

  result.set(nameWithLength, offset);
  offset += nameWithLength.length;

  result.set(descWithLength, offset);
  offset += descWithLength.length;

  result.set(adminWithLength, offset);
  offset += adminWithLength.length;

  result.set(relaysWithLength, offset);
  offset += relaysWithLength.length;

  result.set(imageHashWithLength, offset);
  offset += imageHashWithLength.length;

  result.set(imageKeyWithLength, offset);
  offset += imageKeyWithLength.length;

  result.set(imageNonceWithLength, offset);

  return result;
}

/**
 * Decodes a Marmot Group Data Extension from TLS-encoded bytes.
 *
 * @param extensionData - The TLS-encoded extension data
 * @returns Decoded group data
 * @throws Error if the data is malformed or invalid
 */
export function decodeMarmotGroupData(
  extensionData: Uint8Array,
): MarmotGroupData {
  const MIN_SIZE = 2 + 32 + 2 + 2 + 2 + 2 + 2 + 2 + 2; // 48 bytes minimum

  if (extensionData.length < MIN_SIZE) {
    throw new Error(
      `Extension data too short: expected at least ${MIN_SIZE} bytes, got ${extensionData.length}`,
    );
  }

  let offset = 0;
  const textDecoder = new TextDecoder();

  // Read version (2 bytes, big-endian)
  const version = new DataView(
    extensionData.buffer,
    extensionData.byteOffset + offset,
    2,
  ).getUint16(0, false);
  offset += 2;

  // Validate version
  if (version < 1) {
    throw new Error(`Invalid version: ${version}`);
  }

  // Read nostr_group_id (32 bytes)
  const nostrGroupId = extensionData.slice(offset, offset + 32);
  offset += 32;

  // Read name (variable-length with 2-byte length prefix)
  const { data: nameBytes, nextOffset: nameOffset } = decodeVariableLengthField(
    extensionData,
    offset,
  );
  const name = textDecoder.decode(nameBytes);
  offset = nameOffset;

  // Read description (variable-length with 2-byte length prefix)
  const { data: descBytes, nextOffset: descOffset } = decodeVariableLengthField(
    extensionData,
    offset,
  );
  const description = textDecoder.decode(descBytes);
  offset = descOffset;

  // Read admin_pubkeys (variable-length with 2-byte length prefix)
  const { data: adminBytes, nextOffset: adminOffset } =
    decodeVariableLengthField(extensionData, offset);
  const adminStr = textDecoder.decode(adminBytes);
  const adminPubkeys = adminStr.length > 0 ? adminStr.split(",") : [];
  offset = adminOffset;

  // Read relays (variable-length with 2-byte length prefix)
  const { data: relaysBytes, nextOffset: relaysOffset } =
    decodeVariableLengthField(extensionData, offset);
  const relaysStr = textDecoder.decode(relaysBytes);
  const relays = relaysStr.length > 0 ? relaysStr.split(",") : [];
  offset = relaysOffset;

  // Read image_hash (variable-length with 2-byte length prefix)
  const { data: imageHashBytes, nextOffset: imageHashOffset } =
    decodeVariableLengthField(extensionData, offset);
  const imageHash = imageHashBytes.length > 0 ? imageHashBytes : null;
  offset = imageHashOffset;

  // Read image_key (variable-length with 2-byte length prefix)
  const { data: imageKeyBytes, nextOffset: imageKeyOffset } =
    decodeVariableLengthField(extensionData, offset);
  const imageKey = imageKeyBytes.length > 0 ? imageKeyBytes : null;
  offset = imageKeyOffset;

  // Read image_nonce (variable-length with 2-byte length prefix)
  const { data: imageNonceBytes, nextOffset: imageNonceOffset } =
    decodeVariableLengthField(extensionData, offset);
  const imageNonce = imageNonceBytes.length > 0 ? imageNonceBytes : null;
  offset = imageNonceOffset;

  // Validate no extra data
  if (offset !== extensionData.length) {
    // For forward compatibility, log warning but continue
    console.warn(
      `Extension has ${extensionData.length - offset} extra bytes (version ${version} may have additional fields)`,
    );
  }

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
  };
}

/**
 * Creates a new Marmot Group Data Extension with the provided parameters.
 *
 * @param params - Partial MarmotGroupData with optional fields
 * @returns Encoded extension data ready for use in MLS
 */
export function createMarmotGroupData(
  params: Partial<MarmotGroupData> = {},
): Uint8Array {
  const uniqueAdmins = Array.from(new Set(params.adminPubkeys));

  const data: MarmotGroupData = {
    version: MARMOT_GROUP_DATA_VERSION,
    nostrGroupId: params.nostrGroupId || randomBytes(32),
    name: params.name || "",
    description: params.description || "",
    adminPubkeys: uniqueAdmins,
    relays: relaySet(params.relays),
    imageHash: params.imageHash ?? null,
    imageKey: params.imageKey ?? null,
    imageNonce: params.imageNonce ?? null,
  };

  return encodeMarmotGroupData(data);
}

// Image encryption/decryption functions will be implemented in MIP-04

/**
 * Validates that an admin public key is authorized in the group data.
 *
 * @param groupData - The decoded group data
 * @param adminPubkey - The public key to check (hex-encoded)
 * @returns true if the admin is authorized
 */
export function isAdmin(
  groupData: MarmotGroupData,
  adminPubkey: string,
): boolean {
  return groupData.adminPubkeys.includes(adminPubkey.toLowerCase());
}

// Helper functions

/**
 * Encodes a variable-length field with a 2-byte length prefix (big-endian).
 */
function encodeVariableLengthField(data: Uint8Array): Uint8Array {
  if (data.length > 65535) {
    throw new Error(
      `Variable-length field too long: ${data.length} bytes (max 65535)`,
    );
  }

  const result = new Uint8Array(2 + data.length);
  new DataView(result.buffer).setUint16(0, data.length, false);
  result.set(data, 2);

  return result;
}

/**
 * Decodes a variable-length field with a 2-byte length prefix (big-endian).
 */
function decodeVariableLengthField(
  buffer: Uint8Array,
  offset: number,
): { data: Uint8Array; nextOffset: number } {
  if (offset + 2 > buffer.length) {
    throw new Error("Buffer too short to read length prefix");
  }

  // Create a DataView that accounts for the buffer's byteOffset
  const length = new DataView(
    buffer.buffer,
    buffer.byteOffset + offset,
    2,
  ).getUint16(0, false);
  offset += 2;

  if (offset + length > buffer.length) {
    throw new Error(
      `Buffer too short: expected ${length} bytes, got ${buffer.length - offset}`,
    );
  }

  const data = buffer.slice(offset, offset + length);
  return {
    data,
    nextOffset: offset + length,
  };
}

/**
 * Validates MarmotGroupData structure.
 */
function validateMarmotGroupData(data: MarmotGroupData): void {
  // Validate version
  if (data.version < 1) {
    throw new Error(`Invalid version: ${data.version}`);
  }

  // Validate nostr_group_id length
  if (data.nostrGroupId.length !== 32) {
    throw new Error("nostr_group_id must be exactly 32 bytes");
  }

  // Validate strings are valid UTF-8 (TextEncoder will throw if invalid)
  try {
    new TextEncoder().encode(data.name);
    new TextEncoder().encode(data.description);
  } catch (error) {
    throw new Error(`Invalid UTF-8 encoding: ${error}`);
  }

  // Validate admin pubkeys
  for (const pubkey of data.adminPubkeys) {
    if (!isHexKey(pubkey)) {
      throw new Error(
        `Invalid admin public key format: ${pubkey} (must be 64 hex characters)`,
      );
    }
  }

  // Validate relays
  for (const relay of data.relays) {
    if (!relay.startsWith("ws://") && !relay.startsWith("wss://")) {
      throw new Error(
        `Invalid relay URL: ${relay} (must start with ws:// or wss://)`,
      );
    }
  }

  // Validate image field lengths (null or exact size)
  if (data.imageHash !== null && data.imageHash.length !== 32) {
    throw new Error("image_hash must be null or exactly 32 bytes");
  }
  if (data.imageKey !== null && data.imageKey.length !== 32) {
    throw new Error("image_key must be null or exactly 32 bytes");
  }
  if (data.imageNonce !== null && data.imageNonce.length !== 12) {
    throw new Error("image_nonce must be null or exactly 12 bytes");
  }
}

/**
 * Converts MarmotGroupData to an Extension object for use in MLS groups.
 *
 * @param data - The Marmot group data to convert
 * @returns Extension object with Marmot Group Data Extension type and encoded data
 */
export function marmotGroupDataToExtension(data: MarmotGroupData): Extension {
  return {
    extensionType: MARMOT_GROUP_DATA_EXTENSION_TYPE,
    extensionData: encodeMarmotGroupData(data),
  };
}
