/** @module @category Core - Convergence */
import {
  groupLifecycleStates,
  type GroupLifecycleState,
} from "./group-lifecycle.js";

/**
 * Convergence status (Marmot v2 `protocol-core/group-state.md` §Convergence
 * status) — a *derived* view of how convergence is progressing within the
 * authoritative lifecycle state. It is computed from stored input and policy; it
 * is never stored state and never a claim made by the transport.
 *
 * Ported from darkmatter `cgka-engine/src/canonicalization.rs`
 * (`ConvergenceStatus`, `convergence_status_for_result`). The lifecycle state
 * ({@link GroupLifecycleState}) stays authoritative; this is the settle-window
 * spine layered on top that gates when queued outbound work may be released.
 */
export const convergenceStatuses = {
  /** Convergence-relevant input is still arriving, or the quiescence window has not elapsed. */
  syncing: "Syncing",
  /**
   * The quiescence window elapsed, but unresolved convergence work remains —
   * e.g. a child commit whose parent has not been retained or fetched yet.
   */
  resolving: "Resolving",
  /** Candidate processing reached a fixed point and the selected branch, if any, was applied. */
  settled: "Settled",
  /** Candidate processing cannot safely continue without a repair path or missing retained material. */
  blocked: "Blocked",
} as const;

/** A convergence status value. */
export type ConvergenceStatus =
  (typeof convergenceStatuses)[keyof typeof convergenceStatuses];

/** The inputs from which {@link deriveConvergenceStatus} computes the status. */
export interface ConvergenceStatusInput {
  /** Current wall-clock time (ms). */
  nowMs: number;
  /**
   * Timestamp (ms) of the most recent convergence-relevant input (a commit, or
   * fork material entering recovery). Non-convergence traffic (application
   * messages, lone proposals) MUST NOT advance this.
   */
  lastConvergenceRelevantInputMs: number;
  /** The quiescence window (`settlementQuiescenceMs` from the convergence policy). */
  settlementQuiescenceMs: number;
  /**
   * Whether the last convergence pass left a non-proposal input message without
   * a disposition (e.g. a child commit whose parent has not been materialized).
   * A lone uncommitted proposal does NOT count — commits are the consensus log
   * and a proposal only takes effect once a commit consumes it
   * (`convergence.md`), so an un-dispositioned proposal must not pin the pass in
   * `Resolving` (darkmatter#154).
   */
  hasUnresolvedInput: boolean;
  /**
   * Whether convergence hit a blocking error that retained material cannot clear
   * — the `MissingRetainedAnchor` condition (`has_blocking_convergence_error`).
   */
  hasBlockingError: boolean;
}

/**
 * Derives the {@link ConvergenceStatus} for a convergence pass, mirroring
 * darkmatter `convergence_status_for_result`. The order is load-bearing: the
 * quiescence window gates first (`Syncing`), then unresolved input
 * (`Resolving`) takes precedence over a blocking error (`Blocked`), and a clean
 * fixed point is `Settled`.
 */
export function deriveConvergenceStatus(
  input: ConvergenceStatusInput,
): ConvergenceStatus {
  const elapsed = Math.max(
    0,
    input.nowMs - input.lastConvergenceRelevantInputMs,
  );
  if (elapsed < input.settlementQuiescenceMs)
    return convergenceStatuses.syncing;
  if (input.hasUnresolvedInput) return convergenceStatuses.resolving;
  if (input.hasBlockingError) return convergenceStatuses.blocked;
  return convergenceStatuses.settled;
}

const S = groupLifecycleStates;

/**
 * The legal (convergence status → lifecycle state) combinations from
 * `group-state.md`. The lifecycle state is authoritative; a status that does
 * not pair with the current lifecycle indicates a coordination bug.
 */
const LEGAL_COMBINATIONS: Record<ConvergenceStatus, GroupLifecycleState[]> = {
  [convergenceStatuses.syncing]: [S.stable, S.recovering],
  [convergenceStatuses.resolving]: [S.stable, S.recovering],
  [convergenceStatuses.settled]: [S.stable],
  [convergenceStatuses.blocked]: [S.recovering, S.unrecoverable],
};

/**
 * Whether `status` may legally appear in `lifecycle` (`group-state.md` table).
 * `PendingPublish` and `Merging` are local-publish states, not convergence
 * passes, so no convergence status is meaningful in them — this returns `false`.
 */
export function isConvergenceStatusLegal(
  status: ConvergenceStatus,
  lifecycle: GroupLifecycleState,
): boolean {
  return LEGAL_COMBINATIONS[status].includes(lifecycle);
}

/**
 * Whether a client SHOULD queue a local outbound intent rather than preparing it
 * now (`group-state.md` §Local actions during convergence). Outbound work is
 * released only once convergence is `Settled`; `Syncing`, `Resolving`, and
 * `Blocked` all queue, because a state that MAY lose branch selection or require
 * repair must not have payloads encrypted or commits staged against it.
 */
export function shouldQueueOutbound(status: ConvergenceStatus): boolean {
  return status !== convergenceStatuses.settled;
}

/**
 * Whether queued outbound work may be released and prepared now: convergence is
 * `Settled` AND the lifecycle allows outbound work. Per the legal-combination
 * table `Settled` only appears in `Stable`, so this is `Settled` + `Stable`;
 * both are checked so a caller passing an inconsistent pair fails closed.
 */
export function mayReleaseOutbound(
  status: ConvergenceStatus,
  lifecycle: GroupLifecycleState,
): boolean {
  return status === convergenceStatuses.settled && lifecycle === S.stable;
}
