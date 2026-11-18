/** @module @category Storage */

/** One write inside an atomic {@link MarmotStorage.batch}. */
export type StorageOp =
  | { type: "set"; key: string; value: Uint8Array }
  | { type: "delete"; key: string };

/**
 * The only storage interface a Marmot client needs for protocol state.
 *
 * Values are opaque bytes; the library owns every key and record format.
 * Adapter requirements:
 * - `set`, `delete` and `batch` resolve only once the change is durable.
 * - `batch` is all-or-nothing: after a crash either every op is visible or none is.
 * - `list(prefix)` returns every key starting with `prefix`, sorted.
 * - Values include MLS secrets and private key material: encrypt at rest.
 *
 * One storage holds one account. Give each account its own storage (or prefix
 * keys in the adapter), and run one client per storage at a time.
 */
export interface MarmotStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, sorted ascending. */
  list(prefix: string): Promise<string[]>;
  /** Apply every op atomically, in order. */
  batch(ops: readonly StorageOp[]): Promise<void>;
}

/**
 * In-memory {@link MarmotStorage}. Not durable: intended for tests, demos and
 * ephemeral clients. Values are copied on write and read.
 */
export class MemoryStorage implements MarmotStorage {
  readonly data = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.data.get(key);
    return value && value.slice();
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.data.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async batch(ops: readonly StorageOp[]): Promise<void> {
    for (const op of ops)
      if (op.type === "set") this.data.set(op.key, op.value.slice());
      else this.data.delete(op.key);
  }
}

/** Creates a fresh in-memory {@link MarmotStorage} (tests and demos only). */
export function memoryStorage(): MemoryStorage {
  return new MemoryStorage();
}

/** A view of `storage` where every key is relative to `prefix`. */
export function scopeStorage(
  storage: MarmotStorage,
  prefix: string,
): MarmotStorage {
  if (!prefix) return storage;
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    list: async (sub) =>
      (await storage.list(prefix + sub)).map((key) => key.slice(prefix.length)),
    batch: (ops) =>
      storage.batch(ops.map((op) => ({ ...op, key: prefix + op.key }))),
  };
}

/** Deletes every key starting with `prefix` in one atomic batch. */
export async function deletePrefix(
  storage: MarmotStorage,
  prefix: string,
): Promise<void> {
  const keys = await storage.list(prefix);
  if (keys.length)
    await storage.batch(keys.map((key) => ({ type: "delete", key })));
}

/**
 * Collects writes for one atomic {@link MarmotStorage.batch}. Reads see the
 * batch's own pending writes first, then the underlying storage.
 */
export class StorageBatch {
  readonly #storage: MarmotStorage;
  readonly #ops = new Map<string, StorageOp>();

  constructor(storage: MarmotStorage) {
    this.#storage = storage;
  }

  get size(): number {
    return this.#ops.size;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const op = this.#ops.get(key);
    if (op) return op.type === "set" ? op.value : undefined;
    return this.#storage.get(key);
  }

  set(key: string, value: Uint8Array): void {
    this.#ops.delete(key);
    this.#ops.set(key, { type: "set", key, value });
  }

  delete(key: string): void {
    this.#ops.delete(key);
    this.#ops.set(key, { type: "delete", key });
  }

  /** Commits every collected op atomically; a no-op when empty. */
  async commit(): Promise<void> {
    if (!this.#ops.size) return;
    const ops = [...this.#ops.values()];
    await this.#storage.batch(ops);
    // Keep ops queued after a failed commit; drop only what was committed.
    for (const op of ops)
      if (this.#ops.get(op.key) === op) this.#ops.delete(op.key);
  }
}
