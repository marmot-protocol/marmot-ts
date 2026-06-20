/** @module @category Engine */
import {
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type ClientState,
  type MlsMessage,
} from "ts-mls";

import { BinaryReader, BinaryWriter } from "../core/binary.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../core/client-state.js";
import {
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
} from "../core/convergence.js";

/** Wire-format version byte for {@link RetainedHistoryStore.serialize}. */
const RETAINED_SNAPSHOT_VERSION = 1;

/** A decoded {@link RetainedHistoryStore} snapshot (epoch-keyed pairs). */
export interface RetainedHistorySnapshot {
  /** `[epoch, state]` pairs — the canonical state at each retained epoch. */
  states: [number, ClientState][];
  /** `[epoch, commit]` pairs — the commit applied to advance from each epoch. */
  appliedCommits: [number, MlsMessage][];
}

/**
 * Retained group history used to rebuild candidate branches and recover from
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
 * the engine's `epoch_manager` / `message_processor/store` seam, separated from
 * the stateful ingest and fork-recovery flows that consume it.
 */
export class RetainedHistoryStore {
  /** Canonical state at each retained epoch. Holds the state *at* that epoch. */
  readonly #states = new Map<number, ClientState>();
  /** Commit applied to advance *from* each source epoch on our branch. */
  readonly #appliedCommits = new Map<number, MlsMessage>();
  readonly #policy: ConvergencePolicy;

  constructor(
    init: ClientState | RetainedHistorySnapshot,
    policy: ConvergencePolicy = DEFAULT_CONVERGENCE_POLICY,
  ) {
    this.#policy = policy;
    if ("states" in init) {
      for (const [epoch, state] of init.states) this.#states.set(epoch, state);
      for (const [epoch, message] of init.appliedCommits)
        this.#appliedCommits.set(epoch, message);
    } else {
      this.#states.set(Number(init.groupContext.epoch), init);
    }
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

  /**
   * Serializes the retained history (states + applied commits) to the Marmot
   * binary profile, so the rewind window can survive a restart. `ClientState`s
   * use the ts-mls TLS encoding (`serializeClientState`); applied commits use the
   * ts-mls `mlsMessageEncoder`. Both maps are already bounded to the rollback
   * horizon, so the output is small (≤ `maxRewindCommits` entries each).
   */
  serialize(): Uint8Array {
    const states: Uint8Array[] = [];
    for (const [epoch, state] of this.#states) {
      states.push(
        new BinaryWriter()
          .varint(epoch)
          .opaque(serializeClientState(state))
          .build(),
      );
    }

    const commits: Uint8Array[] = [];
    for (const [epoch, message] of this.#appliedCommits) {
      commits.push(
        new BinaryWriter()
          .varint(epoch)
          .opaque(encode(mlsMessageEncoder, message))
          .build(),
      );
    }

    return new BinaryWriter()
      .uint8(RETAINED_SNAPSHOT_VERSION)
      .vector(states)
      .vector(commits)
      .build();
  }

  /**
   * Decodes bytes from {@link serialize} into a {@link RetainedHistorySnapshot}.
   * Pass the result to the constructor to rebuild a store. Throws on an unknown
   * version byte or malformed input.
   */
  static deserialize(bytes: Uint8Array): RetainedHistorySnapshot {
    const reader = new BinaryReader(bytes);
    const version = reader.uint8();
    if (version !== RETAINED_SNAPSHOT_VERSION) {
      throw new Error(
        `RetainedHistoryStore: unknown snapshot version ${version}`,
      );
    }

    const states = reader.vector<[number, ClientState]>((r) => {
      const epoch = r.varint();
      return [epoch, deserializeClientState(r.opaque())];
    });
    const appliedCommits = reader.vector<[number, MlsMessage]>((r) => {
      const epoch = r.varint();
      const message = decode(mlsMessageDecoder, r.opaque());
      if (!message)
        throw new Error(
          "RetainedHistoryStore: failed to decode applied commit",
        );
      return [epoch, message];
    });
    reader.end();

    return { states, appliedCommits };
  }
}
