/** @module @category Core - Client State */
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  ClientConfig,
  ClientState,
  clientStateDecoder,
  clientStateEncoder,
  ciphersuites,
  decode,
  defaultAppDataUpdateCallback,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  getAppDataDictionary,
  GroupInfo,
  nodeTypes,
  encode,
} from "ts-mls";
import {
  AGENT_TEXT_STREAM_QUIC_COMPONENT,
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  type EncryptedMediaPolicyV1,
  GROUP_ADMIN_POLICY_COMPONENT,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_AVATAR_URL_COMPONENT,
  GROUP_AVATAR_URL_COMPONENT_ID,
  GROUP_BLOSSOM_IMAGE_COMPONENT,
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_COMPONENT,
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT,
  GROUP_PROFILE_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT,
  NOSTR_ROUTING_COMPONENT_ID,
  decodeAdminPolicyV1,
  decodeAgentTextStreamQuicPolicyV1,
  decodeComponentsList,
  decodeEncryptedMediaPolicyV1,
  decodeGroupAvatarUrlV1,
  decodeGroupProfileV1,
  decodeMessageRetentionV1,
  decodeNostrRoutingV1,
  getAdminPolicy,
  getEncryptedMediaPolicy,
  getGroupAvatarUrl,
  getGroupProfile,
  getMessageRetention,
  getNostrRouting,
} from "./components/index.js";
import { getGroupMembers } from "./group-members.js";

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
 * group-scoped components in the MLS `app_data_dictionary` extension. This is
 * the v2 replacement for the legacy `MarmotGroupData` monolith.
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
  /** Group avatar URL (`group.avatar-url.v1`, `0x8007`), if set. */
  avatarUrl?: string;
  /**
   * Group encrypted-media policy (`group.encrypted-media.v1`, `0x8008`): the
   * group-scoped blob-store endpoints and format, if set.
   */
  encryptedMedia?: EncryptedMediaPolicyV1;
  /**
   * Message-retention window in seconds (`message-retention.v1`, `0x8005`), if
   * set; `0n` means retain indefinitely.
   */
  messageRetention?: bigint;
}

export type MarmotGroupDecodedComponent =
  number[] | string[] | string | bigint | object;

/** Raw and decoded details for one app component in the MLS app_data_dictionary. */
export interface MarmotGroupComponentInfo {
  /** Numeric MLS ComponentID. */
  id: number;
  /** Hex ComponentID, padded to uint16 width for display. */
  idHex: string;
  /** Known Marmot component name, or `unknown` for unrecognized ids. */
  name: string;
  /** Raw component data byte length. */
  dataLength: number;
  /** Raw component data as hex for protocol debugging. */
  dataHex: string;
  /** Decoded known component payload. Omitted when the component is unknown or invalid. */
  decoded?: MarmotGroupDecodedComponent;
  /** Decode failure for a known component. */
  decodeError?: string;
}

/** Debug-oriented projection suitable for a chat/group info panel. */
export interface MarmotGroupInfo {
  /** MLS protocol identifiers and epoch state. */
  mls: {
    groupId: Uint8Array;
    groupIdHex: string;
    epoch: bigint;
    epochNumber: number;
    epochString: string;
    cipherSuite: number;
    cipherSuiteName?: string;
    treeHashHex: string;
    confirmedTranscriptHashHex: string;
    confirmationTagHex?: string;
    historicalEpochs: string[];
    memberCount: number;
    proposalCount: number;
  };
  /** Marmot app-component state carried by the MLS group context. */
  app: {
    view: MarmotGroupView | null;
    components: MarmotGroupComponentInfo[];
    componentCount: number;
    requiredComponentIds: number[];
    decodeError?: string;
  };
  /** Public Nostr transport routing identity and relay set. */
  nostr: {
    groupId?: Uint8Array;
    groupIdHex?: string;
    relays: string[];
    relayCount: number;
    hasRouting: boolean;
  };
  /** Member identity summary decoded from the ratchet tree. */
  members: {
    pubkeys: string[];
    count: number;
  };
}

const COMPONENT_NAMES = new Map<number, string>([
  [APP_COMPONENTS_COMPONENT_ID, "app_components"],
  [GROUP_PROFILE_COMPONENT_ID, GROUP_PROFILE_COMPONENT],
  [GROUP_BLOSSOM_IMAGE_COMPONENT_ID, GROUP_BLOSSOM_IMAGE_COMPONENT],
  [GROUP_ADMIN_POLICY_COMPONENT_ID, GROUP_ADMIN_POLICY_COMPONENT],
  [NOSTR_ROUTING_COMPONENT_ID, NOSTR_ROUTING_COMPONENT],
  [GROUP_MESSAGE_RETENTION_COMPONENT_ID, GROUP_MESSAGE_RETENTION_COMPONENT],
  [AGENT_TEXT_STREAM_QUIC_COMPONENT_ID, AGENT_TEXT_STREAM_QUIC_COMPONENT],
  [GROUP_AVATAR_URL_COMPONENT_ID, GROUP_AVATAR_URL_COMPONENT],
  [GROUP_ENCRYPTED_MEDIA_COMPONENT_ID, GROUP_ENCRYPTED_MEDIA_COMPONENT],
]);

const CIPHERSUITE_NAMES = new Map<number, string>(
  Object.entries(ciphersuites).map(([name, id]) => [id, name]),
);

