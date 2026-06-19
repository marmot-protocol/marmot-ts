/** @module @category Core - App Components */
import { BinaryReader, BinaryWriter } from "../binary.js";

/**
 * Codec for `marmot.group.agent-text-stream.quic.v1` (`0x8006`) — the policy
 * gating the QUIC agent-text-stream transport binding.
 *
 * Wire (Marmot binary profile): a fixed 12-byte record, no length prefixes.
 *   uint8  required_member_roles;
 *   uint8  allowed_member_roles;
 *   uint32 max_plaintext_frame_len;   // big-endian
 *   uint32 replay_ttl_secs;           // big-endian
 *   uint16 padding_bucket_bytes;      // big-endian
 *
 * @see darkmatter `crates/traits/src/agent_text_stream.rs` `encode_component_state`
 */

export const AGENT_TEXT_STREAM_ROLE_RECEIVE = 0x01;
export const AGENT_TEXT_STREAM_ROLE_SEND = 0x02;
export const AGENT_TEXT_STREAM_ROLE_FANOUT = 0x04;
const ROLE_MASK =
  AGENT_TEXT_STREAM_ROLE_RECEIVE |
  AGENT_TEXT_STREAM_ROLE_SEND |
  AGENT_TEXT_STREAM_ROLE_FANOUT;

/**
 * MLS LeafNode extension types that advertise each agent-text-stream-QUIC member
 * role. A member advertises a role by listing the role's extension type in its
 * LeafNode capabilities (agent-text-stream-quic-v1.md "role capability"); a
 * group's `required_member_roles` mask is enforced against these on invite/join.
 * A client that does not advertise a required role capability cannot be invited
 * into the group.
 *
 * @see darkmatter `crates/traits/src/agent_text_stream.rs`
 *   (`AGENT_TEXT_STREAM_QUIC_{RECEIVE,SEND,FANOUT}_CAPABILITY`)
 */
export const AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE = 0xf2d1;
export const AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE = 0xf2d2;
export const AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE = 0xf2d4;

/**
 * All agent-text-stream-QUIC role capability extension types, ascending — the
 * full registered set (`registries.md`).
 *
 * Note: marmot-ts only *advertises* `receive` in its KeyPackage capabilities
 * (see {@link ensureMarmotCapabilities}), because it has no QUIC data plane and
 * `receive` is satisfiable by reading the final MLS message. This list is the
 * registry reference for all three roles, not the set marmot-ts claims.
 */
export const AGENT_TEXT_STREAM_QUIC_ROLE_EXTENSION_TYPES = [
  AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_SEND_EXTENSION_TYPE,
  AGENT_TEXT_STREAM_QUIC_FANOUT_EXTENSION_TYPE,
] as const;

const COMPONENT_STATE_LEN = 12;
// 65519 (not 64*1024) keeps a maximum-length frame's ciphertext within one
// QUIC datagram, matching darkmatter AGENT_TEXT_STREAM_MAX_PLAINTEXT_FRAME_LEN
// (agent_text_stream.rs). A larger cap would accept policy bytes a conformant
// peer rejects.
const MAX_PLAINTEXT_FRAME_LEN = 65519;
const MAX_REPLAY_TTL_SECS = 5 * 60;
const MAX_PADDING_BUCKET_BYTES = 4096;

export interface AgentTextStreamQuicPolicyV1 {
  requiredMemberRoles: number;
  allowedMemberRoles: number;
  maxPlaintextFrameLen: number;
  replayTtlSecs: number;
  paddingBucketBytes: number;
}

function validate(policy: AgentTextStreamQuicPolicyV1): void {
  const {
    requiredMemberRoles,
    allowedMemberRoles,
    maxPlaintextFrameLen,
    replayTtlSecs,
    paddingBucketBytes,
  } = policy;
  if (requiredMemberRoles === 0) {
    throw new Error("required agent text stream roles cannot be empty");
  }
  if (requiredMemberRoles & ~ROLE_MASK) {
    throw new Error(
      "required agent text stream role mask contains unknown bits",
    );
  }
  if (allowedMemberRoles & ~ROLE_MASK) {
    throw new Error(
      "allowed agent text stream role mask contains unknown bits",
    );
  }
  if (requiredMemberRoles & ~allowedMemberRoles) {
    throw new Error(
      "required agent text stream roles must be a subset of allowed roles",
    );
  }
  if (maxPlaintextFrameLen === 0) {
    throw new Error("agent text stream plaintext frame limit cannot be zero");
  }
  if (maxPlaintextFrameLen > MAX_PLAINTEXT_FRAME_LEN) {
    throw new Error(
      "agent text stream plaintext frame limit exceeds app profile max",
    );
  }
  if (replayTtlSecs > MAX_REPLAY_TTL_SECS) {
    throw new Error("agent text stream replay ttl exceeds app profile max");
  }
  if (paddingBucketBytes > MAX_PADDING_BUCKET_BYTES) {
    throw new Error("agent text stream padding bucket exceeds app profile max");
  }
}

/** Encodes an {@link AgentTextStreamQuicPolicyV1} to its 12-byte component `data`. */
export function encodeAgentTextStreamQuicPolicyV1(
  policy: AgentTextStreamQuicPolicyV1,
): Uint8Array {
  validate(policy);
  return new BinaryWriter()
    .uint8(policy.requiredMemberRoles)
    .uint8(policy.allowedMemberRoles)
    .uint32(policy.maxPlaintextFrameLen)
    .uint32(policy.replayTtlSecs)
    .uint16(policy.paddingBucketBytes)
    .build();
}

/** Decodes `marmot.group.agent-text-stream.quic.v1` component `data` bytes. */
export function decodeAgentTextStreamQuicPolicyV1(
  data: Uint8Array,
): AgentTextStreamQuicPolicyV1 {
  if (data.length !== COMPONENT_STATE_LEN) {
    throw new Error(
      `agent text stream component state must be ${COMPONENT_STATE_LEN} bytes, got ${data.length}`,
    );
  }
  const reader = new BinaryReader(data);
  const policy: AgentTextStreamQuicPolicyV1 = {
    requiredMemberRoles: reader.uint8(),
    allowedMemberRoles: reader.uint8(),
    maxPlaintextFrameLen: reader.uint32(),
    replayTtlSecs: reader.uint32(),
    paddingBucketBytes: reader.uint16(),
  };
  reader.end();
  validate(policy);
  return policy;
}
