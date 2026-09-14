/** @module @category Client - Proposals */
import { isEvent, NostrEvent } from "applesauce-core/helpers/event";

import { defaultProposalTypes, ProposalAdd, type KeyPackage } from "ts-mls";
import { validateKeyPackageAccountIdentityProof } from "../../../core/components/account-identity-proof.js";
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

    // The invitee KeyPackage is validated with its own ciphersuite, which must
    // equal the group's (refs/marmot/app-components/account-identity-proof-v2.md
    // "Validation"). Throws AccountIdentityProofError on any mismatch, or a
    // missing/forged/legacy/misplaced proof.
    validateKeyPackageAccountIdentityProof(keyPackage, ciphersuite.id);

    return {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage },
    };
  };
}
