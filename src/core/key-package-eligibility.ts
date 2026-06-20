/** @module @category Core - Key Package */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { ClientState, GroupInfo } from "ts-mls";

import { getMarmotGroupInfo } from "./client-state.js";
import { getCredentialPubkey } from "./credential.js";
import {
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_ROLE_FANOUT,
  AGENT_TEXT_STREAM_ROLE_RECEIVE,
  AGENT_TEXT_STREAM_ROLE_SEND,
} from "./components/agent-text-stream.js";
import { AGENT_TEXT_STREAM_QUIC_COMPONENT_ID } from "./components/ids.js";
import { getKeyPackage } from "./key-package-event.js";

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
 * `required_capabilities` (extension/proposal/credential types), the
 * agent-text-stream-QUIC `required_member_roles` policy, and whether the
 * KeyPackage's account is already a member.
 *
 * This is the eligibility logic an app needs before sending an invite — the
 * library's {@link createInviteIntent} only checks the credential identity. A
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

  const requiredExtension = state.groupContext.extensions.find(
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

  const policy = info.app.components.find(
    (component) => component.id === AGENT_TEXT_STREAM_QUIC_COMPONENT_ID,
  )?.decoded as { requiredMemberRoles?: number } | undefined;
  const requiredRoles = policy?.requiredMemberRoles ?? 0;

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

    const capabilities = keyPackage.leafNode.capabilities;
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

    for (const role of ROLE_CAPABILITIES) {
      if (
        requiredRoles & role.bit &&
        !capabilities.extensions.includes(role.extension)
      ) {
        reasons.push(
          `missing ${role.name} role ${codePointHex(role.extension)}`,
        );
      }
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
