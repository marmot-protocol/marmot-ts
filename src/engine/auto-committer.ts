/** @module @category Engine */

/**
 * Whether this client should commit a peer's `self_remove` proposal, or just
 * observe and let another member do it.
 */
export type AutoCommitDecision = "commit" | "observe";

/**
 * Decides whether *this* client auto-commits the round's `self_remove`
 * proposals (Marmot v2 `protocol-core/member-departure.md`, darkmatter
 * `auto_committer.rs`).
 *
 * A `self_remove`-only commit may carry several departures at once, so the
 * decision is over the whole leaver set rather than one proposal. Every
 * remaining member runs this independently on the same inputs, so the choice is
 * deterministic and exactly one member commits — which is what stops concurrent
 * committers from forking the group. The rule:
 *
 * 1. A leaver never commits the batch (RFC 9420 §12.2 — a committer cannot
 *    remove their own leaf).
 * 2. If any leaver is still an active admin the batch is refused: an admin MUST
 *    drop admin before leaving, so it would produce an invalid commit.
 *    `anyLeaverIsActiveAdmin` is fail-closed — pass `true` when the admin set or
 *    a leaver's identity cannot be read, so an unreadable state never commits.
 * 3. Otherwise the eligible committers are all current members except the
 *    leavers, and only the one with the lowest MLS leaf index commits.
 *
 * There is no fallback timer: if the lowest-index eligible member is offline,
 * the commit simply waits until they (or a re-evaluated set) act.
 */
export function decideAutoCommit(params: {
  /** Leaf indices of the leaving members (`self_remove` proposal senders). */
  leaverLeafIndices: number[];
  /** This client's own leaf index. */
  ownLeafIndex: number;
  /** Leaf indices of all current members (occupied leaves). */
  memberLeafIndices: number[];
  /** Whether any leaver is still an active admin (fail-closed: `true` if unknown). */
  anyLeaverIsActiveAdmin: boolean;
}): AutoCommitDecision {
  const {
    leaverLeafIndices,
    ownLeafIndex,
    memberLeafIndices,
    anyLeaverIsActiveAdmin,
  } = params;

  const leavers = new Set(leaverLeafIndices);
  if (leavers.size === 0) return "observe";

  // (1) A leaver never commits the batch.
  if (leavers.has(ownLeafIndex)) return "observe";

  // (2) An admin must leave the admin set before self-removing; never
  // auto-commit a batch containing an admin's self_remove (fail-closed).
  if (anyLeaverIsActiveAdmin) return "observe";

  // (3) Lowest-leaf-index eligible member (all members except the leavers) commits.
  const eligible = memberLeafIndices.filter((i) => !leavers.has(i));
  if (eligible.length === 0) return "observe";

  return ownLeafIndex === Math.min(...eligible) ? "commit" : "observe";
}
