import type { GenericKeyValueStore } from "../utils/key-value.js";

/**
 * A simple in-memory implementation of {@link GenericKeyValueStore}.
 *
 * Data lives only for the lifetime of the process / page — nothing is written
 * to disk. Useful as a default ephemeral backend when persistence is not
 * required or as a drop-in for testing.
 */
export class InMemoryKeyValueStore<T> implements GenericKeyValueStore<T> {
  private readonly store = new Map<string, T>();

  async getItem(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: T): Promise<T> {
    this.store.set(key, value);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}
