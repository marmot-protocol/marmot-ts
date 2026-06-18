/** @module @category Core - Key Package Event */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventTemplate } from "applesauce-core/helpers/event";
import {
  CustomExtension,
  encode,
  KeyPackage,
  type MlsKeyPackage,
  mlsMessageEncoder,
  protocolVersions,
  wireformats,
} from "ts-mls";
import { encodeContent } from "../utils/encoding.js";
import { unixNow } from "../utils/nostr.js";
import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import { isGreaseValue } from "./grease.js";
import { calculateKeyPackageRef } from "./key-package.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  KEY_PACKAGE_APP_COMPONENTS_TAG,
  KEY_PACKAGE_CIPHER_SUITE_TAG,
  KEY_PACKAGE_CLIENT_TAG,
  KEY_PACKAGE_EXTENSIONS_TAG,
  KEY_PACKAGE_MLS_VERSION_TAG,
  KEY_PACKAGE_PROPOSALS_TAG,
  KEY_PACKAGE_RELAYS_TAG,
} from "./protocol.js";
import { SUPPORTED_APP_COMPONENT_IDS } from "./components/ids.js";

export type CreateKeyPackageEventOptions = {
  keyPackage: KeyPackage;
  /**
   * The addressable slot identifier (`d` tag value). Required — callers must
   * supply this; {@link KeyPackageManager} handles defaulting to `clientId` or
   * throwing {@link MissingSlotIdentifierError} when none is available.
   */
  identifier: string;
  /** Relay URLs to advertise in the event */
  relays?: string[];
  client?: string;
  /**
   * Whether to include the NIP-70 protected tag (["-"]).
   *
   * Per MIP-00 this SHOULD be omitted by default because many relays reject
   * protected events.
   */
  protected?: boolean;
};

/**
 * Creates an addressable key package event (kind 30443) from a key package.
 *
 * @param options - The options for creating the key package event
 * @returns The unsigned key package event template
 */
export function createKeyPackageEvent(
  options: CreateKeyPackageEventOptions,
): Promise<EventTemplate> {
  return createKeyPackageEventInternal(options);
}

async function createKeyPackageEventInternal(
  options: CreateKeyPackageEventOptions,
): Promise<EventTemplate> {
  const { keyPackage, relays, client } = options;

  // Publish the KeyPackage wrapped in an MLSMessage with wire_format
  // mls_key_package (RFC 9420 §6). The kind-30443 content is specified as the
  // serialized MLSMessage bytes (transports/nostr.md), mirroring the kind-444
  // welcome framing, and this is what the darkmatter reference engine and
  // deployed clients (e.g. White Noise) publish and expect. getKeyPackage
  // still tolerates a bare KeyPackage on read for backwards compatibility.
  const mlsMessage: MlsKeyPackage = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_key_package,
    keyPackage,
  };
  const encodedBytes = encode(mlsMessageEncoder, mlsMessage);
  const content = encodeContent(encodedBytes, "base64");

  // Get the cipher suite from the key package
  // ts-mls v2: keyPackage.cipherSuite is a numeric id already
  const ciphersuiteHex = `0x${keyPackage.cipherSuite
    .toString(16)
    .padStart(4, "0")}`;

  // Extract extension types from the key package extensions
  const extensionTypes = keyPackage.extensions.map((ext: CustomExtension) => {
    // Extension type is now always a number in v2
    return `0x${ext.extensionType.toString(16).padStart(4, "0")}`;
  });

  // Also include extensions from leaf node capabilities to signal support
  // This ensures Marmot Group Data Extension (0xf2ee) is included in the event
  if (keyPackage.leafNode.capabilities?.extensions) {
    for (const extType of keyPackage.leafNode.capabilities.extensions) {
      // Only add if not already present (avoid duplicates)
      const hexValue = `0x${extType.toString(16).padStart(4, "0")}`;
      if (!extensionTypes.includes(hexValue)) {
        extensionTypes.push(hexValue);
      }
    }
  }

  // Filter out GREASE values from the extension types
  // We only want to include actual extensions (last_resort and Marmot Group Data Extension)
  const filteredExtensionTypes = extensionTypes.filter((hexValue) => {
    // Parse the hex value back to number to check if it's a GREASE value
    const extType = parseInt(hexValue);
    return !isGreaseValue(extType);
  });

  // Get the protocol version - keyPackage.version is a numeric ProtocolVersionValue
  // NIP tag expects a display string like "1.0".
  const versionName = (
    Object.keys(protocolVersions) as Array<keyof typeof protocolVersions>
  ).find((k) => protocolVersions[k] === keyPackage.version);
  const version = versionName === "mls10" ? "1.0" : String(keyPackage.version);

  // Build tags
  const tags: string[][] = [];

  // NIP-70: protected event — relay must not serve this event to non-authors.
  // NOTE: Optional/opt-in because many popular relays reject protected events.
  if (options.protected) tags.push(["-"]);

  // Addressable identifier (required for kind 30443)
  tags.push(["d", options.identifier]);

  // Supported MLS proposal ids advertised by this leaf (e.g. app_data_update
  // 0x0008), formatted as lowercase 0x-prefixed hex; GREASE values dropped.
  const proposalTypes = (keyPackage.leafNode.capabilities?.proposals ?? [])
    .filter((p) => !isGreaseValue(p))
    .map((p) => `0x${p.toString(16).padStart(4, "0")}`);

  // Supported Marmot app-component ids this implementation can encode/decode.
  const appComponentIds = SUPPORTED_APP_COMPONENT_IDS.map(
    (id) => `0x${id.toString(16).padStart(4, "0")}`,
  );

  // The spec forbids an `encoding` tag (transports/nostr.md "Transport byte
  // encoding"); content is always standard base64.
  tags.push(
    [KEY_PACKAGE_MLS_VERSION_TAG, version],
    [KEY_PACKAGE_CIPHER_SUITE_TAG, ciphersuiteHex],
    [KEY_PACKAGE_EXTENSIONS_TAG, ...filteredExtensionTypes],
    [KEY_PACKAGE_PROPOSALS_TAG, ...proposalTypes],
    [KEY_PACKAGE_APP_COMPONENTS_TAG, ...appComponentIds],
  );

  // MIP-00: required KeyPackageRef tag ("i")
  const keyPackageRef = await calculateKeyPackageRef(keyPackage);
  tags.push(["i", bytesToHex(keyPackageRef)]);

  // Add client tag if provided
  if (client) tags.push([KEY_PACKAGE_CLIENT_TAG, client]);

  // Add relay tags if provided
  if (relays && relays.length > 0) {
    const validRelays = relays.filter(isValidRelayUrl).map(normalizeRelayUrl);
    if (validRelays.length > 0) {
      tags.push([KEY_PACKAGE_RELAYS_TAG, ...validRelays]);
    }
  }

  return {
    kind: ADDRESSABLE_KEY_PACKAGE_KIND,
    created_at: unixNow(),
    content,
    tags,
  };
}
