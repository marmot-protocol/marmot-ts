import { bytesToHex } from "@noble/hashes/utils.js";
import { defaultClientConfig } from "ts-mls/clientConfig.js";
import { ClientState, encode, decode, nodeTypes } from "ts-mls";
import { clientStateEncoder, clientStateDecoder } from "ts-mls/clientState.js";
import {
  decodeMarmotGroupData,
  getMarmotGroupDataExtensionBytes,
  isMarmotGroupDataExtension,
} from "./marmot-group-data.js";
import { MarmotGroupData } from "./protocol.js";

/** Default ClientConfig for Marmot. */
export const defaultMarmotClientConfig = {
  ...defaultClientConfig,
};

export function extractMarmotGroupData(
  clientState: ClientState,
): MarmotGroupData | null {
  try {
    const marmotExtension = clientState.groupContext.extensions.find(
      isMarmotGroupDataExtension,
    );

    if (!marmotExtension) return null;

    return decodeMarmotGroupData(
      getMarmotGroupDataExtensionBytes(marmotExtension),
    );
  } catch (error) {
    console.error("Failed to extract MarmotGroupData:", error);
    return null;
  }
}

export function getGroupIdHex(clientState: ClientState): string {
  return bytesToHex(clientState.groupContext.groupId);
}

export function getNostrGroupIdHex(clientState: ClientState): string {
  const marmotData = extractMarmotGroupData(clientState);
  if (!marmotData) {
    throw new Error("MarmotGroupData not found in ClientState");
  }
  return bytesToHex(marmotData.nostrGroupId);
}

export function getEpoch(clientState: ClientState): number {
  return Number(clientState.groupContext.epoch);
}

export function getMemberCount(clientState: ClientState): number {
  return clientState.ratchetTree.filter(
    (node) => node && node.nodeType === nodeTypes.leaf,
  ).length;
}

/** The serialized form of ClientState for storage (ts-mls TLS encoding). */
export type SerializedClientState = Uint8Array;

export function serializeClientState(
  state: ClientState,
): SerializedClientState {
  return encode(clientStateEncoder, state);
}

/** Deserializes stored ClientState bytes (ts-mls TLS decoding). */
export function deserializeClientState(
  stored: SerializedClientState,
): ClientState {
  try {
    const decoded = decode(clientStateDecoder, stored);
    if (!decoded) {
      throw new Error(
        "Failed to deserialize ClientState: clientStateDecoder returned null",
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to deserialize ClientState: ${error.message}`);
    }
    throw new Error("Failed to deserialize ClientState: Unknown error");
  }
}
