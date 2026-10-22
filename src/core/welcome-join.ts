/** @module @category Core - Welcome */
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  CiphersuiteImpl,
  type GroupInfo,
  joinGroupWithExtensions,
  KeyPackage,
  PrivateKeyPackage,
  type ClientState,
  type LeafIndex,
  type GroupContextExtension,
  appDataDictionaryExtensionType,
  defaultExtensionTypes,
  getAppDataDictionary,
  leafToNodeIndex,
  nodeTypes,
  type Welcome,
} from "ts-mls";
import { marmotAuthService } from "./auth-service.js";
import { isReusableKeyPackage } from "./key-package-dictionary.js";
import { defaultMarmotClientConfig } from "./client-config.js";
import { type MarmotGroupView, getMarmotGroupView } from "./client-state.js";
import { getWelcome } from "./welcome-event.js";
import { defaultCapabilities } from "./default-capabilities.js";
import { getCredentialPubkey } from "./credential.js";
import { getGroupMemberPubkeys } from "./group-members.js";
import {
  assertCurrentGroupAccountIdentityProofProfile,
  validateGroupMemberAccountIdentityProofs,
} from "./components/account-identity-proof.js";
import {
  validateAdminLeafCoupling,
  validateResultingProfileInvariants,
} from "./components/integrity.js";
import {
  getAdminPolicy,
  getAppComponents,
  getComponentData,
  getGroupProfile,
  getNostrRouting,
  getMessageRetention,
  getAgentTextStreamPolicy,
  getGroupAvatarUrl,
  getEncryptedMediaPolicy,
  getGroupLifecycle,
} from "./components/dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  SUPPORTED_APP_COMPONENT_IDS,
} from "./components/ids.js";
import { AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES } from "./components/agent-text-stream.js";
import { decodeGroupBlossomImage } from "./components/blossom-image.js";

/** Validates the full tentative Marmot state before any persistence or secret consumption. */
export function validateWelcomeGroup(
  state: ClientState,
  groupInfo: GroupInfo,
): string {
  const extensions = state.groupContext.extensions;
  assertCurrentGroupAccountIdentityProofProfile(extensions);
  validateGroupMemberAccountIdentityProofs(
    state,
    state.groupContext.cipherSuite,
  );
  const dictionary = getAppDataDictionary(extensions);
  if (!dictionary) throw new Error("Welcome lacks Marmot dictionary");
  const invariantViolation = validateResultingProfileInvariants({
    resultingExtensions: extensions,
    resultingTree: state.ratchetTree,
  });
  if (invariantViolation) throw new Error(invariantViolation.detail);
  const required = getAppComponents(extensions);
  if (
    !required ||
    [GROUP_ADMIN_POLICY_COMPONENT_ID, ACCOUNT_IDENTITY_PROOF_COMPONENT_ID].some(
      (id) => !required.includes(id),
    )
  )
    throw new Error("Welcome lacks mandatory required components");
  for (const id of required) {
    if (!SUPPORTED_APP_COMPONENT_IDS.includes(id))
      throw new Error("Welcome requires unsupported component");
    if (
      id !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID &&
      !dictionary.some((entry) => entry.componentId === id)
    )
      throw new Error("Welcome lacks required component state");
  }
  if (
    dictionary.some(
      (entry) =>
        entry.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID ||
        entry.componentId === SAFE_AAD_COMPONENT_ID,
    )
  )
    throw new Error("Welcome has leaf-only GroupContext component");
  // Decode every known optional component too: complete dictionaries bypass commit validators.
  getGroupProfile(extensions);
  getNostrRouting(extensions);
  getMessageRetention(extensions);
  getGroupAvatarUrl(extensions);
  const image = getComponentData(extensions, GROUP_BLOSSOM_IMAGE_COMPONENT_ID);
  if (image !== undefined) decodeGroupBlossomImage(image);
  getEncryptedMediaPolicy(extensions);
  const roles = getAgentTextStreamPolicy(extensions)?.requiredMemberRoles ?? 0;
  if (
    getGroupLifecycle(extensions) === "disbanded" ||
    state.groupActiveState.kind !== "active"
  )
    throw new Error("Welcome group is not active");
  // Creation defaults are stronger than the current-profile join baseline.
  // In particular, MDK need not require self_remove, a profile component, or
  // lifecycle-v1 on an existing group (app-components/group-lifecycle-v1.md).
  const capabilityExtension = extensions.find(
    (extension) =>
      extension.extensionType === defaultExtensionTypes.required_capabilities,
  );
  const declared = capabilityExtension?.extensionData as
    | {
        extensionTypes: number[];
        proposalTypes: number[];
        credentialTypes: number[];
      }
    | undefined;
  if (!declared) throw new Error("Welcome lacks MLS required capabilities");
  const supported = defaultCapabilities();
  if (
    declared.extensionTypes.some((id) => !supported.extensions.includes(id)) ||
    declared.proposalTypes.some((id) => !supported.proposals.includes(id)) ||
    declared.credentialTypes.some((id) => !supported.credentials.includes(id))
  )
    throw new Error("Welcome requires unsupported MLS capabilities");
  for (const node of state.ratchetTree) {
    if (node?.nodeType !== nodeTypes.leaf) continue;
    const advertised =
      getAppComponents(
        node.leaf.extensions.filter(
          (extension) =>
            extension.extensionType === appDataDictionaryExtensionType,
        ) as GroupContextExtension[],
      ) ?? [];
    if (required.some((id) => !advertised.includes(id)))
      throw new Error("Welcome member lacks required components");
    if (
      AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES.some(
        (id, index) =>
          (roles & (1 << index)) !== 0 &&
          (!supported.extensions.includes(id) ||
            !node.leaf.capabilities.extensions.includes(id)),
      )
    )
      throw new Error("Welcome requires unsupported member roles");
  }
  const admins = getAdminPolicy(extensions);
  const members = getGroupMemberPubkeys(state);
  if (
    !admins?.length ||
    validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: extensions,
      resultingMemberAccounts: members,
    })
  )
    throw new Error("Welcome has invalid admin membership");
  if (!Number.isSafeInteger(groupInfo.signer) || groupInfo.signer < 0)
    throw new Error("Welcome signer is not an occupied leaf");
  const signer =
    state.ratchetTree[leafToNodeIndex(groupInfo.signer as LeafIndex)];
  if (signer?.nodeType !== nodeTypes.leaf)
    throw new Error("Welcome signer is not an occupied leaf");
  const account = getCredentialPubkey(signer.leaf.credential);
  if (!members.includes(account) || !admins.includes(account))
    throw new Error("Welcome signer must be an active admin");
  return account;
}

