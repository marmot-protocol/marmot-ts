/** @module @category Core - Capabilities */
import {
  appDataDictionaryExtensionType,
  appDataUpdateProposalType,
  Capabilities,
} from "ts-mls";
import { ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE } from "./account-identity-proof.js";
import { LAST_RESORT_EXTENSION_TYPE } from "./protocol.js";

/**
 * Ensures a {@link Capabilities} object advertises the MLS code points a Marmot
 * v2 group relies on, so a LeafNode bearing these capabilities passes MLS
 * leaf-capability validation when added to a group that carries them.
 *
 * Marmot v2 stores group state as versioned app components in the
 * `app_data_dictionary` GroupContext extension (`0x0006`) and mutates them with
 * `app_data_update` proposals (`0x0008`), both from draft-ietf-mls-extensions-09.
 * Every member MUST advertise support for the extension and the proposal type.
 * `last_resort` (`0x000a`) is also advertised for key-package reuse.
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

  // app_data_update proposal that mutates the dictionary inside a commit.
  if (!proposals.includes(appDataUpdateProposalType))
    proposals.push(appDataUpdateProposalType);

  return {
    ...capabilities,
    extensions,
    proposals,
  };
}
