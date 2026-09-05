/** @module @category Engine */

/** One pooled envelope awaiting a retained state that can decrypt it. */
export interface PooledEntry<TEnvelope> {
  /** Stable transport id (kind-445 event id) — the pool key. */
  id: string;
  /** The raw undecryptable envelope. */
  envelope: TEnvelope;
  /** MLS-authenticated source epoch, when the wrapper has been peeled. */
  sourceEpoch?: number;
  /**
   * History-tree node tags this entry has already been peeled against without
   * success, so the tree-targeted sweep tries each `(event, node)` pair once.
   */
  triedTags: Set<string>;
}

/** Tuning for {@link IngestionPool}. */
export interface IngestionPoolOptions {
  /** Max entries; new entries are refused while the pool is full. */
  maxSize?: number;
  /** Rollback horizon used for authenticated source-epoch expiry. */
  maxRewindCommits?: number;
}

export type PoolAddResult =
  | { kind: "accepted" }
  | { kind: "refused"; reason: "capacity" };

const DEFAULT_MAX_SIZE = 1000;

/**
 * A persistent pool of incoming events that could not yet be decrypted against
 * any tried state (Marmot v2 `protocol-core/inbound-processing.md` "deferred").
 *
 * Transport delivers events roughly chronologically, so a message from a newer
 * epoch routinely arrives before the commit that unlocks its epoch key — and a
 * fork/old-epoch message may arrive long after. Rather than dropping these as
 * terminally unreadable, the engine holds them here and retries as the history
 * tree grows (a new commit reaches their epoch, or a retained fork state is
 * tried). Bounded by size and epoch-age so genuinely-undecryptable garbage
 * (foreign or spam kind-445 events) cannot grow it without limit.
 */
export class IngestionPool<TEnvelope> {
  readonly #entries = new Map<string, PooledEntry<TEnvelope>>();
  readonly #maxSize: number;
  readonly #maxRewindCommits: number;

  constructor(options?: IngestionPoolOptions) {
    this.#maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.#maxRewindCommits =
      options?.maxRewindCommits ?? Number.POSITIVE_INFINITY;
  }

  /** Number of pooled entries. */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether an entry with this id is pooled. */
  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /**
   * Pools an envelope (keyed by id). A peeled Commit supplies its authenticated
   * source epoch. Capacity refusal is retryable and never evicts accepted work.
   */
  add(
    id: string,
    envelope: TEnvelope,
    sourceEpoch?: number,
  ): PoolAddResult {
    const existing = this.#entries.get(id);
    if (existing) {
      if (existing.sourceEpoch === undefined && sourceEpoch !== undefined)
        existing.sourceEpoch = sourceEpoch;
      return { kind: "accepted" };
    }
    if (this.#entries.size >= this.#maxSize)
      return { kind: "refused", reason: "capacity" };
    this.#entries.set(id, {
      id,
      envelope,
      sourceEpoch,
      triedTags: new Set(),
    });
    return { kind: "accepted" };
  }

  /** Removes an entry (it was read, or is being given up). */
  remove(id: string): void {
    this.#entries.delete(id);
  }

  /**
   * Clears every entry's tried-tag memo so the next tree sweep re-peels all
   * pooled events against all node states. Called after a convergence branch
   * switch: the canonical path changed, so a fork message previously held on a
   * losing branch may now decrypt on the canonical one and be delivered.
   */
  resetTried(): void {
    for (const entry of this.#entries.values()) entry.triedTags.clear();
  }

  /** The pooled envelopes, oldest-first. */
  envelopes(): TEnvelope[] {
    return [...this.#entries.values()].map((e) => e.envelope);
  }

  /** All pooled entries, oldest-first. */
  entries(): PooledEntry<TEnvelope>[] {
    return [...this.#entries.values()];
  }

  /**
   * Drops authenticated deferred commits only once their source epoch is
   * strictly beyond the rollback horizon. Opaque wrappers have no trustworthy
   * epoch and remain capacity-bounded until they authenticate or are removed.
   */
  evictStale(currentEpoch: number): PooledEntry<TEnvelope>[] {
    const evicted: PooledEntry<TEnvelope>[] = [];
    for (const entry of this.#entries.values()) {
      if (
        entry.sourceEpoch !== undefined &&
        currentEpoch - entry.sourceEpoch > this.#maxRewindCommits
      )
        evicted.push(entry);
    }
    for (const entry of evicted) this.#entries.delete(entry.id);
    return evicted;
  }

  /** Authenticated source epochs whose parent states remain active dependencies. */
  sourceEpochs(): number[] {
    return this.entries().flatMap((entry) =>
      entry.sourceEpoch === undefined ? [] : [entry.sourceEpoch],
    );
  }
}
