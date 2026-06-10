/** @module @category Core - Constants */
import { defaultExtensionTypes } from "ts-mls";

/** The extension id for the last_resort extension for key packages */
export const LAST_RESORT_EXTENSION_TYPE = 0x000a;

/** Event kind for key package relay list events */
export const KEY_PACKAGE_RELAY_LIST_KIND = 10051;

/** The name of the tag that contains relay URLs */
export const KEY_PACKAGE_RELAY_LIST_RELAY_TAG = "relay";

/** Event kind for key package events (legacy, read/delete only — do not publish new events of this kind) */
export const KEY_PACKAGE_KIND = 443;

/** Event kind for addressable key package events */
export const ADDRESSABLE_KEY_PACKAGE_KIND = 30443;

/** The name of the tag that contains the MLS protocol version */
export const KEY_PACKAGE_MLS_VERSION_TAG = "mls_protocol_version";

/** The name of the tag that contains the MLS cipher suite */
export const KEY_PACKAGE_CIPHER_SUITE_TAG = "mls_ciphersuite";

/** The name of the tag that contains the MLS extensions */
export const KEY_PACKAGE_EXTENSIONS_TAG = "mls_extensions";

/** The name of the tag that contains the supported MLS proposal ids */
export const KEY_PACKAGE_PROPOSALS_TAG = "mls_proposals";

/** The name of the tag that contains the supported Marmot app-component ids */
export const KEY_PACKAGE_APP_COMPONENTS_TAG = "app_components";

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

/** Extended extension types that include Marmot-specific extensions */
export const extendedExtensionTypes = {
  ...defaultExtensionTypes,
  last_resort: LAST_RESORT_EXTENSION_TYPE,
} as const;

export type ExtendedExtensionTypeName = keyof typeof extendedExtensionTypes;
export type ExtendedExtensionTypeValue =
  (typeof extendedExtensionTypes)[ExtendedExtensionTypeName];

/** Event kind for group events (commits, proposals, application messages) */
export const GROUP_EVENT_KIND = 445;

/** Event kind for welcome events */
export const WELCOME_EVENT_KIND = 444;
