import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts/utils";

/**
 * Wraps a single {@link GenericKeyValueStore} so a caller sees only the keys
 * under a fixed `prefix`. Used to give each group its own logical keyspace
 * inside one shared `messages` table: the rumor-history backend for a group is
 * handed a `PrefixedKeyValueStore` scoped to `${groupHex}:`, and never sees (or
 * can clear) another group's rumors.
 */
export class PrefixedKeyValueStore<T> implements GenericKeyValueStore<T> {
  readonly #inner: GenericKeyValueStore<T>;
  readonly #prefix: string;

  constructor(inner: GenericKeyValueStore<T>, prefix: string) {
    this.#inner = inner;
    this.#prefix = prefix;
  }

  getItem(key: string): Promise<T | null> {
    return this.#inner.getItem(this.#prefix + key);
  }

  setItem(key: string, value: T): Promise<T> {
    return this.#inner.setItem(this.#prefix + key, value);
  }

  removeItem(key: string): Promise<void> {
    return this.#inner.removeItem(this.#prefix + key);
  }

  async clear(): Promise<void> {
    for (const key of await this.keys()) await this.removeItem(key);
  }

  async keys(): Promise<string[]> {
    const all = await this.#inner.keys();
    return all
      .filter((key) => key.startsWith(this.#prefix))
      .map((key) => key.slice(this.#prefix.length));
  }
}
