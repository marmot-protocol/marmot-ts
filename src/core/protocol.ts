// Constants for the Marmot protocol
import { defaultExtensionTypes } from "ts-mls";

/** The extension id for the last_resort extension for key packages */
export const LAST_RESORT_EXTENSION_TYPE = 0x000a;

/** Event kind for key package relay list events */
export const KEY_PACKAGE_RELAY_LIST_KIND = 10051;

/** The name of the tag that contains relay URLs */
export const KEY_PACKAGE_RELAY_LIST_RELAY_TAG = "relay";

/** Event kind for key package events */
export const KEY_PACKAGE_KIND = 443;

/** The name of the tag that contains the MLS protocol version */
export const KEY_PACKAGE_MLS_VERSION_TAG = "mls_protocol_version";

/** The name of the tag that contains the MLS cipher suite */
export const KEY_PACKAGE_CIPHER_SUITE_TAG = "mls_ciphersuite";

/** The name of the tag that contains the MLS extensions */
export const KEY_PACKAGE_EXTENSIONS_TAG = "mls_extensions";

/** The name of the tag that contains the relays */
export const KEY_PACKAGE_RELAYS_TAG = "relays";

/** The name of the tag that contains the client */
export const KEY_PACKAGE_CLIENT_TAG = "client";

/** The possible MLS protocol versions */
export type MLS_VERSIONS = "1.0";

/** Parsed client tag from a kind 443 event */
export type KeyPackageClient = {
  name: string;
  // TODO: this is probably a NIP-89 client tag, so it should probably have the rest of the fields
};

/** The identifier for the Marmot Group Data Extension (MIP-01) */
export const MARMOT_GROUP_DATA_EXTENSION_TYPE = 0xf2ee;

/** The latest supported version number for the Marmot Group Data Extension (MIP-01) */
export const MARMOT_GROUP_DATA_VERSION = 2;

/** Extended extension types that include Marmot-specific extensions */
export const extendedExtensionTypes = {
  ...defaultExtensionTypes,
  marmot_group_data: MARMOT_GROUP_DATA_EXTENSION_TYPE,
  last_resort: LAST_RESORT_EXTENSION_TYPE,
} as const;

export type ExtendedExtensionTypeName = keyof typeof extendedExtensionTypes;
export type ExtendedExtensionTypeValue =
  (typeof extendedExtensionTypes)[ExtendedExtensionTypeName];

/**
 * Represents the decoded Marmot Group Data Extension structure.
 */
export interface MarmotGroupData {
  /** Extension format version number (current: 2) */
  version: number;
  /** 32-byte identifier for the group used in Nostr protocol operations */
  nostrGroupId: Uint8Array;
  /** UTF-8 encoded group name */
  name: string;
  /** UTF-8 encoded group description */
  description: string;
  /** Array of 32-byte Nostr x-only public keys (hex-encoded strings) */
  adminPubkeys: string[];
  /** Array of WebSocket URLs for Nostr relays */
  relays: string[];
  /** SHA-256 hash of the encrypted group image (empty when no image) */
  imageHash: Uint8Array;
  /** Image encryption seed (empty when no image) */
  imageKey: Uint8Array;
  /** ChaCha20-Poly1305 nonce for group image encryption (empty when no image) */
  imageNonce: Uint8Array;
  /** Image upload seed for deterministic Blossom upload identity (empty when no image) */
  imageUploadKey: Uint8Array;
}

/** Event kind for group events (commits, proposals, application messages) */
export const GROUP_EVENT_KIND = 445;

/** Event kind for welcome events */
export const WELCOME_EVENT_KIND = 444;
