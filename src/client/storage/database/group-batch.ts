/** @module @category Storage */
import type {
  HistoryTreeStore,
  HistoryTreeWrite,
} from "../../../engine/history-tree-store.js";
import type {
  DeliveryRow,
  GroupMetaKey,
  GroupTransaction,
  MarmotGroupDatabase,
  MessageRow,
  WrapperRow,
} from "./types.js";

type Step = (tx: GroupTransaction) => Promise<void>;

/** Single-record access to a group database's `meta` table. */
export interface GroupMetaStore {
  get(key: GroupMetaKey): Promise<Uint8Array | undefined>;
  set(key: GroupMetaKey, value: Uint8Array): Promise<void>;
  delete(key: GroupMetaKey): Promise<void>;
}

/** {@link GroupMetaStore} over a group database; each write is one transaction. */
export function groupMetaStore(db: MarmotGroupDatabase): GroupMetaStore {
  return {
    get: (key) => db.meta.get(key),
    set: (key, value) => db.transaction((tx) => tx.meta.set(key, value)),
    delete: (key) => db.transaction((tx) => tx.meta.delete(key)),
  };
}

/** Applies a staged history-tree write inside a group transaction. */
export async function applyTreeWrite(
  tx: GroupTransaction,
  write: HistoryTreeWrite,
): Promise<void> {
  for (const tag of write.deletes) await tx.treeNodes.delete(tag);
  for (const [tag, value] of write.puts) await tx.treeNodes.put({ tag, value });
  if (write.meta === null) await tx.meta.delete("tree");
  else if (write.meta) await tx.meta.set("tree", write.meta);
}

/** The {@link HistoryTreeStore} of one group database. */
export function groupTreeStore(db: MarmotGroupDatabase): HistoryTreeStore {
  return {
    meta: () => db.meta.get("tree"),
    node: async (tag) => (await db.treeNodes.get(tag))?.value,
    commit: (write) => db.transaction((tx) => applyTreeWrite(tx, write)),
  };
}

/**
 * Collects writes for one atomic group transaction. Values are prepared
 * before the transaction opens; reads of `meta` see this batch's own pending
 * writes first.
 */
export class GroupBatch {
  readonly #db: MarmotGroupDatabase;
  readonly #meta = new Map<GroupMetaKey, Uint8Array | null>();
  #steps: Step[] = [];

  constructor(db: MarmotGroupDatabase) {
    this.#db = db;
  }

  /** Whether the batch holds any writes. */
  get size(): number {
    return this.#meta.size + this.#steps.length;
  }

  async getMeta(key: GroupMetaKey): Promise<Uint8Array | undefined> {
    if (this.#meta.has(key)) return this.#meta.get(key) ?? undefined;
    return this.#db.meta.get(key);
  }

  setMeta(key: GroupMetaKey, value: Uint8Array): void {
    this.#meta.set(key, value);
  }

  deleteMeta(key: GroupMetaKey): void {
    this.#meta.set(key, null);
  }

  /** Stages a history-tree write. */
  tree(write: HistoryTreeWrite): void {
    if (write.meta !== undefined) {
      if (write.meta === null) this.deleteMeta("tree");
      else this.setMeta("tree", write.meta);
    }
    if (write.puts.size || write.deletes.size)
      this.#steps.push((tx) =>
        applyTreeWrite(tx, { ...write, meta: undefined }),
      );
  }

  putWrapper(row: WrapperRow): void {
    this.#steps.push((tx) => tx.wrappers.put(row));
  }

  deleteWrappersBelow(floor: number, except: readonly string[] = []): void {
    this.#steps.push((tx) => tx.wrappers.deleteBelow(floor, except));
  }

  putMessage(row: MessageRow): void {
    this.#steps.push((tx) => tx.messages.put(row));
  }

  putDelivery(row: DeliveryRow): void {
    this.#steps.push((tx) => tx.deliveries.put(row));
  }

  deleteDelivery(id: string): void {
    this.#steps.push((tx) => tx.deliveries.delete(id));
  }

  /**
   * Stages a step that runs inside the transaction after the earlier steps.
   * It may only await the transaction's methods.
   */
  then(step: Step): void {
    this.#steps.push(step);
  }

  /** Commits every staged write atomically; a no-op when empty. */
  async commit(): Promise<void> {
    if (!this.size) return;
    const meta = [...this.#meta];
    const steps = this.#steps;
    await this.#db.transaction(async (tx) => {
      for (const [key, value] of meta)
        if (value === null) await tx.meta.delete(key);
        else await tx.meta.set(key, value);
      for (const step of steps) await step(tx);
    });
    // Keep writes staged after a failed commit; drop only what committed.
    for (const [key, value] of meta)
      if (this.#meta.get(key) === value) this.#meta.delete(key);
    this.#steps = this.#steps.slice(steps.length);
  }
}
