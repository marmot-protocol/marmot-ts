import { describe, expect, expectTypeOf, it } from "vitest";
import {
  GroupHistoryTree,
  groupWithdrawnNotificationsByCommit,
  type AuditContextOptions,
  type AuditSink,
  type AppliedNotificationsIngestResult,
  type ConvergenceScheduler,
  type EdgeSnapshot,
  type HistoryEdge,
  type HistoryNode,
  type RetainedHistoryStore,
  type StateInvalidatedIngestResult,
  type StateNotification,
  type TimerHandle,
} from "../index.js";
import * as exports from "../index.js";
// Per-subpath source-barrel namespace imports (D-03). `./mls` is deliberately
// excluded: it re-exports the entirety of ts-mls, which is not marmot-ts's own
// surface, not the phase's concern.
import * as clientExports from "../client/index.js";
import * as coreExports from "../core/index.js";
import * as engineExports from "../engine/index.js";
import * as extraExports from "../extra/index.js";
import * as utilsExports from "../utils/index.js";
import * as auditExports from "../audit/index.js";
import * as extraAuditNodeExports from "../extra/audit/node.js";
import * as extraAuditBrowserExports from "../extra/audit/browser.js";

type RootSignatureTypes =
  | StateNotification
  | AppliedNotificationsIngestResult
  | StateInvalidatedIngestResult
  | AuditContextOptions
  | AuditSink
  | ConvergenceScheduler
  | EdgeSnapshot
  | HistoryEdge
  | HistoryNode
  | RetainedHistoryStore
  | TimerHandle;

// D-02 legacy-export guard. The 15 legacy account-identity-proof exports removed in
// `ef756c8` (07-07-SUMMARY.md coverage D2) — a frozen historical exact-match list, not a
// fuzzy/substring check: current exports like `AccountIdentityProofError`,
// `accountIdentityProofTemplate`, and `validateLeafAccountIdentityProof` legitimately
// contain the token `AccountIdentityProof` and must not be flagged.
const REMOVED_LEGACY_EXPORT_NAMES: ReadonlySet<string> = new Set([
  "ACCOUNT_IDENTITY_PROOF_EVENT_KIND",
  "ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE",
  "accountIdentityProofEventId",
  "accountIdentityProofEventJson",
  "accountIdentityProofSignatureFromSignedEvent",
  "accountIdentityProofSigningDigest",
  "buildAccountIdentityProofEvent",
  "buildAccountIdentityProofExtension",
  "decodeAccountIdentityProof",
  "encodeAccountIdentityProof",
  "makeAccountIdentityProofExtension",
  "mlsSignatureScheme",
  "signAccountIdentityProof",
  "verifyAllLeafAccountIdentityProofs",
  "verifyLeafAccountIdentityProof",
]);

// Catches new legacy-shaped names (e.g. an accidental export of the private legacy
// constant) that the frozen denylist above would miss. Verified against the root
// snapshot during planning to match no current export.
const LEGACY_EXPORT_NAME_PATTERN =
  /LEGACY_ACCOUNT_IDENTITY_PROOF|AccountIdentityProof(Event|Extension)|ACCOUNT_IDENTITY_PROOF_(EVENT|EXTENSION)/;

const LEGACY_PROOF_EXTENSION_TYPE = 0xf2f1;

const MAX_LEGACY_VALUE_SCAN_DEPTH = 4;

/**
 * Walks a public export namespace looking for a removed legacy export name, a
 * legacy-proof-shaped name, or any value (top-level or nested in arrays, Sets, Maps,
 * plain objects, or class statics) equal to the legacy `0xf2f1` extension type as a
 * number, bigint, or hex string. Recursion stops at plain objects (prototype is
 * `Object.prototype` or `null`) and the own enumerable string-keyed properties of
 * functions (class statics); it does not follow prototypes or class instances. A
 * `WeakSet` of visited objects/functions stops cycles; a depth cap bounds the walk.
 * Returns an empty array when the namespace is clean.
 */
