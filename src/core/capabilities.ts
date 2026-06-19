/** @module @category Core - Capabilities */
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  Capabilities,
  defaultExtensionTypes,
  type ExtensionRequiredCapabilities,
  selfRemoveProposalType,
} from "ts-mls";
import { ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE } from "./account-identity-proof.js";
import { LAST_RESORT_EXTENSION_TYPE } from "./protocol.js";
import { AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE } from "./components/agent-text-stream.js";

/**
 * Ensures a {@link Capabilities} object advertises the MLS code points a Marmot
 * v2 group relies on, so a LeafNode bearing these capabilities passes MLS
 * leaf-capability validation when added to a group that carries them.
 *
 * Marmot v2 stores group state as versioned app components in the
 * `app_data_dictionary` GroupContext extension (`0x0006`) and mutates them with
 * `app_data_update` proposals (`0x0008`), both from draft-ietf-mls-extensions-09.
 * Every member MUST advertise support for the extension and the proposal type.
 * `last_resort` (`0x000a` extension) is also advertised for key-package reuse,
 * and the `self_remove` proposal (`0x000a` proposal type) for member departure
 * (`protocol-core/member-departure.md`).
 *
 * The agent-text-stream-QUIC `receive` role capability (`0xf2d1`) is advertised
 * so a member can be invited into a group whose
 * `marmot.group.agent-text-stream.quic.v1` (`0x8006`) policy requires it —
 * darkmatter's default group sets `required_member_roles = receive`, and its
 * `do_send_invite` rejects any KeyPackage missing a required role capability
 * (`agent-text-stream-quic-v1.md`).
 *
 * Only `receive` is advertised. The role extensions are capability *markers*
 * (`registries.md`: "v1 defines no extension data for them"), and a client that
 * does not implement raw QUIC is explicitly conformant — it "ignores the live
 * preview and waits for the final MLS message" (`transports/quic.md`). marmot-ts
 * honestly satisfies `receive` that way: it has no QUIC data plane (and raw QUIC
 * is not portably available in browsers/Node/Bun), so it never advertises
 * `send` (`0xf2d2`) or `fanout` (`0xf2d4`), which would claim the ability to
 * originate or relay live QUIC streams it cannot fulfill.
 */
export function ensureMarmotCapabilities(
  capabilities: Capabilities,
): Capabilities {
  const extensions = Array.from(capabilities.extensions);
  const proposals = Array.from(capabilities.proposals);

  // app_data_dictionary extension carrying the group's app components.
  if (!extensions.includes(appDataDictionaryExtensionType))
    extensions.push(appDataDictionaryExtensionType);

  // last_resort extension for reusable key packages.
  if (!extensions.includes(LAST_RESORT_EXTENSION_TYPE))
    extensions.push(LAST_RESORT_EXTENSION_TYPE);

  // account identity proof carried on the LeafNode binding the Nostr account.
  if (!extensions.includes(ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE))
    extensions.push(ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE);

  // agent-text-stream-QUIC `receive` role capability so a group that requires it
  // (e.g. darkmatter's default group) can invite this member. `receive` is an
  // honest marker for a non-QUIC client (it reads the final MLS message); `send`
  // and `fanout` are deliberately not advertised — see the doc comment above.
  if (!extensions.includes(AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE))
    extensions.push(AGENT_TEXT_STREAM_QUIC_RECEIVE_EXTENSION_TYPE);

  // app_data_update proposal that mutates the dictionary inside a commit.
  if (!proposals.includes(appDataUpdateProposalType))
    proposals.push(appDataUpdateProposalType);

  // self_remove proposal for member departure (MIP-03).
  if (!proposals.includes(selfRemoveProposalType))
    proposals.push(selfRemoveProposalType);

  return {
    ...capabilities,
    extensions,
    proposals,
  };
}

/**
 * The Marmot v2 baseline `required_capabilities` (`0x0003`) GroupContext
 * extension, set at group creation so every current and future member MUST
 * advertise the protocol-mandatory code points. MLS then refuses to add a
 * member whose LeafNode does not cover them (capability-negotiation.md §5.2
 * "enforce on add").
 *
 * The baseline is fixed, not member-derived: the `app_data_dictionary`
 * extension (`0x0006`) and account-identity-proof extension (`0xF2F1`) plus the
 * `app_data_update` (`0x0008`) and `self_remove` (`0x000a`) proposals. The
 * `self_remove` requirement matches a darkmatter MIP-03 client (which registers
 * the self-remove feature as Required, advertising proposal type 10 in both leaf
 * and required capabilities). Lists are sorted ascending to mirror the Rust
 * `BTreeSet` ordering; `credentialTypes` is empty.
 */
export function marmotRequiredCapabilitiesExtension(): ExtensionRequiredCapabilities {
  const extensionTypes = [
    appDataDictionaryExtensionType,
    ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  ].sort((a, b) => a - b);

  const proposalTypes = [
    appDataUpdateProposalType,
    selfRemoveProposalType,
  ].sort((a, b) => a - b);

  return {
    extensionType: defaultExtensionTypes.required_capabilities,
    extensionData: {
      extensionTypes,
      proposalTypes,
      credentialTypes: [],
    },
  };
}
