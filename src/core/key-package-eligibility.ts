/** @module @category Core - Key Package */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type ClientState,
  getAppDataDictionary,
  type GroupContextExtension,
  type GroupInfo,
  type KeyPackage,
} from "ts-mls";

import { getMarmotGroupInfo } from "./client-state.js";
import { getCredentialPubkey } from "./credential.js";
import {
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_ROLE_FANOUT,
  AGENT_TEXT_STREAM_ROLE_RECEIVE,
  AGENT_TEXT_STREAM_ROLE_SEND,
  decodeAgentTextStreamQuicPolicyV1,
} from "./components/agent-text-stream.js";
import { decodeComponentsList } from "./components/app-components-list.js";
import { getAppComponents } from "./components/dictionary.js";
import {
  AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
} from "./components/ids.js";
import {
  checkKeyPackageProposalsTag,
  getKeyPackage,
} from "./key-package-event.js";
import {
  isLifetimeCurrentWithGrace,
  isLifetimeWithinCap,
} from "../utils/timestamp.js";

/**
 * MLS `required_capabilities` GroupContext extension type (code point `0x0003`).
 * A LeafNode added to the group MUST advertise every extension/proposal/credential
 * listed here (capability-negotiation.md "enforce on add").
 */
const REQUIRED_CAPABILITIES_EXTENSION_TYPE = 0x0003;

/**
 * Maps each agent-text-stream-QUIC `required_member_roles` bit to the LeafNode
 * capability (extension type) a KeyPackage must advertise to satisfy it. A group
 * whose policy requires a role rejects any KeyPackage missing the marker
 * (agent-text-stream-quic-v1.md `do_send_invite`).
 */
const ROLE_CAPABILITIES = [
  {
    bit: AGENT_TEXT_STREAM_ROLE_RECEIVE,
    extension: AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
    name: "receive",
  },
  {
    bit: AGENT_TEXT_STREAM_ROLE_SEND,
    extension: AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
    name: "send",
  },
  {
    bit: AGENT_TEXT_STREAM_ROLE_FANOUT,
    extension: AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
    name: "fanout",
  },
] as const;