function findLegacyExportViolations(
  namespace: Record<string, unknown>,
): string[] {
  const violations: string[] = [];
  const visited = new WeakSet<WeakKey>();

  function isLegacyExtensionTypeValue(value: unknown): boolean {
    if (typeof value === "number") return value === LEGACY_PROOF_EXTENSION_TYPE;
    if (typeof value === "bigint")
      return value === BigInt(LEGACY_PROOF_EXTENSION_TYPE);
    if (typeof value === "string") return value.toLowerCase() === "0xf2f1";
    return false;
  }

  function walk(value: unknown, path: string, depth: number): void {
    if (isLegacyExtensionTypeValue(value)) {
      violations.push(`${path}: equals the legacy 0xf2f1 extension type`);
      return;
    }
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    )
      return;
    if (depth > MAX_LEGACY_VALUE_SCAN_DEPTH) return;
    const container = value as object;
    if (visited.has(container)) return;
    visited.add(container);

    if (Array.isArray(container)) {
      container.forEach((entry, index) =>
        walk(entry, `${path}[${index}]`, depth + 1),
      );
      return;
    }
    if (container instanceof Set) {
      let index = 0;
      for (const entry of container) {
        walk(entry, `${path}<set:${index}>`, depth + 1);
        index++;
      }
      return;
    }
    if (container instanceof Map) {
      for (const [key, entry] of container) {
        walk(key, `${path}<map-key>`, depth + 1);
        walk(entry, `${path}<map:${String(key)}>`, depth + 1);
      }
      return;
    }
    const proto: unknown = Object.getPrototypeOf(container);
    if (
      typeof container === "function" ||
      proto === Object.prototype ||
      proto === null
    ) {
      for (const [key, entry] of Object.entries(
        container as Record<string, unknown>,
      )) {
        walk(entry, `${path}.${key}`, depth + 1);
      }
    }
  }

  for (const key of Object.keys(namespace)) {
    if (REMOVED_LEGACY_EXPORT_NAMES.has(key))
      violations.push(`${key}: removed legacy export name`);
    else if (LEGACY_EXPORT_NAME_PATTERN.test(key))
      violations.push(`${key}: legacy-proof-shaped export name`);
    walk(namespace[key], key, 0);
  }

  return violations;
}

// The nine snapshotted public surfaces (all `package.json` `exports` subpaths except
// `./mls`, which re-exports all of ts-mls and is not marmot-ts's own surface).
const PUBLIC_SURFACES: Array<[string, Record<string, unknown>]> = [
  [".", exports],
  ["./client", clientExports],
  ["./core", coreExports],
  ["./engine", engineExports],
  ["./extra", extraExports],
  ["./utils", utilsExports],
  ["./audit", auditExports],
  ["./extra/audit/node", extraAuditNodeExports],
  ["./extra/audit/browser", extraAuditBrowserExports],
];

