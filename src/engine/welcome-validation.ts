/** @module @category Engine */
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  type ClientState,
  defaultExtensionTypes,
  type ExtensionRequiredCapabilities,
  getAppDataDictionary,
  type GroupContextExtension,
  nodeTypes,
} from "ts-mls";

import {
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_ROLE_FANOUT,
  AGENT_TEXT_STREAM_ROLE_RECEIVE,
  AGENT_TEXT_STREAM_ROLE_SEND,
  decodeAgentTextStreamQuicPolicyV1,
} from "../core/components/agent-text-stream.js";
import { decodeAdminPolicyV1 } from "../core/components/admin-policy.js";
import { decodeComponentsList } from "../core/components/app-components-list.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  type AppComponentId,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "../core/components/ids.js";
import { getCredentialPubkey } from "../core/credential.js";
import { getGroupMemberPubkeys } from "../core/group-members.js";
import { COMPONENT_PAYLOAD_DECODERS } from "./admin-policy.js";

/** Why {@link validateWelcomeGroupState} rejected a joined group. */
export type WelcomeGroupStateRejectReason =
  | "missing-required-capabilities"
  | "missing-app-data-dictionary"
  | "missing-required-component"
  | "unsupported-required-component"
  | "invalid-component"
  | "invalid-component-location"
  | "unsupported-member-role"
  | "member-lacks-required-component"
  | "author-not-admin"
  | "admin-without-member-leaf";

/** Thrown by {@link validateWelcomeGroupState}. */
export class WelcomeGroupStateError extends Error {
  readonly reason: WelcomeGroupStateRejectReason;

  constructor(reason: WelcomeGroupStateRejectReason, message: string) {
    super(message);
    this.name = "WelcomeGroupStateError";
    this.reason = reason;
  }
}

const ROLE_EXTENSION_TYPES: [number, number][] = [
  [
    AGENT_TEXT_STREAM_ROLE_RECEIVE,
    AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  ],
  [AGENT_TEXT_STREAM_ROLE_SEND, AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE],
  [AGENT_TEXT_STREAM_ROLE_FANOUT, AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE],
];

const hexId = (id: number) => `0x${id.toString(16).padStart(4, "0")}`;

/**
 * Validates the Marmot group state a Welcome would install, before anything
 * is persisted (`protocol-core/joining.md` receiving flow, steps 6 to 8):
 *
 * 1. The GroupContext requires `app_data_dictionary` (`0x0006`) and
 *    `app_data_update` (`0x0008`) (`group-setup.md`).
 * 2. It carries an `app_data_dictionary` with an `app_components` list that
 *    requires `0x8003` (admin policy) and `0x8009` (account proof).
 * 3. The dictionary holds no leaf-only `0x8009` data and no `safe_aad`
 *    (`0x0002`) group state, which this library cannot process.
 * 4. Every component whose format this library knows decodes. Unknown
 *    optional components stay opaque (`app-components/README.md`).
 * 5. Every required component is one this client supports and has
 *    GroupContext state (`0x8009` is leaf-only and exempt). A member that
 *    does not support every required component MUST NOT join.
 * 6. Every member leaf advertises every required component in its
 *    `app_components` support list (MDK `validate_resulting_leaf_capabilities`).
 * 7. The joining leaf advertises every agent-text-stream role the group
 *    requires (`agent-text-stream-quic-v1.md`).
 * 8. The Welcome author (the GroupInfo signer) is an admin
 *    (`admin-policy-v1.md`: the sole membership-add authority).
 * 9. Every admin has a member leaf (`admin-policy-v1.md` "Validation").
 *
 * This mirrors MDK's join checks (`group_lifecycle.rs` `do_join_welcome`
 * steps 5b to 5e, `app_components.rs`
 * `validate_current_profile_group_context`).
 *
 * @throws {WelcomeGroupStateError}
 */
