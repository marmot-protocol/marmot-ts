/** @module @category Storage */
import type {
  HistoryTreeStore,
  HistoryTreeWrite,
} from "../../../engine/history-tree-store.js";
import { applyGroupUpdate } from "./query.js";
import type {
  BackfillRow,
  DeliveryRow,
  EffectRow,
  GroupRecord,
  GroupRecordUpdate,
  GroupTransaction,
  MarmotGroupDatabase,
  MessageRow,
  WrapperRow,
} from "./types.js";

type Step = (tx: GroupTransaction) => Promise<void>;

/** Access to a group database's singleton {@link GroupRecord}. */
export interface GroupRecordStore {
  get(): Promise<GroupRecord>;
  /** Applies a partial update in one transaction (`null` deletes a field). */
  update(update: GroupRecordUpdate): Promise<void>;
}

/** {@link GroupRecordStore} over a group database; each update is one transaction. */
export function groupRecordStore(db: MarmotGroupDatabase): GroupRecordStore {
  return {
    get: () => db.group(),
    update: (update) => db.transaction((tx) => tx.updateGroup(update)),
  };
}

/** Applies a staged history-tree write inside a group transaction. */
export async function applyTreeWrite(
  tx: GroupTransaction,
  write: HistoryTreeWrite,
): Promise<void> {
  for (const tag of write.deletes) await tx.treeNodes.delete(tag);
  for (const node of write.puts.values()) await tx.treeNodes.put(node);
  if (write.checkpoint !== undefined)
    await tx.updateGroup({ checkpoint: write.checkpoint });
}

/** The {@link HistoryTreeStore} of one group database. */
export function groupTreeStore(db: MarmotGroupDatabase): HistoryTreeStore {
  return {
    checkpoint: async () => (await db.group()).checkpoint,
    node: (tag) => db.treeNodes.get(tag),
    commit: (write) => db.transaction((tx) => applyTreeWrite(tx, write)),
  };
}

/**
 * Collects writes for one atomic group transaction. Values are prepared
 * before the transaction opens; {@link getGroup} sees this batch's own
 * pending record updates first.
 */
export class GroupBatch {
  readonly #db: MarmotGroupDatabase;
  #update: GroupRecordUpdate = {};
  #steps: Step[] = [];

  constructor(db: MarmotGroupDatabase) {
    this.#db = db;
  }

  /** Whether the batch holds any writes. */
  get size(): number {
    return Object.keys(this.#update).length + this.#steps.length;
  }

  /** The group record with this batch's staged updates applied. */
  async getGroup(): Promise<GroupRecord> {
    return applyGroupUpdate(await this.#db.group(), this.#update);
  }

  /** Stages a partial group-record update (`null` deletes a field). */
  updateGroup(update: GroupRecordUpdate): void {
    const next: GroupRecordUpdate = { ...this.#update };
    for (const [key, value] of Object.entries(update))
      if (value !== undefined) (next as Record<string, unknown>)[key] = value;
    this.#update = next;
  }

  /** Stages a history-tree write. */
  tree(write: HistoryTreeWrite): void {
    if (write.checkpoint !== undefined)
      this.updateGroup({ checkpoint: write.checkpoint });
    if (write.puts.size || write.deletes.size)
      this.#steps.push((tx) =>
        applyTreeWrite(tx, { ...write, checkpoint: undefined }),
      );
  }

  putWrapper(row: WrapperRow): void {
    this.#steps.push((tx) => tx.wrappers.put(row));
  }

  deleteWrappersBelow(floor: number, except: readonly string[] = []): void {
    this.#steps.push((tx) => tx.wrappers.deleteBelow(floor, except));
  }

  putEffect(row: EffectRow): void {
    this.#steps.push((tx) => tx.effects.put(row));
  }

  deleteEffect(digest: string): void {
    this.#steps.push((tx) => tx.effects.delete(digest));
  }

  putBackfill(row: BackfillRow): void {
    this.#steps.push((tx) => tx.backfill.put(row));
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
    const update = this.#update;
    const steps = this.#steps;
    await this.#db.transaction(async (tx) => {
      if (Object.keys(update).length) await tx.updateGroup(update);
      for (const step of steps) await step(tx);
    });
    // Keep writes staged after a failed commit; drop only what committed.
    if (this.#update === update) this.#update = {};
    this.#steps = this.#steps.slice(steps.length);
  }
}
