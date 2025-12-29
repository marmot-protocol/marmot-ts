import { bytesToHex } from "@noble/hashes/utils.js";
import { ClientConfig, defaultClientConfig } from "ts-mls/clientConfig.js";
import {
  ClientState,
  encodeGroupState,
  decodeGroupState,
} from "ts-mls/clientState.js";
import { Extension } from "ts-mls/extension.js";
import { marmotAuthService } from "./auth-service.js";
import { decodeMarmotGroupData } from "./marmot-group-data.js";
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE,
  MarmotGroupData,
} from "./protocol.js";

/** Default ClientConfig for Marmot */
export const defaultMarmotClientConfig = {
  ...defaultClientConfig,
  auth_service: marmotAuthService,
};

/**
 * Extracts MarmotGroupData from a ClientState's extensions.
 *
 * @param clientState - The ClientState to extract data from
 * @returns The MarmotGroupData if found, null otherwise
 */
export function extractMarmotGroupData(
  clientState: ClientState,
): MarmotGroupData | null {
  try {
    const marmotExtension = clientState.groupContext.extensions.find(
      (ext: Extension) =>
        typeof ext.extensionType === "number" &&
        ext.extensionType === MARMOT_GROUP_DATA_EXTENSION_TYPE,
    );

    if (!marmotExtension) return null;

    return decodeMarmotGroupData(marmotExtension.extensionData);
  } catch (error) {
    console.error("Failed to extract MarmotGroupData:", error);
    return null;
  }
}

/**
 * Gets the group ID from ClientState as a hex string.
 *
 * @param clientState - The ClientState to get group ID from
 * @returns Hex string representation of the group ID
 */
export function getGroupIdHex(clientState: ClientState): string {
  return bytesToHex(clientState.groupContext.groupId);
}

/**
 * Gets the Nostr group ID from ClientState as a hex string.
 *
 * @param clientState - The ClientState to get Nostr group ID from
 * @returns Hex string representation of the Nostr group ID
 */
export function getNostrGroupIdHex(clientState: ClientState): string {
  const marmotData = extractMarmotGroupData(clientState);
  if (!marmotData) {
    throw new Error("MarmotGroupData not found in ClientState");
  }
  return bytesToHex(marmotData.nostrGroupId);
}

/**
 * Gets the current epoch from ClientState.
 *
 * @param clientState - The ClientState to get epoch from
 * @returns The current epoch number
 */
export function getEpoch(clientState: ClientState): number {
  return Number(clientState.groupContext.epoch);
}

/**
 * Gets the member count from ClientState.
 *
 * @param clientState - The ClientState to get member count from
 * @returns The number of members in the group
 */
export function getMemberCount(clientState: ClientState): number {
  return clientState.ratchetTree.filter(
    (node) => node && node.nodeType === "leaf",
  ).length;
}

/**
 * The serialized form of ClientState for storage.
 * Uses binary TLS encoding provided by ts-mls library.
 */
export type SerializedClientState = Uint8Array;

/**
 * Serializes a ClientState object for storage.
 * Uses the ts-mls library's binary encoding (TLS format).
 *
 * @param state - The ClientState to serialize
 * @returns Binary representation of the state
 */
export function serializeClientState(
  state: ClientState,
): SerializedClientState {
  return encodeGroupState(state);
}

/**
 * Deserializes a stored client state back into a ClientState object.
 * Uses the ts-mls library's binary decoding (TLS format).
 * Re-injects the ClientConfig.
 *
 * @param stored - The stored binary state
 * @param config - The ClientConfig to inject (contains AuthenticationService)
 * @returns The reconstructed ClientState
 */
export function deserializeClientState(
  stored: SerializedClientState,
  config: ClientConfig,
): ClientState {
  try {
    const decoded = decodeGroupState(stored, 0);
    if (!decoded) {
      throw new Error(
        "Failed to deserialize ClientState: decodeGroupState returned null",
      );
    }
    // Inject the config back into the state
    return { ...decoded[0], clientConfig: config };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to deserialize ClientState: ${error.message}`);
    }
    throw new Error("Failed to deserialize ClientState: Unknown error");
  }
}
