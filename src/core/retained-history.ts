/** @module @category Core - Retained History */

/**
 * Retained-history decision logic (Marmot v2 `protocol-core/retained-history.md`).
 *
 * Clients retain group state so they can rebuild candidate branches and recover
 * from forks and late delivery. The **retained anchor** is the oldest state from
 * which a client can rebuild a candidate branch; the **rollback horizon**
 * (`max_rewind_commits`) bounds how far back a branch may fork. These pure
 * functions classify late commits, expire old app payloads, and decide what
 * must be retained vs. may be pruned — without consulting transport order.
 */

/** The outcome of judging a late commit by its source epoch. */
export type LateCommitOutcome =
  /** Source epoch is at/after the anchor with retained state present: replayable. */
  | { kind: "replay" }
  /** Source epoch is older than the retained anchor: drop as BeyondAnchor. */
  | { kind: "beyond_anchor" }
  /** Inside the rollback horizon but required retained state was lost: → Unrecoverable. */
  | { kind: "missing_retained_anchor" }
  /** Parent commit has not arrived yet: wait for it (a transport gap, not loss). */
  | { kind: "deferred" }
  /** At/after the anchor but forks from outside the rollback horizon: not selectable. */
  | { kind: "ineligible" };

/** Inputs for {@link classifyLateCommit}. */
export interface LateCommitContext {
  /** The late commit's MLS source epoch (the epoch it advances from). */
  sourceEpoch: number;
  /** The oldest retained state epoch (the retained anchor). */
  anchorEpoch: number;
  /** The current canonical tip epoch. */
  currentTipEpoch: number;
  /** The group's rollback horizon (`max_rewind_commits`). */
  maxRewindCommits: number;
  /** Whether the commit's parent commit has arrived (so its parent epoch is known). */
  parentArrived: boolean;
  /** Whether the retained parent state needed to replay is still in storage. */
  retainedParentStateAvailable: boolean;
}

/**
 * Classifies a late commit per `retained-history.md` "Late commits".
 *
 * Precedence: a commit below the anchor is always `beyond_anchor`; otherwise a
 * commit whose parent has not arrived is `deferred` (a transport gap, not
 * storage loss); within the rollback horizon it `replay`s when its retained
 * parent state is present and is `missing_retained_anchor` (→ `Unrecoverable`)
 * when that state was lost from storage; at/after the anchor but outside the
 * horizon it is `ineligible` for selection.
 */
export function classifyLateCommit(ctx: LateCommitContext): LateCommitOutcome {
  if (ctx.sourceEpoch < ctx.anchorEpoch) return { kind: "beyond_anchor" };
  if (!ctx.parentArrived) return { kind: "deferred" };

  const withinHorizon =
    ctx.currentTipEpoch - ctx.sourceEpoch <= ctx.maxRewindCommits;
  if (!withinHorizon) return { kind: "ineligible" };

  return ctx.retainedParentStateAvailable
    ? { kind: "replay" }
    : { kind: "missing_retained_anchor" };
}

/**
 * Whether an MLS application message has fallen outside the retained app-payload
 * window and MUST expire: it is more than `appPayloadPastEpochLimit` past epochs
 * behind the current tip.
 */
export function isAppPayloadExpired(
  messageEpoch: number,
  currentTipEpoch: number,
  appPayloadPastEpochLimit: number,
): boolean {
  return currentTipEpoch - messageEpoch > appPayloadPastEpochLimit;
}

/**
 * The minimum set of epochs a client must retain to replay candidate branches
 * inside the rollback horizon: every epoch from `tip - maxRewindCommits` (floored
 * at 0) through the current tip. Staged-commit and deferred-parent states are
 * additional and tracked separately by the caller.
 */
export function requiredRetainedEpochs(
  currentTipEpoch: number,
  maxRewindCommits: number,
): number[] {
  const floor = Math.max(0, currentTipEpoch - maxRewindCommits);
  const epochs: number[] = [];
  for (let e = floor; e <= currentTipEpoch; e++) epochs.push(e);
  return epochs;
}

/**
 * The retained epochs a client SHOULD prune after convergence settles: those
 * older than the rollback horizon, excluding any `pinnedEpochs` still needed to
 * resolve an active PendingPublish / Merging / Recovering / Unrecoverable state.
 */
export function prunableRetainedEpochs(
  retainedEpochs: Iterable<number>,
  currentTipEpoch: number,
  maxRewindCommits: number,
  pinnedEpochs: Iterable<number> = [],
): number[] {
  const floor = Math.max(0, currentTipEpoch - maxRewindCommits);
  const pinned = new Set(pinnedEpochs);
  const prunable: number[] = [];
  for (const epoch of retainedEpochs) {
    if (epoch < floor && !pinned.has(epoch)) prunable.push(epoch);
  }
  return prunable.sort((a, b) => a - b);
}
