/** @module @category Client - Proposals */
import {
  appDataUpdateProposalType,
  type ComponentData,
  type Proposal,
  type ProposalAppDataUpdate,
} from "ts-mls";

import {
  adminPolicyEntry,
  appComponentsEntry,
  getAppComponents,
  GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
  type EncryptedMediaPolicyV2,
  encryptedMediaEntry,
  groupAvatarUrlEntry,
  groupProfileEntry,
  messageRetentionEntry,
  nostrRoutingEntry,
} from "../../../core/components/index.js";
import type { ProposalAction } from "../marmot-group.js";

/** A partial update to a group's app-component metadata. */
export interface UpdateGroupMetadata {
  /** New group display name (group.profile.v1). */
  name?: string;
  /** New group description (group.profile.v1). */
  description?: string;
  /** New admin pubkey set (admin-policy.v1). */
  adminPubkeys?: string[];
  /** New relay set (transport.nostr.routing.v1). */
  relays?: string[];
  /** New nostr group id (transport.nostr.routing.v1). */
  nostrGroupId?: Uint8Array;
  /** New group avatar URL (group.avatar-url.v1). */
  avatarUrl?: string;
  /** New encrypted-media policy (group.encrypted-media.v2). */
  encryptedMedia?: EncryptedMediaPolicyV2;
  /**
   * New message-retention window in seconds (message-retention.v1); `0` retains
   * indefinitely.
   */
  messageRetention?: number | bigint;
}

/** Wraps a component entry in a full-replacement `app_data_update` proposal. */
function componentUpdate(entry: ComponentData): ProposalAppDataUpdate {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: {
      componentId: entry.componentId,
      operation: "update",
      update: entry.data,
    },
  };
}

/**
 * Builds `app_data_update` proposals that update a group's app-component
 * metadata. Each changed component is re-encoded in full (matching the default
 * last-update-wins merge), so unchanged fields are read from the current group
 * view. Touches only the components whose fields are present in `metadata`.
 */
export function proposeUpdateMetadata(
  metadata: UpdateGroupMetadata,
): ProposalAction<Proposal[]> {
  return async ({ groupData }) => {
    const proposals: ProposalAppDataUpdate[] = [];

    if (metadata.name !== undefined || metadata.description !== undefined) {
      proposals.push(
        componentUpdate(
          groupProfileEntry({
            name: metadata.name ?? groupData.name,
            description: metadata.description ?? groupData.description,
          }),
        ),
      );
    }

    if (metadata.adminPubkeys !== undefined) {
      proposals.push(componentUpdate(adminPolicyEntry(metadata.adminPubkeys)));
    }

    if (metadata.relays !== undefined || metadata.nostrGroupId !== undefined) {
      const nostrGroupId = metadata.nostrGroupId ?? groupData.nostrGroupId;
      if (!nostrGroupId)
        throw new Error(
          "Cannot update nostr routing: the group has no nostr group id",
        );
      proposals.push(
        componentUpdate(
          nostrRoutingEntry({
            nostrGroupId,
            relays: metadata.relays ?? groupData.relays,
          }),
        ),
      );
    }

    if (metadata.avatarUrl !== undefined) {
      proposals.push(
        componentUpdate(groupAvatarUrlEntry({ url: metadata.avatarUrl })),
      );
    }

    if (metadata.encryptedMedia !== undefined) {
      proposals.push(
        componentUpdate(encryptedMediaEntry(metadata.encryptedMedia)),
      );
    }

    if (metadata.messageRetention !== undefined) {
      proposals.push(
        componentUpdate(messageRetentionEntry(metadata.messageRetention)),
      );
    }

    return proposals;
  };
}

/**
 * Atomically activate/replace or remove v2 policy and its requirement.
 * The engine validates admin authority and resulting member capabilities.
 * Unsupported legacy-profile parents remain unsupported.
 */
export function proposeSetEncryptedMediaPolicy(
  policy: EncryptedMediaPolicyV2 | null,
  required = true,
): ProposalAction<Proposal[]> {
  return async ({ state }) => {
    const current = getAppComponents(state.groupContext.extensions) ?? [];
    const next = current.filter(
      (id) => id !== GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
    );
    if (policy && required) next.push(GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID);
    return [
      componentUpdate(appComponentsEntry(next)),
      policy
        ? componentUpdate(encryptedMediaEntry(policy))
        : {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
              operation: "remove",
            },
          },
    ];
  };
}
