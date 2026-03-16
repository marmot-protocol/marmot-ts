import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ClientConfig,
  ClientState,
  clientStateDecoder,
  clientStateEncoder,
  decode,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  GroupInfo,
  nodeTypes,
  encode,
} from "ts-mls";
import {
  decodeMarmotGroupData,
  isMarmotGroupDataExtension,
} from "./marmot-group-data.js";
import { MarmotGroupData } from "./protocol.js";

/** Default ClientConfig for Marmot. */
export const defaultMarmotClientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
};

/** Reads the MarmotGroupData from a ClientState or GroupInfo objects */
export function getMarmotGroupData(
  clientState: ClientState | GroupInfo,
): MarmotGroupData | null {
  try {
    const marmotExtension = clientState.groupContext.extensions.find(
      isMarmotGroupDataExtension,
    );

    if (!marmotExtension) return null;

    return decodeMarmotGroupData(marmotExtension.extensionData);
  } catch (error) {
    return null;
  }
}

/** @deprecated use getMarmotGroupData instead */
export const extractMarmotGroupData = getMarmotGroupData;

/** Reads the hex id of the group from a ClientState or GroupInfo object */
export function getGroupIdHex(clientState: ClientState | GroupInfo): string {
  return bytesToHex(clientState.groupContext.groupId);
}

export function getNostrGroupIdHex(clientState: ClientState): string {
  const marmotData = getMarmotGroupData(clientState);
  if (!marmotData) throw new Error("MarmotGroupData not found in ClientState");

  return bytesToHex(marmotData.nostrGroupId);
}

/** Reads the epoch number from a ClientState or GroupInfo object */
export function getEpoch(clientState: ClientState | GroupInfo): number {
  return Number(clientState.groupContext.epoch);
}

/** Reads the number of members in the group from a ClientState ratchet tree */
export function getMemberCount(clientState: ClientState): number {
  return clientState.ratchetTree.filter(
    (node) => node && node.nodeType === nodeTypes.leaf,
  ).length;
}

/** The serialized form of ClientState for storage (ts-mls TLS encoding). */
export type SerializedClientState = Uint8Array;

/** Serializes a ClientState object to a bytes array */
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
    if (!decoded)
      throw new Error(
        "Failed to deserialize ClientState: clientStateDecoder returned null",
      );

    return decoded;
  } catch (error) {
    if (error instanceof Error)
      throw new Error(`Failed to deserialize ClientState: ${error.message}`);

    throw new Error("Failed to deserialize ClientState: Unknown error");
  }
}