function componentIdHex(id: number): string {
  return `0x${id.toString(16).padStart(4, "0")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeGroupComponent(
  componentId: number,
  data: Uint8Array,
): MarmotGroupDecodedComponent | undefined {
  switch (componentId) {
    case APP_COMPONENTS_COMPONENT_ID:
      return decodeComponentsList(data);
    case GROUP_PROFILE_COMPONENT_ID:
      return decodeGroupProfileV1(data);
    case GROUP_ADMIN_POLICY_COMPONENT_ID:
      return decodeAdminPolicyV1(data);
    case NOSTR_ROUTING_COMPONENT_ID: {
      const routing = decodeNostrRoutingV1(data);
      return {
        nostrGroupId: routing.nostrGroupId,
        nostrGroupIdHex: bytesToHex(routing.nostrGroupId),
        relays: routing.relays,
      };
    }
    case GROUP_MESSAGE_RETENTION_COMPONENT_ID:
      return decodeMessageRetentionV1(data);
    case AGENT_TEXT_STREAM_QUIC_COMPONENT_ID:
      return decodeAgentTextStreamQuicPolicyV1(data);
    case GROUP_AVATAR_URL_COMPONENT_ID:
      return decodeGroupAvatarUrlV1(data);
    case GROUP_ENCRYPTED_MEDIA_COMPONENT_ID:
      return decodeEncryptedMediaPolicyV1(data);
    default:
      return undefined;
  }
}

function getGroupComponentInfos(clientState: ClientState | GroupInfo): {
  components: MarmotGroupComponentInfo[];
  decodeError?: string;
} {
  let dictionary: ReturnType<typeof getAppDataDictionary>;
  try {
    dictionary = getAppDataDictionary(clientState.groupContext.extensions);
  } catch (error) {
    return { components: [], decodeError: errorMessage(error) };
  }

  const components = (dictionary ?? []).map((entry) => {
    const info: MarmotGroupComponentInfo = {
      id: entry.componentId,
      idHex: componentIdHex(entry.componentId),
      name: COMPONENT_NAMES.get(entry.componentId) ?? "unknown",
      dataLength: entry.data.length,
      dataHex: bytesToHex(entry.data),
    };

    try {
      const decoded = decodeGroupComponent(entry.componentId, entry.data);
      if (decoded !== undefined) info.decoded = decoded;
    } catch (error) {
      info.decodeError = errorMessage(error);
    }

    return info;
  });

  return { components };
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
    const avatar = getGroupAvatarUrl(extensions);
    const encryptedMedia = getEncryptedMediaPolicy(extensions);
    const messageRetention = getMessageRetention(extensions);

    if (!profile && !adminPubkeys && !routing) return null;

    return {
      nostrGroupId: routing?.nostrGroupId,
      name: profile?.name ?? "",
      description: profile?.description ?? "",
      adminPubkeys: adminPubkeys ?? [],
      relays: routing?.relays ?? [],
      avatarUrl: avatar?.url,
      encryptedMedia,
      messageRetention,
    };
  } catch {
    return null;
  }
}

function hasLocalClientState(
  state: ClientState | GroupInfo,
): state is ClientState {
  return "ratchetTree" in state;
}

/**
 * Builds a complete group information/debug projection from MLS state.
 *
 * This includes the private MLS group id and epoch details, decoded Marmot app
 * components, public Nostr routing details, and member identity summary.
 */
export function getMarmotGroupInfo(
  clientState: ClientState | GroupInfo,
): MarmotGroupInfo {
  const groupContext = clientState.groupContext;
  const view = getMarmotGroupView(clientState);
  const { components, decodeError } = getGroupComponentInfos(clientState);
  const appComponents = components.find(
    (component) => component.id === APP_COMPONENTS_COMPONENT_ID,
  );
  const requiredComponentIds = Array.isArray(appComponents?.decoded)
    ? appComponents.decoded.filter((id): id is number => typeof id === "number")
    : [];
  const members = hasLocalClientState(clientState)
    ? getGroupMembers(clientState)
    : [];

  return {
    mls: {
      groupId: groupContext.groupId,
      groupIdHex: bytesToHex(groupContext.groupId),
      epoch: groupContext.epoch,
      epochNumber: Number(groupContext.epoch),
      epochString: groupContext.epoch.toString(),
      cipherSuite: groupContext.cipherSuite,
      cipherSuiteName: CIPHERSUITE_NAMES.get(groupContext.cipherSuite),
      treeHashHex: bytesToHex(groupContext.treeHash),
      confirmedTranscriptHashHex: bytesToHex(
        groupContext.confirmedTranscriptHash,
      ),
      confirmationTagHex: hasLocalClientState(clientState)
        ? bytesToHex(clientState.confirmationTag)
        : undefined,
      historicalEpochs: hasLocalClientState(clientState)
        ? Array.from(clientState.historicalReceiverData.keys()).map((epoch) =>
            epoch.toString(),
          )
        : [],
      memberCount: hasLocalClientState(clientState)
        ? getMemberCount(clientState)
        : 0,
      proposalCount: hasLocalClientState(clientState)
        ? Object.keys(clientState.unappliedProposals).length
        : 0,
    },
    app: {
      view,
      components,
      componentCount: components.length,
      requiredComponentIds,
      decodeError,
    },
    nostr: {
      groupId: view?.nostrGroupId,
      groupIdHex: view?.nostrGroupId
        ? bytesToHex(view.nostrGroupId)
        : undefined,
      relays: view?.relays ?? [],
      relayCount: view?.relays.length ?? 0,
      hasRouting: !!view?.nostrGroupId,
    },
    members: {
      pubkeys: members,
      count: members.length,
    },
  };
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
