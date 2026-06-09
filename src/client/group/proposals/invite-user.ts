/** @module @category Client - Proposals */
import { isEvent, NostrEvent } from "applesauce-core/helpers/event";

import { defaultProposalTypes, ProposalAdd, type KeyPackage } from "ts-mls";
import {
  ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
  verifyLeafAccountIdentityProof,
} from "../../../core/account-identity-proof.js";
import { getKeyPackage } from "../../../core/key-package-event.js";
import { ProposalAction } from "../marmot-group.js";

/** Builds a proposal to invite a user to the group from a key package event or raw key package */
export function proposeInviteUser(
  keyPackageEvent: KeyPackage | NostrEvent,
): ProposalAction<ProposalAdd> {
  return async ({ ciphersuite }) => {
    const keyPackage = isEvent(keyPackageEvent)
      ? getKeyPackage(keyPackageEvent)
      : keyPackageEvent;

    // When the invitee's LeafNode carries a Marmot account identity proof,
    // verify it before adding them (darkmatter validates this on every leaf).
    // Leaves without the proof are still allowed for backwards compatibility.
    const hasProof = keyPackage.leafNode.extensions.some(
      (e) => e.extensionType === ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE,
    );
    if (hasProof) {
      verifyLeafAccountIdentityProof(keyPackage.leafNode, ciphersuite.id);
    }

    return {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    };
  };
}
