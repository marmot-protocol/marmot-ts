/** @module @category Core - App Components */
import {
  AppDataDictionary,
  ComponentData,
  CustomExtension,
  GroupContextExtension,
  getAppDataDictionary,
  makeAppDataDictionaryExtension,
} from "ts-mls";
import { UsageError } from "ts-mls";

import {
  AppComponentId,
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_AVATAR_URL_COMPONENT_ID,
  GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "./ids.js";
import {
  decodeComponentsList,
  encodeComponentsList,
} from "./app-components-list.js";
import {
  decodeGroupProfileV1,
  encodeGroupProfileV1,
  GroupProfileV1,
} from "./group-profile.js";
import { decodeAdminPolicyV1, encodeAdminPolicyV1 } from "./admin-policy.js";
import {
  decodeNostrRoutingV1,
  encodeNostrRoutingV1,
  NostrRoutingV1,
} from "./nostr-routing.js";
import {
  decodeMessageRetentionV1,
  encodeMessageRetentionV1,
} from "./message-retention.js";
import {
  decodeGroupAvatarUrlV1,
  encodeGroupAvatarUrlV1,
  GroupAvatarUrlV1,
} from "./avatar-url.js";
import {
  decodeEncryptedMediaPolicyV1,
  encodeEncryptedMediaPolicyV1,
  EncryptedMediaPolicyV1,
} from "./encrypted-media.js";
import {
  AgentTextStreamQuicPolicyV1,
  decodeAgentTextStreamQuicPolicyV1,
  encodeAgentTextStreamQuicPolicyV1,
} from "./agent-text-stream.js";

/**
 * Read + build helpers over the Marmot v2 app components carried in the MLS
 * `app_data_dictionary` GroupContext extension (`0x0006`).
 *
 * The dictionary container itself — `ComponentData { componentId, data }` sorted
 * by id, wrapped in the extension — is owned by ts-mls
 * ({@link getAppDataDictionary} / {@link makeAppDataDictionaryExtension}), which
 * binds it to the MLS transcript. This module is the generic registry over the
 * opaque `data` bytes plus typed accessors that run each component's codec.
 *
 * Mutation (emitting `app_data_update` proposals) lives alongside the commit
 * path; this module only reads existing state and builds the create-time
 * dictionary.
 */

// ---------------------------------------------------------------------------
// Generic core
// ---------------------------------------------------------------------------

/** Returns the raw component `data` bytes for a component id, or undefined. */
export function getComponentData(
  extensions: GroupContextExtension[],
  componentId: AppComponentId,
): Uint8Array | undefined {
  const dictionary = getAppDataDictionary(extensions);
  return dictionary?.find((c) => c.componentId === componentId)?.data;
}

/** Builds a single {@link ComponentData} entry. */
export function componentEntry(
  componentId: AppComponentId,
  data: Uint8Array,
): ComponentData {
  return { componentId, data };
}

/**
 * Builds an {@link AppDataDictionary} from entries, sorted ascending by
 * componentId. Throws on a duplicate component id.
 */
export function buildAppDataDictionary(
  entries: ComponentData[],
): AppDataDictionary {
  const sorted = [...entries].sort((a, b) => a.componentId - b.componentId);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].componentId === sorted[i].componentId) {
      throw new UsageError(
        `Duplicate app component id 0x${sorted[i].componentId.toString(16)}`,
      );
    }
  }
  return sorted;
}

/**
 * Builds the `app_data_dictionary` GroupContext extension from component
 * entries (sorting them first). Use at group creation to seed initial state.
 */
export function makeAppComponentsExtension(
  entries: ComponentData[],
): CustomExtension {
  return makeAppDataDictionaryExtension(buildAppDataDictionary(entries));
}

/**
 * Builds the `app_data_dictionary` extension carried on a key package's LeafNode
 * to advertise the component ids this member supports. The dictionary holds a
 * single `app_components` (`0x0001`) entry listing {@link SUPPORTED_APP_COMPONENT_IDS}
 * (or the given override). Mirrors darkmatter's `leaf_app_components_extension`.
 */
export function makeLeafAppComponentsExtension(
  supportedIds: readonly AppComponentId[] = SUPPORTED_APP_COMPONENT_IDS,
): CustomExtension {
  return makeAppComponentsExtension([appComponentsEntry([...supportedIds])]);
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

function decodeOrUndefined<T>(
  data: Uint8Array | undefined,
  decode: (d: Uint8Array) => T,
): T | undefined {
  return data === undefined ? undefined : decode(data);
}

/** The `app_components` advertising list (`0x0001`). */
export function getAppComponents(
  extensions: GroupContextExtension[],
): AppComponentId[] | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, APP_COMPONENTS_COMPONENT_ID),
    decodeComponentsList,
  );
}

