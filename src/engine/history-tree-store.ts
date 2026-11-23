/** @module @category Engine */

/** Confirmation-time evidence for a commit this client authored. */
export interface PersistedOwnCommitStamp {
  /** Authenticated Marmot account identity of the committer. */
  committer: string;
  priority: "privileged" | "ordinary";
  /** Consumed proposal references (hex, sorted). */
  consumedProposalRefs: string[];
}

/** One persisted fork-history node. */
export interface PersistedTreeNode {
  tag: string;
  epoch: number;
  parentTag?: string;
  /** Producing commit digest (hex). */
  commitDigest?: string;
  senderLeafIndex?: number;
  /** Serialized `ClientState`. */
  snapshot: Uint8Array;
  /** Producing commit (MLS message bytes). */
  commit?: Uint8Array;
  ownCommitStamp?: PersistedOwnCommitStamp;
}

/** The persisted checkpoint naming a tree's retained members. */
export interface PersistedTreeCheckpoint {
  rootTag: string;
  members: string[];
  garbage: string[];
  receivers: Record<string, number[] | null>;
  /** Rewritten snapshots awaiting cleanup (serialized `ClientState`). */
  projections: Record<string, Uint8Array>;
  boundary?: {
    parentTag: string;
    epoch: number;
    digest: string;
    senderLeafIndex?: number;
  };
}

/**
 * Durable backing for one group's {@link GroupHistoryTree}: one checkpoint
 * plus one record per node.
 *
 * The tree never commits on its own inside a caller's save: it stages a
 * {@link HistoryTreeWrite} that the caller applies in the same transaction as
 * its other writes.
 */
export interface HistoryTreeStore {
  /** The persisted checkpoint, if any. */
  checkpoint(): Promise<PersistedTreeCheckpoint | undefined>;
  /** One node's persisted record, if any. */
  node(tag: string): Promise<PersistedTreeNode | undefined>;
  /** Applies a staged write atomically. */
  commit(write: HistoryTreeWrite): Promise<void>;
}

/** Tree writes staged for one atomic commit. */
export interface HistoryTreeWrite {
  /** New checkpoint, or `null` to delete it. */
  checkpoint?: PersistedTreeCheckpoint | null;
  /** Node records to write, by tag. */
  puts: Map<string, PersistedTreeNode>;
  /** Node tags to delete. */
  deletes: Set<string>;
}

/** An empty {@link HistoryTreeWrite}. */
export function emptyTreeWrite(): HistoryTreeWrite {
  return { puts: new Map(), deletes: new Set() };
}

/** Whether a staged write changes anything. */
export function isEmptyTreeWrite(write: HistoryTreeWrite): boolean {
  return (
    write.checkpoint === undefined && !write.puts.size && !write.deletes.size
  );
}
