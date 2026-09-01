/** @module @category Core - Commit Authorization */
import {
  defaultProposalTypes,
  selfRemoveProposalType,
  type ProposalWithSender,
} from "ts-mls";

export type CommitAuthorizationDecision =
  | { authorized: true }
  | { authorized: false; reason: "non-admin-proposal-union" };

/**
 * Decide whether an actor may author the exact proposal union carried by a
 * commit. Admins may author any otherwise-valid union. A non-admin may author
 * only an empty/self-update commit, Updates sent exclusively by its own leaf,
 * or a SelfRemove-only union.
 *
 * This is deliberately independent of MLS state: callers must derive the
 * actor identity and leaf index from the local state and pass the exact
 * by-reference plus by-value union that `createCommit` will encode.
 *
 * @see refs/marmot/protocol-core/group-messaging.md "Commit authorization"
 */
export function decideCommitAuthorization(args: {
  actorPubkey: string;
  actorLeafIndex: number;
  adminPubkeys: readonly string[];
  proposals: readonly ProposalWithSender[];
}): CommitAuthorizationDecision {
  if (args.adminPubkeys.includes(args.actorPubkey)) return { authorized: true };

  const selfUpdateOnly = args.proposals.every(
    ({ proposal, senderLeafIndex }) =>
      proposal.proposalType === defaultProposalTypes.update &&
      senderLeafIndex !== undefined &&
      Number(senderLeafIndex) === Number(args.actorLeafIndex),
  );
  const selfRemoveOnly =
    args.proposals.length > 0 &&
    args.proposals.every(
      ({ proposal }) => proposal.proposalType === selfRemoveProposalType,
    );

  return selfUpdateOnly || selfRemoveOnly
    ? { authorized: true }
    : { authorized: false, reason: "non-admin-proposal-union" };
}