/** The `group.profile.v1` component (`0x8001`). */
export function getGroupProfile(
  extensions: GroupContextExtension[],
): GroupProfileV1 | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, GROUP_PROFILE_COMPONENT_ID),
    decodeGroupProfileV1,
  );
}

/** The `admin-policy.v1` admin pubkey set (`0x8003`). */
export function getAdminPolicy(
  extensions: GroupContextExtension[],
): string[] | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, GROUP_ADMIN_POLICY_COMPONENT_ID),
    decodeAdminPolicyV1,
  );
}

/** The `transport.nostr.routing.v1` component (`0x8004`). */
export function getNostrRouting(
  extensions: GroupContextExtension[],
): NostrRoutingV1 | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, NOSTR_ROUTING_COMPONENT_ID),
    decodeNostrRoutingV1,
  );
}

/** The `message-retention.v1` timer in seconds (`0x8005`). */
export function getMessageRetention(
  extensions: GroupContextExtension[],
): bigint | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, GROUP_MESSAGE_RETENTION_COMPONENT_ID),
    decodeMessageRetentionV1,
  );
}

/** The `agent-text-stream.quic.v1` policy (`0x8006`). */
export function getAgentTextStreamPolicy(
  extensions: GroupContextExtension[],
): AgentTextStreamQuicPolicyV1 | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, AGENT_TEXT_STREAM_QUIC_COMPONENT_ID),
    decodeAgentTextStreamQuicPolicyV1,
  );
}

/** The `group.avatar-url.v1` component (`0x8007`). */
export function getGroupAvatarUrl(
  extensions: GroupContextExtension[],
): GroupAvatarUrlV1 | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, GROUP_AVATAR_URL_COMPONENT_ID),
    decodeGroupAvatarUrlV1,
  );
}

/** The `group.encrypted-media.v1` policy (`0x8008`). */
export function getEncryptedMediaPolicy(
  extensions: GroupContextExtension[],
): EncryptedMediaPolicyV1 | undefined {
  return decodeOrUndefined(
    getComponentData(extensions, GROUP_ENCRYPTED_MEDIA_COMPONENT_ID),
    decodeEncryptedMediaPolicyV1,
  );
}

// ---------------------------------------------------------------------------
// Typed entry builders (for create-time dictionaries and updates)
// ---------------------------------------------------------------------------

/** Builds the `app_components` advertising entry from a list of ids. */
export function appComponentsEntry(ids: AppComponentId[]): ComponentData {
  return componentEntry(APP_COMPONENTS_COMPONENT_ID, encodeComponentsList(ids));
}

/** Builds the `group.profile.v1` entry. */
export function groupProfileEntry(profile: GroupProfileV1): ComponentData {
  return componentEntry(
    GROUP_PROFILE_COMPONENT_ID,
    encodeGroupProfileV1(profile),
  );
}

/** Builds the `admin-policy.v1` entry from hex admin pubkeys. */
export function adminPolicyEntry(adminPubkeys: string[]): ComponentData {
  return componentEntry(
    GROUP_ADMIN_POLICY_COMPONENT_ID,
    encodeAdminPolicyV1(adminPubkeys),
  );
}

/** Builds the `transport.nostr.routing.v1` entry. */
export function nostrRoutingEntry(routing: NostrRoutingV1): ComponentData {
  return componentEntry(
    NOSTR_ROUTING_COMPONENT_ID,
    encodeNostrRoutingV1(routing),
  );
}

/** Builds the `message-retention.v1` entry. */
export function messageRetentionEntry(seconds: number | bigint): ComponentData {
  return componentEntry(
    GROUP_MESSAGE_RETENTION_COMPONENT_ID,
    encodeMessageRetentionV1(seconds),
  );
}

/** Builds the `agent-text-stream.quic.v1` entry. */
export function agentTextStreamEntry(
  policy: AgentTextStreamQuicPolicyV1,
): ComponentData {
  return componentEntry(
    AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
    encodeAgentTextStreamQuicPolicyV1(policy),
  );
}

/** Builds the `group.avatar-url.v1` entry. */
export function groupAvatarUrlEntry(avatar: GroupAvatarUrlV1): ComponentData {
  return componentEntry(
    GROUP_AVATAR_URL_COMPONENT_ID,
    encodeGroupAvatarUrlV1(avatar),
  );
}

/** Builds the `group.encrypted-media.v1` entry. */
export function encryptedMediaEntry(
  policy: EncryptedMediaPolicyV1,
): ComponentData {
  return componentEntry(
    GROUP_ENCRYPTED_MEDIA_COMPONENT_ID,
    encodeEncryptedMediaPolicyV1(policy),
  );
}