/**
 * Authenticates the {@link GroupInfo} through the full MLS Welcome validation,
 * without persisting or adopting the tentative joined state.
 *
 * @returns The decrypted GroupInfo
 * @throws Error if the key package does not match any secret in the welcome
 */
export async function readWelcomeGroupInfo({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  /** The MLS Welcome message (or a kind 444 Rumor) */
  welcome: Welcome | Rumor;
  /** The full key package (public + private) used to receive the invite */
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  /** The ciphersuite implementation */
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<GroupInfo> {
  // Unwrap welcome rumor if provided
  if (isRumor(welcome)) welcome = getWelcome(welcome);

  try {
    isReusableKeyPackage(keyPackage.publicPackage);
    const { groupInfo } = await joinGroupWithExtensions({
      context: {
        cipherSuite: ciphersuiteImpl,
        authService: marmotAuthService,
        clientConfig: defaultMarmotClientConfig,
        externalPsks: {},
      },
      welcome,
      keyPackage: keyPackage.publicPackage,
      privateKeys: keyPackage.privatePackage,
    });

    return groupInfo;
  } catch (err) {
    throw new Error(
      `Failed to decrypt group secrets: key package does not match this welcome (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Reads the {@link MarmotGroupView} from a Welcome message using the provided
 * key package, without performing a full group join.
 *
 * Convenience wrapper around {@link readWelcomeGroupInfo} that projects the
 * app-component state from `groupInfo.groupContext.extensions`.
 *
 * @returns The group view, or null if no app components are present
 */
export async function readWelcomeMarmotGroupView({
  welcome,
  keyPackage,
  ciphersuiteImpl,
}: {
  /** The MLS Welcome message (or a kind 444 Rumor) */
  welcome: Welcome | Rumor;
  /** The full key package (public + private) used to receive the invite */
  keyPackage: {
    publicPackage: KeyPackage;
    privatePackage: PrivateKeyPackage;
  };
  /** The ciphersuite implementation */
  ciphersuiteImpl: CiphersuiteImpl;
}): Promise<MarmotGroupView | null> {
  const groupInfo = await readWelcomeGroupInfo({
    welcome,
    keyPackage,
    ciphersuiteImpl,
  });

  return getMarmotGroupView(groupInfo);
}
