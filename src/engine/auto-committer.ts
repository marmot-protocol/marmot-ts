/** @module @category Engine */

/**
 * Whether this client should commit a peer's `self_remove` proposal, or just
 * observe and let another member do it.
 */
export type AutoCommitDecision = "commit" | "observe";

/**
 * Decides whether *this* client auto-commits a `self_remove` proposal
 * (Marmot v2 `protocol-core/member-departure.md`, darkmatter `auto_committer.rs`).
 *
 * Every remaining member runs this independently on the same inputs, so the
 * choice is deterministic and exactly one member commits — which is what stops
 * concurrent committers from forking the group. The rule:
 *
 * 1. The leaver never commits their own removal (RFC 9420 §12.2 — a committer
 *    cannot remove their own leaf).
 * 2. An active-admin leaver is refused: an admin MUST drop admin first, so a
 *    `self_remove` from an admin is not auto-committed. `leaverIsActiveAdmin`
 *    is fail-closed — pass `true` when the admin set or the leaver's identity
 *    cannot be read, so an unreadable state never triggers a commit.
 * 3. Otherwise the eligible committers are all current members except the
 *    leaver, and only the one with the lowest MLS leaf index commits.
 *
 * There is no fallback timer: if the lowest-index eligible member is offline,
 * the commit simply waits until they (or a re-evaluated set) act.
 */
export function decideAutoCommit(params: {
  /** Leaf index of the leaving member (the `self_remove` proposal's sender). */
  leaverLeafIndex: number;
  /** This client's own leaf index. */
  ownLeafIndex: number;
  /** Leaf indices of all current members (occupied leaves). */
  memberLeafIndices: number[];
  /** Whether the leaver is still an active admin (fail-closed: `true` if unknown). */
  leaverIsActiveAdmin: boolean;
}): AutoCommitDecision {
  const {
    leaverLeafIndex,
    ownLeafIndex,
    memberLeafIndices,
    leaverIsActiveAdmin,
  } = params;

  // (1) The leaver cannot commit their own self_remove.
  if (ownLeafIndex === leaverLeafIndex) return "observe";

  // (2) An admin must leave the admin set before self-removing; never
  // auto-commit an admin's self_remove (fail-closed on unreadable state).
  if (leaverIsActiveAdmin) return "observe";

  // (3) Lowest-leaf-index eligible member (all members except the leaver) commits.
  const eligible = memberLeafIndices.filter((i) => i !== leaverLeafIndex);
  if (eligible.length === 0) return "observe";
  const lowest = Math.min(...eligible);

  return ownLeafIndex === lowest ? "commit" : "observe";
}
