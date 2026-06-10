/** @module @category Client - Proposals */
import { isEvent, NostrEvent } from "applesauce-core/helpers/event";

import { defaultProposalTypes, ProposalAdd, type KeyPackage } from "ts-mls";
import { verifyLeafAccountIdentityProof } from "../../../core/account-identity-proof.js";
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

    // The invitee's LeafNode MUST carry a valid Marmot account identity proof;
    // the spec validates this on every leaf with no legacy fallback
    // (foundation/account-identity-proof-v1.md §Validation). Throws if missing
    // or invalid.
    verifyLeafAccountIdentityProof(keyPackage.leafNode, ciphersuite.id);

    return {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    };
  };
}
