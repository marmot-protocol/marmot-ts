/** @module @category Core - Client State */
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ClientConfig,
  ClientState,
  clientStateDecoder,
  clientStateEncoder,
  decode,
  defaultAppDataUpdateCallback,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  GroupInfo,
  nodeTypes,
  encode,
} from "ts-mls";
import {
  getAdminPolicy,
  getGroupProfile,
  getNostrRouting,
} from "./components/index.js";

/** Default ClientConfig for Marmot. */
export const defaultMarmotClientConfig: ClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  // Marmot v2 app components use full-replacement update payloads, so the
  // default last-update-wins callback is the correct merge policy.
  appDataUpdateCallback: defaultAppDataUpdateCallback,
};

/**
 * A read projection of a Marmot group's app-component state, assembled from the
 * `group.profile.v1`, `admin-policy.v1`, and `transport.nostr.routing.v1`
 * components in the MLS `app_data_dictionary` extension. This is the v2
 * replacement for the legacy `MarmotGroupData` monolith.
 */
export interface MarmotGroupView {
  /** Public 32-byte nostr group id (from nostr routing), if routing is set. */
  nostrGroupId?: Uint8Array;
  /** Group display name (from the profile component). */
  name: string;
  /** Group description (from the profile component). */
  description: string;
  /** Admin nostr pubkeys (hex), from the admin-policy component. */
  adminPubkeys: string[];
  /** Nostr relay URLs (from nostr routing). */
  relays: string[];
}

/**
 * Reads the Marmot group view from a ClientState or GroupInfo. Returns null when
 * the group carries no recognizable app components.
 */
export function getMarmotGroupView(
  clientState: ClientState | GroupInfo,
): MarmotGroupView | null {
  const extensions = clientState.groupContext.extensions;
  try {
    const profile = getGroupProfile(extensions);
    const adminPubkeys = getAdminPolicy(extensions);
    const routing = getNostrRouting(extensions);

    if (!profile && !adminPubkeys && !routing) return null;

    return {
      nostrGroupId: routing?.nostrGroupId,
      name: profile?.name ?? "",
      description: profile?.description ?? "",
      adminPubkeys: adminPubkeys ?? [],
      relays: routing?.relays ?? [],
    };
  } catch {
    return null;
  }
}

/** Reads the hex id of the group from a ClientState or GroupInfo object */
export function getGroupIdHex(clientState: ClientState | GroupInfo): string {
  return bytesToHex(clientState.groupContext.groupId);
}

export function getNostrGroupIdHex(clientState: ClientState): string {
  const routing = getNostrRouting(clientState.groupContext.extensions);
  if (!routing)
    throw new Error("nostr routing component not found in ClientState");

  return bytesToHex(routing.nostrGroupId);
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