describe("exports", () => {
  it("should name every root public-signature symbol from the root", () => {
    expectTypeOf<RootSignatureTypes>().not.toBeNever();
    expectTypeOf(GroupHistoryTree).toBeConstructibleWith();
    expectTypeOf(groupWithdrawnNotificationsByCommit).toBeFunction();
  });

  it("should export the expected members", () => {
    expect(Object.keys(exports).sort()).toMatchInlineSnapshot(`
      [
        "ACCOUNT_IDENTITY_PROOF_COMPONENT",
        "ACCOUNT_IDENTITY_PROOF_COMPONENT_ID",
        "ADDRESSABLE_KEY_PACKAGE_KIND",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT_ID",
        "AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES",
        "AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_ROLE_FANOUT",
        "AGENT_TEXT_STREAM_ROLE_RECEIVE",
        "AGENT_TEXT_STREAM_ROLE_SEND",
        "APP_COMPONENTS_COMPONENT_ID",
        "AUTHORIZATION_PROOF_LENGTH",
        "AUTHORIZATION_PROOF_MAX_CREATED_AT",
        "AccountIdentityProofError",
        "AuthorizationProofError",
        "BLOSSOM_LOCATOR_KIND",
        "BLOSSOM_LOCATOR_KIND_V1",
        "BinaryDecodeError",
        "BinaryReader",
        "BinaryWriter",
        "BoundedIdCache",
        "DEFAULT_CONVERGENCE_POLICY",
        "DEFAULT_GROUP_COMPONENT_IDS",
        "ENCRYPTED_MEDIA_FORMAT_V1",
        "ENCRYPTED_MEDIA_VERSION",
        "GIFT_WRAP_KIND",
        "GROUP_ADMIN_POLICY_COMPONENT",
        "GROUP_ADMIN_POLICY_COMPONENT_ID",
        "GROUP_AVATAR_URL_COMPONENT",
        "GROUP_AVATAR_URL_COMPONENT_ID",
        "GROUP_BLOSSOM_IMAGE_COMPONENT",
        "GROUP_BLOSSOM_IMAGE_COMPONENT_ID",
        "GROUP_DESCRIPTION_MAX_BYTES",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT_ID",
        "GROUP_EVENT_KIND",
        "GROUP_LIFECYCLE_COMPONENT",
        "GROUP_LIFECYCLE_COMPONENT_ID",
        "GROUP_MESSAGE_RETENTION_COMPONENT",
        "GROUP_MESSAGE_RETENTION_COMPONENT_ID",
        "GROUP_NAME_MAX_BYTES",
        "GROUP_PROFILE_COMPONENT",
        "GROUP_PROFILE_COMPONENT_ID",
        "GroupHistoryTree",
        "GroupMediaService",
        "GroupMediaStore",
        "GroupRumorHistory",
        "GroupRuntime",
        "GroupSession",
        "GroupTerminalError",
        "GroupsManager",
        "INBOX_RELAY_LIST_KIND",
        "INBOX_RELAY_TAG",
        "InviteManager",
        "KEY_PACKAGE_APP_COMPONENTS_TAG",
        "KEY_PACKAGE_CIPHER_SUITE_TAG",
        "KEY_PACKAGE_CLIENT_TAG",
        "KEY_PACKAGE_EXTENSIONS_TAG",
        "KEY_PACKAGE_MLS_VERSION_TAG",
        "KEY_PACKAGE_PROPOSALS_TAG",
        "KEY_PACKAGE_RELAYS_TAG",
        "KeyPackageManager",
        "KeyPackageNotFoundError",
        "KeyPackagePublisher",
        "KeyPackageRotatePreconditionError",
        "KeyPackageStore",
        "LAST_RESORT_EXTENSION_TYPE",
        "LAST_RESORT_KEY_PACKAGE_COMPONENT_ID",
        "MAX_VARINT",
        "MarmotClient",
        "MarmotGroup",
        "MarmotGroupEngine",
        "MissingRelayError",
        "MissingSlotIdentifierError",
        "NIP65_RELAY_LIST_KIND",
        "NIP65_RELAY_TAG",
        "NOSTR_GROUP_ID_TAG",
        "NOSTR_ROUTING_COMPONENT",
        "NOSTR_ROUTING_COMPONENT_ID",
        "NoGroupRelaysError",
        "NoMarmotGroupDataError",
        "NostrWelcomeDelivery",
        "Proposals",
        "SAFE_AAD_COMPONENT_ID",
        "SUPPORTED_APP_COMPONENT_IDS",
        "SUPPORTED_LOCATOR_KINDS",
        "WELCOME_EVENT_KIND",
        "accountIdentityProofTemplate",
        "adminPolicyEntry",
        "agentTextStreamEntry",
        "appComponentsEntry",
        "assertCurrentGroupAccountIdentityProofProfile",
        "assertNoAccountIdentityProofComponent",
        "authorizationProofEventId",
        "buildAppDataDictionary",
        "buildAuthorizationProofEvent",
        "buildFallbackFetchUrls",
        "buildForkTreeView",
        "calculateKeyPackageRef",
        "canTransitionLifecycle",
        "canonicalizeMimeType",
        "checkKeyPackageProposalsTag",
        "classifyChangedLeaf",
        "classifyDisbandCommit",
        "classifyGroupAccountIdentityProofProfile",
        "classifyLateCommit",
        "collectAppDataUpdateOps",
        "commitDigest",
        "compareBranchScores",
        "compareCommitOrderingKeys",
        "componentEntry",
        "convergenceOutcomeToCategory",
        "createAdminCommitPolicyCallback",
        "createApplicationMessageIntent",
        "createChatRumor",
        "createCredential",
        "createDefaultKeyPackageLifetime",
        "createDeleteKeyPackageEvent",
        "createEncryptedGroupEventContent",
        "createGiftWrap",
        "createGroup",
        "createGroupEvent",
        "createInboxRelayListEvent",
        "createInviteIntent",
        "createKeyPackageEvent",
        "createNip65RelayListEvent",
        "createSimpleGroup",
        "createThreeMonthLifetime",
        "createWelcomeRumor",
        "decideCommitAuthorization",
        "decodeAdminPolicyV1",
        "decodeAgentTextStreamQuicPolicyV1",
        "decodeAuthorizationProof",
        "decodeComponentsList",
        "decodeContent",
        "decodeEncryptedMediaPolicyV1",
        "decodeGroupAvatarUrlV1",
        "decodeGroupLifecycleV1",
        "decodeGroupProfileV1",
        "decodeMessageRetentionV1",
        "decodeNostrRoutingV1",
        "decodeUtf8",
        "decodeVarint",
        "decryptGroupMessage",
        "decryptGroupMessageEvent",
        "decryptGroupMessages",
        "decryptMediaFile",
        "decryptMediaFileWithKeys",
        "defaultCapabilities",
        "defaultMarmotClientConfig",
        "deferredReasons",
        "deriveMediaEncryptionKey",
        "deserializeApplicationData",
        "deserializeApplicationRumor",
        "deserializeClientState",
        "detectEncoding",
        "diffChangedLeaves",
        "disposition",
        "encodeAdminPolicyV1",
        "encodeAgentTextStreamQuicPolicyV1",
        "encodeAuthorizationProof",
        "encodeComponentsList",
        "encodeContent",
        "encodeEncryptedMediaPolicyV1",
        "encodeGroupAvatarUrlV1",
        "encodeGroupLifecycleV1",
        "encodeGroupProfileV1",
        "encodeMediaImetaTag",
        "encodeMessageRetentionV1",
        "encodeNostrRoutingV1",
        "encodeUtf8",
        "encodeVarint",
        "encryptMediaFile",
        "encryptedMediaBlossomDefault",
        "encryptedMediaEntry",
        "ensureLastResortExtension",
        "ensureMarmotCapabilities",
        "evaluateKeyPackageForGroup",
        "extendedExtensionTypes",
        "formatMlsTimestamp",
        "generateKeyPackage",
        "getAdminPolicy",
        "getAgentTextStreamPolicy",
        "getAppComponents",
        "getComponentData",
        "getCredentialLeafNodeIndexes",
        "getCredentialPubkey",
        "getEncodingTag",
        "getEncryptedMediaPolicy",
        "getEpoch",
        "getGroupAvatarUrl",
        "getGroupIdHex",
        "getGroupLifecycle",
        "getGroupMemberPubkeys",
        "getGroupMembers",
        "getGroupProfile",
        "getGroupProfileSupport",
        "getInboxRelays",
        "getKeyPackage",
        "getKeyPackageCipherSuiteId",
        "getKeyPackageClient",
        "getKeyPackageExtensions",
        "getKeyPackageIdentifier",
        "getKeyPackageLifetime",
        "getKeyPackageMLSVersion",
        "getKeyPackageNostrPubkey",
        "getKeyPackageReference",
        "getKeyPackageRelays",
        "getMarmotGroupInfo",
        "getMarmotGroupView",
        "getMediaAttachments",
        "getMemberCount",
        "getMessageRetention",
        "getNip65Relays",
        "getNostrGroupIdHex",
        "getNostrRouting",
        "getPubkeyLeafNodeIndexes",
        "getPubkeyLeafNodes",
        "getTagValue",
        "getWelcome",
        "getWelcomeGroupRelays",
        "getWelcomeKeyPackageEventId",
        "getWelcomeKeyPackageRefs",
        "groupAvatarUrlEntry",
        "groupLifecycleEntry",
        "groupLifecycleStates",
        "groupProfileEntry",
        "groupProtocolLifecycleValues",
        "groupWithdrawnNotificationsByCommit",
        "hasAccountIdentityProofMaterial",
        "hasAck",
        "ingestResultDisposition",
        "inputCategories",
        "isAppPayloadExpired",
        "isApplicationMessage",
        "isBranchEligible",
        "isCommitMessage",
        "isHexKey",
        "isLastResortExtension",
        "isLastResortKeyPackage",
        "isLifetimeCurrentWithGrace",
        "isLifetimeValid",
        "isLifetimeWithinCap",
        "isProposalMessage",
        "isSameCredential",
        "isValidAccountIdentity",
        "isValidInboxRelayListEvent",
        "isValidNip65RelayListEvent",
        "isValidRelayUrl",
        "isWitnessEligible",
        "keyPackageDefaultExtensions",
        "makeAppComponentsExtension",
        "makeLeafAppComponentsExtension",
        "marmotRequiredCapabilitiesExtension",
        "mayApplyRetainedInbound",
        "mayPrepareLocalCommit",
        "mayRunForkDetection",
        "messageRetentionEntry",
        "mlsSignatureSchemeForCiphersuite",
        "normalizeConvergencePolicy",
        "normalizeRelayUrl",
        "nostrRoutingEntry",
        "nostrTransportBinding",
        "parseMediaImetaTag",
        "produceAccountIdentityProof",
        "produceAuthorizationProof",
        "prunableRetainedEpochs",
        "readWelcomeGroupInfo",
        "readWelcomeMarmotGroupView",
        "replaceExtension",
        "requiredRetainedEpochs",
        "resolveMediaFetchUrls",
        "scoreBranch",
        "selectCanonicalBranch",
        "selectFairQueuedStateIntent",
        "selectFetchableLocators",
        "serializeApplicationRumor",
        "serializeClientState",
        "sortGroupCommits",
        "transitionLifecycle",
        "unixNow",
        "validateAddProposalAccountIdentityProofs",
        "validateAdminLeafCoupling",
        "validateAppComponentIntegrity",
        "validateCommitAccountIdentityProofs",
        "validateCommitLegality",
        "validateConvergencePolicy",
        "validateGroupMemberAccountIdentityProofs",
        "validateKeyPackageAccountIdentityProof",
        "validateLeafAccountIdentityProof",
        "validateUpdateProposalAccountIdentityProofs",
        "varintSize",
        "verifyApplicationRumorAuthorship",
        "verifyAuthorizationProof",
      ]
    `);
  });
});

