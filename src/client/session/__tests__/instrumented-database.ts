import { memoryGroupDatabase } from "../../../__tests__/helpers/database.js";
import type {
  GroupMetaKey,
  GroupTransaction,
  MarmotGroupDatabase,
} from "../../storage/database/types.js";

/**
 * One write a group transaction performs. Keys are table-qualified:
 * `meta:<key>`, `tree:<tag>`, `wrapper:<id>` (or `wrapper:<<floor>` for a
 * compaction), `message:<id>`, `delivery:<id>`.
 */
export type WriteOp = {
  type: "set" | "delete";
  key: string;
  value?: Uint8Array;
};

/**
 * An in-memory group database whose reads and writes can be observed, gated
 * or failed, for tests that used to wrap a key-value store.
 */
export function instrumentedDatabase(base = memoryGroupDatabase()) {
  /** Called before each write is applied inside a transaction. */
  let onWrite: ((op: WriteOp) => Promise<void> | void) | undefined;
  /** Called after each meta read (inside or outside a transaction). */
  let onRead: ((key: string) => Promise<void> | void) | undefined;
  /** Called after a transaction commits; throwing simulates a lost ack. */
  let onCommit: ((ops: readonly WriteOp[]) => Promise<void> | void) | undefined;
  /** Every write applied by a committed transaction, in order. */
  const writes: WriteOp[] = [];

  const write = async (op: WriteOp, apply: () => Promise<void>) => {
    await onWrite?.(op);
    await apply();
    pending?.push(op);
  };
  let pending: WriteOp[] | undefined;

  const readMeta =
    (get: (key: GroupMetaKey) => Promise<Uint8Array | undefined>) =>
    async (key: GroupMetaKey) => {
      const value = await get(key);
      await onRead?.(`meta:${key}`);
      return value;
    };

  const wrap = (tx: GroupTransaction): GroupTransaction => ({
    ...tx,
    meta: {
      ...tx.meta,
      get: readMeta(tx.meta.get),
      set: (key, value) =>
        write({ type: "set", key: `meta:${key}`, value }, () =>
          tx.meta.set(key, value),
        ),
      delete: (key) =>
        write({ type: "delete", key: `meta:${key}` }, () =>
          tx.meta.delete(key),
        ),
    },
    treeNodes: {
      ...tx.treeNodes,
      put: (row) =>
        write({ type: "set", key: `tree:${row.tag}`, value: row.value }, () =>
          tx.treeNodes.put(row),
        ),
      delete: (tag) =>
        write({ type: "delete", key: `tree:${tag}` }, () =>
          tx.treeNodes.delete(tag),
        ),
    },
    wrappers: {
      ...tx.wrappers,
      put: (row) =>
        write({ type: "set", key: `wrapper:${row.id}`, value: row.value }, () =>
          tx.wrappers.put(row),
        ),
      deleteBelow: (floor, except) =>
        write({ type: "delete", key: `wrapper:<${floor}` }, () =>
          tx.wrappers.deleteBelow(floor, except),
        ),
    },
    messages: {
      ...tx.messages,
      put: (row) =>
        write({ type: "set", key: `message:${row.id}`, value: row.value }, () =>
          tx.messages.put(row),
        ),
      delete: (id) =>
        write({ type: "delete", key: `message:${id}` }, () =>
          tx.messages.delete(id),
        ),
    },
    deliveries: {
      ...tx.deliveries,
      put: (row) =>
        write(
          { type: "set", key: `delivery:${row.id}`, value: row.value },
          () => tx.deliveries.put(row),
        ),
      delete: (id) =>
        write({ type: "delete", key: `delivery:${id}` }, () =>
          tx.deliveries.delete(id),
        ),
    },
  });

  const db: MarmotGroupDatabase = {
    meta: { get: readMeta((key) => base.meta.get(key)) },
    treeNodes: base.treeNodes,
    wrappers: base.wrappers,
    messages: base.messages,
    deliveries: base.deliveries,
    transaction: async (fn) => {
      const ops: WriteOp[] = [];
      const result = await base.transaction(async (tx) => {
        pending = ops;
        try {
          return await fn(wrap(tx));
        } finally {
          pending = undefined;
        }
      });
      writes.push(...ops);
      await onCommit?.(ops);
      return result;
    },
    close: () => base.close(),
  };

  return {
    db,
    base,
    writes,
    /** Observes, gates or fails each write before it is applied. */
    onWrite(handler: typeof onWrite) {
      onWrite = handler;
    },
    /** Observes, gates or fails (after commit) each committed transaction. */
    onCommit(handler: typeof onCommit) {
      onCommit = handler;
    },
    /** Observes or gates each meta read after it resolves. */
    onRead(handler: typeof onRead) {
      onRead = handler;
    },
    /** Seeds a meta record outside the instrumentation. */
    async seed(key: GroupMetaKey, value: Uint8Array) {
      await base.transaction((tx) => tx.meta.set(key, value));
    },
    /** Every stored record, as table-qualified keys. */
    keys(): string[] {
      const tables = (
        base as unknown as {
          store: { committed: Record<string, Map<string, unknown>> };
        }
      ).store.committed;
      const prefix: Record<string, string> = {
        meta: "meta",
        treeNodes: "tree",
        wrappers: "wrapper",
        messages: "message",
        deliveries: "delivery",
      };
      return Object.entries(tables)
        .flatMap(([table, rows]) =>
          [...rows.keys()].map((key) => `${prefix[table]}:${key}`),
        )
        .sort();
    },
  };
}
