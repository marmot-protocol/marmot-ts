import { isEvent, NostrEvent } from "applesauce-core/helpers/event";
import { type KeyPackage } from "ts-mls";
import { type ProposalAdd } from "ts-mls/proposal.js";
import { getKeyPackage } from "../../../core/key-package-event.js";
import { ProposalAction } from "../marmot-group.js";

/** Builds a proposal to invite a user to the group from a key package event or raw key package */
export function proposeInviteUser(
  keyPackageEvent: KeyPackage | NostrEvent,
): ProposalAction<ProposalAdd> {
  return async () => {
    const keyPackage = isEvent(keyPackageEvent)
      ? getKeyPackage(keyPackageEvent)
      : keyPackageEvent;

    return {
      proposalType: "add",
      add: { keyPackage },
    };
  };
}
