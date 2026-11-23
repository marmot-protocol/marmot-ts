/** @module @category Engine */

/**
 * Durable backing for one group's {@link GroupHistoryTree}. Values are
 * tree-encoded bytes: one checkpoint record plus one record per node.
 *
 * The tree never commits on its own inside a caller's save: it stages a
 * {@link HistoryTreeWrite} that the caller applies in the same transaction as
 * its other writes.
 */
export interface HistoryTreeStore {
  /** The persisted checkpoint record, if any. */
  meta(): Promise<Uint8Array | undefined>;
  /** One node's persisted record, if any. */
  node(tag: string): Promise<Uint8Array | undefined>;
  /** Applies a staged write atomically. */
  commit(write: HistoryTreeWrite): Promise<void>;
}

/** Tree writes staged for one atomic commit. */
export interface HistoryTreeWrite {
  /** New checkpoint record, or `null` to delete it. */
  meta?: Uint8Array | null;
  /** Node records to write, by tag. */
  puts: Map<string, Uint8Array>;
  /** Node tags to delete. */
  deletes: Set<string>;
}

/** An empty {@link HistoryTreeWrite}. */
export function emptyTreeWrite(): HistoryTreeWrite {
  return { puts: new Map(), deletes: new Set() };
}

/** Whether a staged write changes anything. */
export function isEmptyTreeWrite(write: HistoryTreeWrite): boolean {
  return write.meta === undefined && !write.puts.size && !write.deletes.size;
}
