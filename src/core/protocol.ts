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

// ---------------------------------------------------------------------------
// MIP-05: Push Notifications
// ---------------------------------------------------------------------------

/** Event kind for push notification server discovery (kind:10050) */
export const NOTIFICATION_SERVER_KIND = 10050;

/** Event kind for the notification trigger gift wrap rumor (kind:446) */
export const NOTIFICATION_TRIGGER_KIND = 446;

/** Event kind for Token Request — sent on group join or token refresh (kind:447) */
export const TOKEN_REQUEST_KIND = 447;

/** Event kind for Token List Response — any member may reply to a 447 (kind:448) */
export const TOKEN_LIST_RESPONSE_KIND = 448;

/** Event kind for Token Removal — sent when disabling notifications (kind:449) */
export const TOKEN_REMOVAL_KIND = 449;

/** Platform byte for APNs (Apple Push Notification service) tokens */
export const MIP05_PLATFORM_APNS = 0x01;

/** Platform byte for FCM (Firebase Cloud Messaging) tokens */
export const MIP05_PLATFORM_FCM = 0x02;

/** Platform byte for Web Push / RFC 8030 tokens */
export const MIP05_PLATFORM_WEB_PUSH = 0x03;

/** APNs device token size in bytes (always 32 bytes binary) */
export const MIP05_APNS_TOKEN_SIZE = 32;

/** Maximum FCM registration token size in bytes (512 - 1 platform - 2 length = 509) */
export const MIP05_FCM_TOKEN_MAX_BYTES = 509;

/** HKDF salt used in MIP-05 token encryption: "mip05-v1" */
export const MIP05_HKDF_SALT = "mip05-v1";

/** HKDF expand info used in MIP-05 token encryption: "mip05-token-encryption" */
export const MIP05_HKDF_INFO = "mip05-token-encryption";

/** Size (bytes) of an encrypted MIP-05 token: ephemeral_pubkey(32) + nonce(12) + ciphertext(528) */
export const MIP05_ENCRYPTED_TOKEN_SIZE = 572;

/** Size (bytes) of the padded plaintext payload before encryption */
export const MIP05_PADDED_PAYLOAD_SIZE = 512;

/** Maximum Web Push endpoint URL length in bytes */
export const MIP05_MAX_ENDPOINT_BYTES = 428;

/** Maximum number of encrypted tokens per kind:446 notification trigger event */
export const MIP05_TOKEN_BATCH_LIMIT = 50;

/** Maximum token age in days; tokens older than this SHOULD be pruned */
export const MIP05_TOKEN_MAX_AGE_DAYS = 35;