export function validateWelcomeGroupState(args: {
  state: ClientState;
  /** Leaf index of the GroupInfo signer (the Welcome author). */
  authorLeafIndex: number;
  /** Component ids this client supports. Defaults to {@link SUPPORTED_APP_COMPONENT_IDS}. */
  supportedComponentIds?: readonly AppComponentId[];
}): void {
  const { state, authorLeafIndex } = args;
  const supported = new Set(
    args.supportedComponentIds ?? SUPPORTED_APP_COMPONENT_IDS,
  );
  const extensions = state.groupContext.extensions;

  // 1. required_capabilities
  const required = extensions.find(
    (e) => e.extensionType === defaultExtensionTypes.required_capabilities,
  ) as ExtensionRequiredCapabilities | undefined;
  if (
    !required ||
    !required.extensionData.extensionTypes.includes(
      appDataDictionaryExtensionType,
    ) ||
    !required.extensionData.proposalTypes.includes(appDataUpdateProposalType)
  ) {
    throw new WelcomeGroupStateError(
      "missing-required-capabilities",
      "group does not require app_data_dictionary and app_data_update",
    );
  }

  // 2. dictionary and app_components list
  let dictionary: ReturnType<typeof getAppDataDictionary>;
  try {
    dictionary = getAppDataDictionary(extensions);
  } catch {
    throw new WelcomeGroupStateError(
      "invalid-component",
      "app_data_dictionary does not decode",
    );
  }
  if (!dictionary)
    throw new WelcomeGroupStateError(
      "missing-app-data-dictionary",
      "group has no app_data_dictionary",
    );
  const entries = new Map(dictionary.map((c) => [c.componentId, c.data]));
  const listData = entries.get(APP_COMPONENTS_COMPONENT_ID);
  if (!listData)
    throw new WelcomeGroupStateError(
      "missing-required-component",
      "group has no app_components requirement list",
    );
  let requiredIds: AppComponentId[];
  try {
    requiredIds = decodeComponentsList(listData);
  } catch {
    throw new WelcomeGroupStateError(
      "invalid-component",
      "app_components requirement list does not decode",
    );
  }
  for (const mandatory of [
    GROUP_ADMIN_POLICY_COMPONENT_ID,
    ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  ]) {
    if (!requiredIds.includes(mandatory))
      throw new WelcomeGroupStateError(
        "missing-required-component",
        `group does not require ${hexId(mandatory)}`,
      );
  }

  // 3. components that must not appear as GroupContext state
  for (const id of [ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, SAFE_AAD_COMPONENT_ID])
    if (entries.has(id))
      throw new WelcomeGroupStateError(
        "invalid-component-location",
        `group carries ${hexId(id)} as GroupContext state`,
      );

  // 4. every known component decodes
  for (const [id, data] of entries) {
    const decode = COMPONENT_PAYLOAD_DECODERS.get(id);
    if (!decode) continue;
    try {
      decode(data);
    } catch {
      throw new WelcomeGroupStateError(
        "invalid-component",
        `app component ${hexId(id)} does not decode`,
      );
    }
  }

  // 5. every required component is supported and present
  for (const id of requiredIds) {
    if (id === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID) continue;
    if (!supported.has(id))
      throw new WelcomeGroupStateError(
        "unsupported-required-component",
        `group requires unsupported app component ${hexId(id)}`,
      );
    if (!entries.has(id))
      throw new WelcomeGroupStateError(
        "missing-required-component",
        `required app component ${hexId(id)} has no GroupContext state`,
      );
  }

  // 6. every member leaf advertises every required component
  state.ratchetTree.forEach((node, nodeIndex) => {
    if (nodeIndex % 2 !== 0 || node?.nodeType !== nodeTypes.leaf) return;
    let advertised: AppComponentId[] = [];
    try {
      // Leaf and GroupContext dictionaries share one wire format; the
      // account-proof check above already required exactly one per leaf.
      const leafExtensions = node.leaf
        .extensions as unknown as GroupContextExtension[];
      const list = getAppDataDictionary(leafExtensions)?.find(
        (c) => c.componentId === APP_COMPONENTS_COMPONENT_ID,
      );
      advertised = list ? decodeComponentsList(list.data) : [];
    } catch {
      advertised = [];
    }
    const missing = requiredIds.filter((id) => !advertised.includes(id));
    if (missing.length > 0)
      throw new WelcomeGroupStateError(
        "member-lacks-required-component",
        `member leaf ${nodeIndex / 2} does not advertise required app component ${hexId(missing[0]!)}`,
      );
  });

  // 7. required agent-text-stream roles are advertised by our own leaf
  const agentPolicy = entries.get(AGENT_TEXT_STREAM_QUIC_COMPONENT_ID);
  if (agentPolicy) {
    const { requiredMemberRoles } =
      decodeAgentTextStreamQuicPolicyV1(agentPolicy);
    const ownNode = state.ratchetTree[state.privatePath.leafIndex * 2];
    const ownExtensions =
      ownNode?.nodeType === nodeTypes.leaf
        ? ownNode.leaf.capabilities.extensions
        : [];
    for (const [role, extensionType] of ROLE_EXTENSION_TYPES) {
      if (requiredMemberRoles & role && !ownExtensions.includes(extensionType))
        throw new WelcomeGroupStateError(
          "unsupported-member-role",
          `group requires agent-text-stream role capability ${hexId(extensionType)}`,
        );
    }
  }

  // 8. the Welcome author is an admin
  const adminData = entries.get(GROUP_ADMIN_POLICY_COMPONENT_ID);
  if (!adminData)
    throw new WelcomeGroupStateError(
      "missing-required-component",
      "group has no admin-policy state",
    );
  const admins = decodeAdminPolicyV1(adminData);
  const authorNode = state.ratchetTree[authorLeafIndex * 2];
  let author: string | undefined;
  try {
    author =
      authorNode?.nodeType === nodeTypes.leaf
        ? getCredentialPubkey(authorNode.leaf.credential)
        : undefined;
  } catch {
    author = undefined;
  }
  if (author === undefined || !admins.includes(author))
    throw new WelcomeGroupStateError(
      "author-not-admin",
      "Welcome author is not an admin of the group",
    );

  // 9. every admin has a member leaf
  const members = new Set(getGroupMemberPubkeys(state));
  const orphaned = admins.filter((admin) => !members.has(admin)).length;
  if (orphaned > 0)
    throw new WelcomeGroupStateError(
      "admin-without-member-leaf",
      `${orphaned} admin key(s) have no member leaf`,
    );
}
