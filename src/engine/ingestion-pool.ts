/** @module @category Engine */

/** One pooled envelope awaiting a retained state that can decrypt it. */
export interface PooledEntry<TEnvelope> {
  /** Stable transport id (kind-445 event id) — the pool key. */
  id: string;
  /** The raw undecryptable envelope. */
  envelope: TEnvelope;
  /** The canonical tip epoch when the envelope was first pooled. */
  arrivalEpoch: number;
  /**
   * History-tree node tags this entry has already been peeled against without
   * success, so the tree-targeted sweep tries each `(event, node)` pair once.
   */
  triedTags: Set<string>;
}

/** Tuning for {@link IngestionPool}. */
export interface IngestionPoolOptions {
  /** Max entries; the oldest is evicted when the pool overflows. */
  maxSize?: number;
  /**
   * Max epochs an entry may linger: it is dropped once the canonical tip has
   * advanced more than this many epochs past the entry's arrival without the
   * entry becoming decryptable. Bounds undecryptable garbage.
   */
  maxEpochAge?: number;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_MAX_EPOCH_AGE = 256;

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
  readonly #maxEpochAge: number;

  constructor(options?: IngestionPoolOptions) {
    this.#maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.#maxEpochAge = options?.maxEpochAge ?? DEFAULT_MAX_EPOCH_AGE;
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
   * Pools an envelope (keyed by id). A re-pooled entry keeps its original
   * `arrivalEpoch` so eviction ages from first sighting. Evicts the oldest entry
   * when over `maxSize`.
   */
  add(id: string, envelope: TEnvelope, arrivalEpoch: number): void {
    const existing = this.#entries.get(id);
    if (existing) return; // keep original arrival epoch + tried-tag memo
    this.#entries.set(id, {
      id,
      envelope,
      arrivalEpoch,
      triedTags: new Set(),
    });
    if (this.#entries.size > this.#maxSize) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
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
   * Drops and returns entries the tip has aged past `maxEpochAge` without
   * resolving — they are unlikely to ever decrypt (foreign/garbage or an
   * unreachably-far-future epoch), so they become terminally unreadable.
   */
  evictStale(currentEpoch: number): PooledEntry<TEnvelope>[] {
    const evicted: PooledEntry<TEnvelope>[] = [];
    for (const entry of this.#entries.values()) {
      if (currentEpoch - entry.arrivalEpoch > this.#maxEpochAge)
        evicted.push(entry);
    }
    for (const entry of evicted) this.#entries.delete(entry.id);
    return evicted;
  }
}
