/** @module @category Core - Group Lifecycle */

/**
 * The Marmot v2 group lifecycle state machine (`protocol-core/group-state.md`).
 *
 * Each group has exactly one canonical MLS state at a time; a client may hold
 * candidate or pending state transiently but exposes only one canonical state.
 * The lifecycle gates when local commits may be prepared and whether retained
 * inbound may change canonical state.
 */
export const groupLifecycleStates = {
  /** Has a canonical MLS epoch; normal inbound/outbound work may proceed. */
  stable: "Stable",
  /** A local group-state commit is prepared but its publish is unconfirmed. */
  pendingPublish: "PendingPublish",
  /** Publication confirmed; the staged commit is being applied locally. */
  merging: "Merging",
  /** A fork-shaped conflict was detected; selecting a safe retained branch. */
  recovering: "Recovering",
  /** No safe branch can be selected from retained local material (client-local). */
  unrecoverable: "Unrecoverable",
} as const;

/** A group lifecycle state value. */
export type GroupLifecycleState =
  (typeof groupLifecycleStates)[keyof typeof groupLifecycleStates];

const S = groupLifecycleStates;

/**
 * The legal lifecycle transitions from `group-state.md`. `Recovering` also
 * re-enters itself implicitly (convergence input arriving mid-recovery folds
 * into the same pass), so it is included as a self-edge.
 */
const LEGAL_TRANSITIONS: Record<GroupLifecycleState, GroupLifecycleState[]> = {
  [S.stable]: [S.pendingPublish, S.recovering],
  [S.pendingPublish]: [S.merging, S.stable],
  [S.merging]: [S.stable],
  [S.recovering]: [S.stable, S.unrecoverable, S.recovering],
  [S.unrecoverable]: [S.stable],
};

/** Returns whether `from -> to` is a legal lifecycle transition. */
export function canTransitionLifecycle(
  from: GroupLifecycleState,
  to: GroupLifecycleState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Throws if `from -> to` is not a legal lifecycle transition; returns `to`. */
export function transitionLifecycle(
  from: GroupLifecycleState,
  to: GroupLifecycleState,
): GroupLifecycleState {
  if (!canTransitionLifecycle(from, to))
    throw new Error(`Illegal group lifecycle transition: ${from} -> ${to}`);
  return to;
}

/**
 * A client MAY prepare a new local group-state commit only in `Stable`. (Fork
 * detection also runs only from `Stable`.)
 */
export function mayPrepareLocalCommit(state: GroupLifecycleState): boolean {
  return state === S.stable;
}

/**
 * Whether retained inbound may change canonical group state in this lifecycle
 * state. Only `Stable` (normal processing) and `Recovering` (a selected branch
 * is applied) may; `PendingPublish`, `Merging`, and `Unrecoverable` MUST NOT.
 */
export function mayApplyRetainedInbound(state: GroupLifecycleState): boolean {
  return state === S.stable || state === S.recovering;
}

/** Whether fork detection may run (only from settled `Stable` canonical state). */
export function mayRunForkDetection(state: GroupLifecycleState): boolean {
  return state === S.stable;
}