describe("./client exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(clientExports).sort()).toMatchInlineSnapshot(`
      [
        "BoundedIdCache",
        "GroupMediaService",
        "GroupMediaStore",
        "GroupRumorHistory",
        "GroupRuntime",
        "GroupSession",
        "GroupTerminalError",
        "GroupsManager",
        "InviteManager",
        "KeyPackageManager",
        "KeyPackageNotFoundError",
        "KeyPackagePublisher",
        "KeyPackageRotatePreconditionError",
        "KeyPackageStore",
        "MarmotClient",
        "MarmotGroup",
        "MissingRelayError",
        "MissingSlotIdentifierError",
        "NoGroupRelaysError",
        "NoMarmotGroupDataError",
        "NostrWelcomeDelivery",
        "Proposals",
        "buildForkTreeView",
        "createAdminCommitPolicyCallback",
        "createApplicationMessageIntent",
        "createChatRumor",
        "createInviteIntent",
        "ingestResultDisposition",
        "selectFairQueuedStateIntent",
      ]
    `);
  });
});

describe("./core exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(coreExports).sort()).toMatchInlineSnapshot(`
      [
        "ACCOUNT_IDENTITY_PROOF_COMPONENT",
        "ACCOUNT_IDENTITY_PROOF_COMPONENT_ID",
        "ADDRESSABLE_KEY_PACKAGE_KIND",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT",
        "AGENT_TEXT_STREAM_QUIC_COMPONENT_ID",
        "AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES",
        "AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE",
        "AGENT_TEXT_STREAM_ROLE_FANOUT",
        "AGENT_TEXT_STREAM_ROLE_RECEIVE",
        "AGENT_TEXT_STREAM_ROLE_SEND",
        "APP_COMPONENTS_COMPONENT_ID",
        "AUTHORIZATION_PROOF_LENGTH",
        "AUTHORIZATION_PROOF_MAX_CREATED_AT",
        "AccountIdentityProofError",
        "AuthorizationProofError",
        "BLOSSOM_LOCATOR_KIND",
        "BLOSSOM_LOCATOR_KIND_V1",
        "BinaryDecodeError",
        "BinaryReader",
        "BinaryWriter",
        "DEFAULT_CONVERGENCE_POLICY",
        "DEFAULT_GROUP_COMPONENT_IDS",
        "ENCRYPTED_MEDIA_FORMAT_V1",
        "ENCRYPTED_MEDIA_VERSION",
        "GIFT_WRAP_KIND",
        "GROUP_ADMIN_POLICY_COMPONENT",
        "GROUP_ADMIN_POLICY_COMPONENT_ID",
        "GROUP_AVATAR_URL_COMPONENT",
        "GROUP_AVATAR_URL_COMPONENT_ID",
        "GROUP_BLOSSOM_IMAGE_COMPONENT",
        "GROUP_BLOSSOM_IMAGE_COMPONENT_ID",
        "GROUP_DESCRIPTION_MAX_BYTES",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT",
        "GROUP_ENCRYPTED_MEDIA_COMPONENT_ID",
        "GROUP_EVENT_KIND",
        "GROUP_LIFECYCLE_COMPONENT",
        "GROUP_LIFECYCLE_COMPONENT_ID",
        "GROUP_MESSAGE_RETENTION_COMPONENT",
        "GROUP_MESSAGE_RETENTION_COMPONENT_ID",
        "GROUP_NAME_MAX_BYTES",
        "GROUP_PROFILE_COMPONENT",
        "GROUP_PROFILE_COMPONENT_ID",
        "INBOX_RELAY_LIST_KIND",
        "INBOX_RELAY_TAG",
        "KEY_PACKAGE_APP_COMPONENTS_TAG",
        "KEY_PACKAGE_CIPHER_SUITE_TAG",
        "KEY_PACKAGE_CLIENT_TAG",
        "KEY_PACKAGE_EXTENSIONS_TAG",
        "KEY_PACKAGE_MLS_VERSION_TAG",
        "KEY_PACKAGE_PROPOSALS_TAG",
        "KEY_PACKAGE_RELAYS_TAG",
        "LAST_RESORT_EXTENSION_TYPE",
        "LAST_RESORT_KEY_PACKAGE_COMPONENT_ID",
        "MAX_VARINT",
        "NIP65_RELAY_LIST_KIND",
        "NIP65_RELAY_TAG",
        "NOSTR_GROUP_ID_TAG",
        "NOSTR_ROUTING_COMPONENT",
        "NOSTR_ROUTING_COMPONENT_ID",
        "SAFE_AAD_COMPONENT_ID",
        "SUPPORTED_APP_COMPONENT_IDS",
        "SUPPORTED_LOCATOR_KINDS",
        "WELCOME_EVENT_KIND",
        "accountIdentityProofTemplate",
        "adminPolicyEntry",
        "agentTextStreamEntry",
        "appComponentsEntry",
        "assertCurrentGroupAccountIdentityProofProfile",
        "assertNoAccountIdentityProofComponent",
        "authorizationProofEventId",
        "buildAppDataDictionary",
        "buildAuthorizationProofEvent",
        "buildFallbackFetchUrls",
        "calculateKeyPackageRef",
        "canTransitionLifecycle",
        "canonicalizeMimeType",
        "checkKeyPackageProposalsTag",
        "classifyChangedLeaf",
        "classifyDisbandCommit",
        "classifyGroupAccountIdentityProofProfile",
        "classifyLateCommit",
        "collectAppDataUpdateOps",
        "commitDigest",
        "compareBranchScores",
        "compareCommitOrderingKeys",
        "componentEntry",
        "convergenceOutcomeToCategory",
        "createCredential",
        "createDeleteKeyPackageEvent",
        "createEncryptedGroupEventContent",
        "createGroup",
        "createGroupEvent",
        "createInboxRelayListEvent",
        "createKeyPackageEvent",
        "createNip65RelayListEvent",
        "createSimpleGroup",
        "createWelcomeRumor",
        "decideCommitAuthorization",
        "decodeAdminPolicyV1",
        "decodeAgentTextStreamQuicPolicyV1",
        "decodeAuthorizationProof",
        "decodeComponentsList",
        "decodeEncryptedMediaPolicyV1",
        "decodeGroupAvatarUrlV1",
        "decodeGroupLifecycleV1",
        "decodeGroupProfileV1",
        "decodeMessageRetentionV1",
        "decodeNostrRoutingV1",
        "decodeUtf8",
        "decodeVarint",
        "decryptGroupMessage",
        "decryptGroupMessageEvent",
        "decryptGroupMessages",
        "decryptMediaFile",
        "decryptMediaFileWithKeys",
        "defaultCapabilities",
        "defaultMarmotClientConfig",
        "deferredReasons",
        "deriveMediaEncryptionKey",
        "deserializeApplicationData",
        "deserializeApplicationRumor",
        "deserializeClientState",
        "diffChangedLeaves",
        "disposition",
        "encodeAdminPolicyV1",
        "encodeAgentTextStreamQuicPolicyV1",
        "encodeAuthorizationProof",
        "encodeComponentsList",
        "encodeEncryptedMediaPolicyV1",
        "encodeGroupAvatarUrlV1",
        "encodeGroupLifecycleV1",
        "encodeGroupProfileV1",
        "encodeMediaImetaTag",
        "encodeMessageRetentionV1",
        "encodeNostrRoutingV1",
        "encodeUtf8",
        "encodeVarint",
        "encryptMediaFile",
        "encryptedMediaBlossomDefault",
        "encryptedMediaEntry",
        "ensureLastResortExtension",
        "ensureMarmotCapabilities",
        "evaluateKeyPackageForGroup",
        "extendedExtensionTypes",
        "generateKeyPackage",
        "getAdminPolicy",
        "getAgentTextStreamPolicy",
        "getAppComponents",
        "getComponentData",
        "getCredentialLeafNodeIndexes",
        "getCredentialPubkey",
        "getEncryptedMediaPolicy",
        "getEpoch",
        "getGroupAvatarUrl",
        "getGroupIdHex",
        "getGroupLifecycle",
        "getGroupMemberPubkeys",
        "getGroupMembers",
        "getGroupProfile",
        "getGroupProfileSupport",
        "getInboxRelays",
        "getKeyPackage",
        "getKeyPackageCipherSuiteId",
        "getKeyPackageClient",
        "getKeyPackageExtensions",
        "getKeyPackageIdentifier",
        "getKeyPackageLifetime",
        "getKeyPackageMLSVersion",
        "getKeyPackageNostrPubkey",
        "getKeyPackageReference",
        "getKeyPackageRelays",
        "getMarmotGroupInfo",
        "getMarmotGroupView",
        "getMediaAttachments",
        "getMemberCount",
        "getMessageRetention",
        "getNip65Relays",
        "getNostrGroupIdHex",
        "getNostrRouting",
        "getPubkeyLeafNodeIndexes",
        "getPubkeyLeafNodes",
        "getWelcome",
        "getWelcomeGroupRelays",
        "getWelcomeKeyPackageEventId",
        "getWelcomeKeyPackageRefs",
        "groupAvatarUrlEntry",
        "groupLifecycleEntry",
        "groupLifecycleStates",
        "groupProfileEntry",
        "groupProtocolLifecycleValues",
        "hasAccountIdentityProofMaterial",
        "inputCategories",
        "isAppPayloadExpired",
        "isApplicationMessage",
        "isBranchEligible",
        "isCommitMessage",
        "isHexKey",
        "isLastResortExtension",
        "isLastResortKeyPackage",
        "isProposalMessage",
        "isSameCredential",
        "isValidAccountIdentity",
        "isValidInboxRelayListEvent",
        "isValidNip65RelayListEvent",
        "isWitnessEligible",
        "keyPackageDefaultExtensions",
        "makeAppComponentsExtension",
        "makeLeafAppComponentsExtension",
        "marmotRequiredCapabilitiesExtension",
        "mayApplyRetainedInbound",
        "mayPrepareLocalCommit",
        "mayRunForkDetection",
        "messageRetentionEntry",
        "mlsSignatureSchemeForCiphersuite",
        "normalizeConvergencePolicy",
        "nostrRoutingEntry",
        "nostrTransportBinding",
        "parseMediaImetaTag",
        "produceAccountIdentityProof",
        "produceAuthorizationProof",
        "prunableRetainedEpochs",
        "readWelcomeGroupInfo",
        "readWelcomeMarmotGroupView",
        "replaceExtension",
        "requiredRetainedEpochs",
        "resolveMediaFetchUrls",
        "scoreBranch",
        "selectCanonicalBranch",
        "selectFetchableLocators",
        "serializeApplicationRumor",
        "serializeClientState",
        "sortGroupCommits",
        "transitionLifecycle",
        "validateAddProposalAccountIdentityProofs",
        "validateAdminLeafCoupling",
        "validateAppComponentIntegrity",
        "validateCommitAccountIdentityProofs",
        "validateCommitLegality",
        "validateConvergencePolicy",
        "validateGroupMemberAccountIdentityProofs",
        "validateKeyPackageAccountIdentityProof",
        "validateLeafAccountIdentityProof",
        "validateUpdateProposalAccountIdentityProofs",
        "varintSize",
        "verifyApplicationRumorAuthorship",
        "verifyAuthorizationProof",
      ]
    `);
  });
});

describe("./engine exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(engineExports).sort()).toMatchInlineSnapshot(`
      [
        "AdminDepletionError",
        "CommitLegalityError",
        "DisbandingError",
        "ForkRecovery",
        "GroupHistoryTree",
        "IngestionPool",
        "MarmotGroupEngine",
        "RetainedHistoryStore",
        "StateNotificationLedger",
        "UnsupportedGroupProfileError",
        "collectWitnessesAt",
        "createAdminCommitPolicyCallback",
        "decodeDisbandConvergence",
        "decodeDisbandRequest",
        "decodeOwnCommitRecord",
        "deriveStateNotifications",
        "disbandConvergenceKey",
        "disbandRequestKey",
        "encodeDisbandConvergence",
        "encodeDisbandRequest",
        "encodeOwnCommitRecord",
        "groupWithdrawnNotificationsByCommit",
        "ingestEnvelopes",
        "ingestResultDisposition",
        "isAuthenticApplicationMessage",
        "openConvergencePass",
        "ownCommitRecordIdentity",
        "refreshConvergencePass",
        "requiredComponentIdsOf",
        "resolveCandidateParent",
        "validatePreApplyProposals",
        "withCapturedProposals",
      ]
    `);
  });
});

describe("./extra exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraExports).sort()).toMatchInlineSnapshot(`
      [
        "EncryptedKeyValueStore",
        "InMemoryKeyValueStore",
        "KeyValueRumorHistoryBackend",
        "makeKeyValueRumorHistoryFactory",
      ]
    `);
  });
});

describe("./utils exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(utilsExports).sort()).toMatchInlineSnapshot(`
      [
        "createDefaultKeyPackageLifetime",
        "createGiftWrap",
        "createThreeMonthLifetime",
        "decodeContent",
        "detectEncoding",
        "encodeContent",
        "formatMlsTimestamp",
        "getEncodingTag",
        "getTagValue",
        "hasAck",
        "isLifetimeCurrentWithGrace",
        "isLifetimeValid",
        "isLifetimeWithinCap",
        "isValidRelayUrl",
        "normalizeRelayUrl",
        "unixNow",
      ]
    `);
  });
});

describe("./audit exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(auditExports).sort()).toMatchInlineSnapshot(`
      [
        "AuditEmitter",
        "JsonlAuditRecorder",
        "MARMOT_AUDIT_SCHEMA_VERSION",
        "MemoryAuditSink",
        "NoopAuditSink",
        "SafeAuditSink",
        "auditEpochStateName",
        "auditNowMs",
        "createAuditEmitter",
        "createAuditEvent",
        "deriveAccountRef",
        "deriveEngineId",
        "deriveMemberRef",
        "digestBytes",
        "digestString",
        "errorDetail",
        "mergeAuditContexts",
        "messageArtifactKindFromNostrKind",
        "noopAuditSink",
        "safeAuditSink",
        "toAuditBytes",
      ]
    `);
  });
});

describe("./extra/audit/node exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraAuditNodeExports).sort()).toMatchInlineSnapshot(`
      [
        "NodeJsonlAuditRecorder",
        "NodeJsonlAuditWriter",
        "uploadAuditLogFile",
      ]
    `);
  });
});

describe("./extra/audit/browser exports", () => {
  it("should export the expected members", () => {
    expect(Object.keys(extraAuditBrowserExports).sort()).toMatchInlineSnapshot(`
      [
        "AutoBrowserAuditWriter",
        "IndexedDbAuditWriter",
        "OpfsAuditWriter",
      ]
    `);
  });
});

describe("legacy 0xf2f1 account-identity-proof export guard (D-02)", () => {
  it.each(PUBLIC_SURFACES)(
    "%s exposes no legacy proof export",
    (_subpath, namespace) => {
      expect(findLegacyExportViolations(namespace)).toEqual([]);
    },
  );

  it("flags planted legacy names, legacy-shaped constants and nested 0xf2f1 values (guard self-test)", () => {
    // Denylist: an exact removed legacy export name.
    expect(
      findLegacyExportViolations({
        encodeAccountIdentityProof: () => undefined,
      }),
    ).not.toEqual([]);

    // Name pattern: a legacy-shaped name not in the frozen denylist.
    expect(
      findLegacyExportViolations({
        LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE: 0x1234,
      }),
    ).not.toEqual([]);

    // Top-level number equal to the legacy extension type.
    expect(
      findLegacyExportViolations({ SOME_EXTENSION_TYPE: 0xf2f1 }),
    ).not.toEqual([]);

    // Nested in an array.
    expect(findLegacyExportViolations({ ids: [0x0001, 0xf2f1] })).not.toEqual(
      [],
    );

    // Nested bigint inside a plain object.
    expect(
      findLegacyExportViolations({ table: { legacy: BigInt(0xf2f1) } }),
    ).not.toEqual([]);

    // A Set containing a case-insensitive hex-string form.
    expect(
      findLegacyExportViolations({ tags: new Set(["0xF2F1"]) }),
    ).not.toEqual([]);

    // A Map key equal to the legacy extension type.
    expect(
      findLegacyExportViolations({ byId: new Map([[0xf2f1, "legacy"]]) }),
    ).not.toEqual([]);

    // A class static equal to the legacy extension type.
    class Holder {
      static TYPE = 0xf2f1;
    }
    expect(findLegacyExportViolations({ Holder })).not.toEqual([]);

    // Negative control: current, legitimate `0x8009` names and values must not trip the
    // guard. Type-only exports are erased at runtime and are not covered by this guard —
    // an accepted gap (RESEARCH.md D-02 point 3: no legacy type name ever existed).
    expect(
      findLegacyExportViolations({
        ACCOUNT_IDENTITY_PROOF_COMPONENT_ID: 0x8009,
        AccountIdentityProofError: class extends Error {},
        accountIdentityProofTemplate:
          "Authorize this MLS leaf key for my Marmot account",
      }),
    ).toEqual([]);
  });
});
