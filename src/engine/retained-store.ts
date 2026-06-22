/** @module @category Engine */
import { type ClientState, type MlsMessage } from "ts-mls";

import {
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
} from "../core/convergence.js";

/**
 * The bounded convergence window — the recent canonical states + applied commits
 * the convergence hot path needs to rebuild candidate branches and recover from
 * forks and late delivery (Marmot v2 `protocol-core/retained-history.md`).
 *
 * Holds, keyed by epoch number:
 *  - the canonical {@link ClientState} *at* each retained epoch (the parent for
 *    the next commit), and
 *  - the commit message applied to advance *from* each source epoch on our
 *    current canonical branch.
 *
 * Both maps are bounded to the rollback horizon (`max_rewind_commits`): material
 * older than `tip - maxRewindCommits` is pruned on every {@link record}. This is
 * a purely **in-memory, derived** index: it is never persisted (the full-fork
 * {@link GroupHistoryTree} is the single persisted source) and is rebuilt from
 * the tree's canonical path on load.
 */
export class RetainedHistoryStore {
  /** Canonical state at each retained epoch. Holds the state *at* that epoch. */
  readonly #states = new Map<number, ClientState>();
  /** Commit applied to advance *from* each source epoch on our branch. */
  readonly #appliedCommits = new Map<number, MlsMessage>();
  readonly #policy: ConvergencePolicy;

  constructor(
    init: ClientState,
    policy: ConvergencePolicy = DEFAULT_CONVERGENCE_POLICY,
  ) {
    this.#policy = policy;
    this.#states.set(Number(init.groupContext.epoch), init);
  }

  /** The retained canonical state at `epoch`, if still held. */
  stateAt(epoch: number): ClientState | undefined {
    return this.#states.get(epoch);
  }

  /** Whether a canonical state is retained at `epoch`. */
  hasState(epoch: number): boolean {
    return this.#states.has(epoch);
  }

  /** All retained canonical states (for cross-epoch decrypt retries). */
  states(): IterableIterator<ClientState> {
    return this.#states.values();
  }

  /** Number of retained canonical states. */
  get size(): number {
    return this.#states.size;
  }

  /** The oldest retained epoch (the retained anchor), or undefined if empty. */
  anchorEpoch(): number | undefined {
    let min: number | undefined;
    for (const epoch of this.#states.keys())
      if (min === undefined || epoch < min) min = epoch;
    return min;
  }

  /**
   * The commits applied on our current canonical branch from `forkEpoch`
   * (inclusive) up to but not including `tipEpoch`, in epoch order.
   */
  appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[] {
    const out: MlsMessage[] = [];
    for (let e = forkEpoch; e < tipEpoch; e++) {
      const msg = this.#appliedCommits.get(e);
      if (msg) out.push(msg);
    }
    return out;
  }

  /**
   * Records the retained parent state and the applied commit message after
   * advancing an epoch, then prunes retained material beyond the rollback
   * horizon (`retained-history.md`).
   */
  record(
    parentState: ClientState,
    appliedMessage: MlsMessage,
    newState: ClientState,
  ): void {
    const parentEpoch = Number(parentState.groupContext.epoch);
    const newEpoch = Number(newState.groupContext.epoch);
    this.#states.set(parentEpoch, parentState);
    this.#states.set(newEpoch, newState);
    this.#appliedCommits.set(parentEpoch, appliedMessage);

    const floor = newEpoch - this.#policy.maxRewindCommits;
    for (const epoch of this.#states.keys())
      if (epoch < floor) this.#states.delete(epoch);
    for (const epoch of this.#appliedCommits.keys())
      if (epoch < floor) this.#appliedCommits.delete(epoch);
  }

  /** The highest retained epoch (the canonical tip), or undefined if empty. */
  tipEpoch(): number | undefined {
    let max: number | undefined;
    for (const epoch of this.#states.keys())
      if (max === undefined || epoch > max) max = epoch;
    return max;
  }
}
