/** @module @category Utilities */

/**
 * A generic interface for a key-value store
 */
export interface GenericKeyValueStore<T> {
  /** Get an item from the store */
  getItem(key: string): Promise<T | null>;
  /** Set an item in the store */
  setItem(key: string, value: T): Promise<T>;
  /** Remove an item from the store */
  removeItem(key: string): Promise<void>;
  /** Clear all items from the store */
  clear(): Promise<void>;
  /** Get all keys in the store */
  keys(): Promise<string[]>;
}

/** @deprecated Use {@link GenericKeyValueStore} instead */
export type KeyValueStoreBackend<I> = GenericKeyValueStore<I>;