function codePointHex(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

/**
 * Lists every group requirement `keyPackage`'s LeafNode does not advertise:
 * the `required_capabilities` extension/proposal/credential types, every
 * component in the group's `app_components` requirement list (checked against
 * the leaf's own `app_components` support list), and the agent-text-stream
 * role capabilities the group's policy requires. Returns `[]` when the
 * KeyPackage can be added.
 *
 * MDK refuses to create a group or add a member that misses any of these
 * (`group_lifecycle.rs` `do_create_group`, and
 * `validate_resulting_leaf_capabilities` on every commit), so an Add of such a
 * KeyPackage is rejected by MDK members.
 */
export function missingGroupRequirements(
  keyPackage: KeyPackage,
  groupExtensions: GroupContextExtension[],
): string[] {
  const reasons: string[] = [];
  const capabilities = keyPackage.leafNode.capabilities;

  const requiredExtension = groupExtensions.find(
    (extension) =>
      extension.extensionType === REQUIRED_CAPABILITIES_EXTENSION_TYPE,
  );
  const required = requiredExtension?.extensionData as
    | {
        extensionTypes?: number[];
        proposalTypes?: number[];
        credentialTypes?: number[];
      }
    | undefined;
  if (required) {
    for (const type of required.extensionTypes ?? [])
      if (!capabilities.extensions.includes(type))
        reasons.push(`missing extension ${codePointHex(type)}`);
    for (const type of required.proposalTypes ?? [])
      if (!capabilities.proposals.includes(type))
        reasons.push(`missing proposal ${codePointHex(type)}`);
    for (const type of required.credentialTypes ?? [])
      if (!capabilities.credentials.includes(type))
        reasons.push(`missing credential ${codePointHex(type)}`);
  }

  const requiredComponents = getAppComponents(groupExtensions) ?? [];
  let advertised: number[] = [];
  try {
    const leafExtensions = keyPackage.leafNode
      .extensions as unknown as GroupContextExtension[];
    const list = getAppDataDictionary(leafExtensions)?.find(
      (entry) => entry.componentId === APP_COMPONENTS_COMPONENT_ID,
    );
    advertised = list ? decodeComponentsList(list.data) : [];
  } catch {
    advertised = [];
  }
  for (const id of requiredComponents)
    if (!advertised.includes(id))
      reasons.push(`missing app component ${codePointHex(id)}`);

  const policyData = getAppDataDictionary(groupExtensions)?.find(
    (entry) => entry.componentId === AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  )?.data;
  const requiredRoles = policyData
    ? decodeAgentTextStreamQuicPolicyV1(policyData).requiredMemberRoles
    : 0;
  for (const role of ROLE_CAPABILITIES) {
    if (
      requiredRoles & role.bit &&
      !capabilities.extensions.includes(role.extension)
    ) {
      reasons.push(`missing ${role.name} role ${codePointHex(role.extension)}`);
    }
  }

  return reasons;
}

/** The outcome of evaluating a KeyPackage against a group's add requirements. */
export interface KeyPackageEligibility {
  /** True when the KeyPackage satisfies every add requirement (no reasons). */
  eligible: boolean;
  /** True when the KeyPackage's account is already a member of the group. */
  alreadyMember: boolean;
  /** The KeyPackage's MLS cipher suite id, or `-1` if the event was undecodable. */
  cipherSuite: number;
  /** Human-readable reasons the KeyPackage is not eligible (empty when it is). */
  reasons: string[];
}

/**
 * Evaluates whether a candidate's KeyPackage event (kind 30443) can be added to a
 * group, against every Marmot add requirement: cipher-suite match, the group's
 * `required_capabilities` (extension/proposal/credential types), its required
 * app components, the agent-text-stream-QUIC `required_member_roles` policy,
 * the Lifetime cap/current check, the `mls_proposals` tag matching the leaf's
 * advertised proposals (with or without GREASE), and whether the KeyPackage's
 * account is already a member.
 *
 * This is the eligibility logic an app needs before sending an invite — the
 * invite proposal itself enforces only {@link missingGroupRequirements}. A
 * `reasons` array of length 0 means the KeyPackage is safe to add; a non-empty
 * array explains every failing requirement. Never throws: an undecodable
 * KeyPackage yields `eligible: false` with an `undecodable: …` reason.
 *
 * @param state - The local group state to evaluate against (`group.state`).
 * @param keyPackageEvent - The invitee's kind-30443 KeyPackage event.
 */
export function evaluateKeyPackageForGroup(
  state: ClientState | GroupInfo,
  keyPackageEvent: NostrEvent,
): KeyPackageEligibility {
  const info = getMarmotGroupInfo(state);
  const members = new Set(info.members.pubkeys);
  const groupCipherSuite = state.groupContext.cipherSuite;

  const reasons: string[] = [];
  let alreadyMember = false;
  let cipherSuite = -1;

  try {
    const keyPackage = getKeyPackage(keyPackageEvent);
    cipherSuite = keyPackage.cipherSuite;

    const memberPubkey = getCredentialPubkey(keyPackage.leafNode.credential);
    if (members.has(memberPubkey)) {
      alreadyMember = true;
      reasons.push("already a member");
    }

    if (keyPackage.cipherSuite !== groupCipherSuite) {
      reasons.push(
        `cipher suite ${codePointHex(keyPackage.cipherSuite)} ≠ group ${codePointHex(groupCipherSuite)}`,
      );
    }

    reasons.push(
      ...missingGroupRequirements(keyPackage, state.groupContext.extensions),
    );

    // WIRE-01 (defense-in-depth): reject an over-long or expired Lifetime,
    // mirroring the hard-reject boundary at KeyPackageManager.track()/
    // createInviteIntent() so a caller invoking this evaluator directly
    // cannot bypass the cap/current check (RESEARCH A2).
    const lifetime = keyPackage.leafNode.lifetime;
    if (!isLifetimeWithinCap(lifetime)) {
      reasons.push("KeyPackage lifetime range exceeds the 7,261,200s cap");
    } else if (!isLifetimeCurrentWithGrace(lifetime)) {
      reasons.push("KeyPackage lifetime is not current (outside ~1h grace)");
    }

    // MDK exact-match parity (defense-in-depth): mirrors the createInviteIntent
    // hard reject, with the same rationale as the WIRE-01 Lifetime mirror
    // above. The mls_proposals tag must match the leaf's advertised proposals,
    // with GREASE included or removed from both sides. Reasons never echo tag
    // values (attacker-controlled).
    const proposalsCheck = checkKeyPackageProposalsTag(
      keyPackageEvent,
      keyPackage,
    );
    if (proposalsCheck.kind === "malformed") {
      reasons.push(
        "mls_proposals tag is malformed (absent, repeated, empty, or duplicate values)",
      );
    } else if (proposalsCheck.kind === "mismatch") {
      reasons.push(
        "mls_proposals tag does not match the KeyPackage's advertised proposals",
      );
    }
  } catch (err) {
    reasons.push(
      `undecodable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    eligible: reasons.length === 0,
    alreadyMember,
    cipherSuite,
    reasons,
  };
}
