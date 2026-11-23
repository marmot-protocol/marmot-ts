/** @module @category Storage */
import type {
  AccountReader,
  AccountTransaction,
  DeliveryRow,
  GroupMetaKey,
  GroupReader,
  GroupRow,
  GroupTransaction,
  IntentRow,
  InviteRow,
  KeyPackageRow,
  MarmotAccountDatabase,
  MarmotDatabase,
  MarmotGroupDatabase,
  MarmotGroupDatabases,
  MessageQuery,
  MessageRow,
  TreeNodeRow,
  WrapperRow,
} from "./types.js";

type Tables = Record<string, Map<string, unknown>>;

/** Copies byte fields so callers never share buffers with the store. */
function copyRow<T>(row: T): T {
  if (row instanceof Uint8Array) return row.slice() as T;
  if (!row || typeof row !== "object") return row;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    copy[key] =
      value instanceof Uint8Array
        ? value.slice()
        : Array.isArray(value)
          ? [...value]
          : value;
  }
  return copy as T;
}

/** Newest first, then id ascending. */
export function compareMessages(a: MessageRow, b: MessageRow): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether a message row satisfies a {@link MessageQuery} (ignoring `limit`). */
export function matchesMessageQuery(
  row: MessageRow,
  query: MessageQuery,
): boolean {
  if (query.ids && !query.ids.includes(row.id)) return false;
  if (query.kinds && !query.kinds.includes(row.kind)) return false;
  if (query.authors && !query.authors.includes(row.pubkey)) return false;
  if (query.since !== undefined && row.createdAt < query.since) return false;
  if (query.until !== undefined && row.createdAt > query.until) return false;
  if (query.tags)
    for (const alternatives of query.tags)
      if (!alternatives.some((tag) => row.tags.includes(tag))) return false;
  return true;
}

/**
 * Serializes transactions and gives each one a copy-on-write view of the
 * committed tables, swapped in only when the callback succeeds.
 */
class MemoryStore {
  committed: Tables;
  #queue: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(names: readonly string[]) {
    this.committed = Object.fromEntries(names.map((name) => [name, new Map()]));
  }

  read<T>(table: string, key: string): T | undefined {
    const row = this.committed[table].get(key) as T | undefined;
    return row === undefined ? undefined : copyRow(row);
  }

  rows<T>(tables: Tables, table: string): T[] {
    return [...tables[table].values()].map((row) => copyRow(row as T));
  }

  run<T>(
    fn: (
      tables: Tables,
      write: (table: string) => Map<string, unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    const task = this.#queue.then(async () => {
      if (this.closed) throw new Error("Database is closed");
      const working: Tables = { ...this.committed };
      const copied = new Set<string>();
      const write = (table: string) => {
        if (!copied.has(table)) {
          working[table] = new Map(working[table]);
          copied.add(table);
        }
        return working[table];
      };
      const result = await fn(working, write);
      this.committed = working;
      return result;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }
}

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

const GROUP_TABLES = [
  "meta",
  "treeNodes",
  "wrappers",
  "messages",
  "deliveries",
] as const;

function groupReader(store: MemoryStore, tables: () => Tables): GroupReader {
  const get = <T>(table: string, key: string): T | undefined => {
    const row = tables()[table].get(key) as T | undefined;
    return row === undefined ? undefined : copyRow(row);
  };
  const deliveries = () => store.rows<DeliveryRow>(tables(), "deliveries");
  return {
    meta: {
      get: async (key: GroupMetaKey) => get<Uint8Array>("meta", key),
    },
    treeNodes: { get: async (tag) => get<TreeNodeRow>("treeNodes", tag) },
    wrappers: { get: async (id) => get<WrapperRow>("wrappers", id) },
    messages: {
      get: async (id) => get<MessageRow>("messages", id),
      query: async (query) => {
        const rows = store
          .rows<MessageRow>(tables(), "messages")
          .filter((row) => matchesMessageQuery(row, query))
          .sort(compareMessages);
        return query.limit === undefined ? rows : rows.slice(0, query.limit);
      },
    },
    deliveries: {
      byRumor: async (rumorId) =>
        deliveries()
          .filter((row) => row.rumorId === rumorId)
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      countByRumor: async (rumorId) =>
        deliveries().filter((row) => row.rumorId === rumorId).length,
      withEvidence: async () =>
        deliveries()
          .filter((row) => row.evidence !== undefined)
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
    },
  };
}

class MemoryGroupDatabase implements MarmotGroupDatabase {
  readonly meta: GroupReader["meta"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(readonly store: MemoryStore) {
    const reader = groupReader(store, () => store.committed);
    this.meta = reader.meta;
    this.treeNodes = reader.treeNodes;
    this.wrappers = reader.wrappers;
    this.messages = reader.messages;
    this.deliveries = reader.deliveries;
  }

  transaction<T>(fn: (tx: GroupTransaction) => Promise<T>): Promise<T> {
    return this.store.run((tables, write) => {
      const reader = groupReader(this.store, () => tables);
      const put = (table: string, key: string, row: unknown) => {
        write(table).set(key, copyRow(row));
      };
      const remove = (table: string, key: string) => {
        write(table).delete(key);
      };
      const tx: GroupTransaction = {
        meta: {
          ...reader.meta,
          set: async (key, value) => put("meta", key, value),
          delete: async (key) => remove("meta", key),
        },
        treeNodes: {
          ...reader.treeNodes,
          put: async (row) => put("treeNodes", row.tag, row),
          delete: async (tag) => remove("treeNodes", tag),
        },
        wrappers: {
          ...reader.wrappers,
          put: async (row) => put("wrappers", row.id, row),
          deleteBelow: async (floor, except = []) => {
            const keep = new Set(except);
            const table = write("wrappers");
            for (const [id, row] of table)
              if ((row as WrapperRow).epoch < floor && !keep.has(id))
                table.delete(id);
          },
        },
        messages: {
          ...reader.messages,
          put: async (row) => put("messages", row.id, row),
          delete: async (id) => remove("messages", id),
        },
        deliveries: {
          ...reader.deliveries,
          put: async (row) => put("deliveries", row.id, row),
          delete: async (id) => remove("deliveries", id),
        },
      };
      return fn(tx);
    });
  }

  async close(): Promise<void> {}
}

/** A standalone in-memory {@link MarmotGroupDatabase} (tests and demos). */
export function memoryGroupDatabase(): MarmotGroupDatabase {
  return new MemoryGroupDatabase(new MemoryStore(GROUP_TABLES));
}

/** In-memory {@link MarmotGroupDatabases}. Not durable. */
export class MemoryGroupDatabases implements MarmotGroupDatabases {
  readonly #stores = new Map<string, MemoryStore>();

  async open(groupId: string): Promise<MarmotGroupDatabase> {
    let store = this.#stores.get(groupId);
    if (!store) {
      store = new MemoryStore(GROUP_TABLES);
      this.#stores.set(groupId, store);
    }
    return new MemoryGroupDatabase(store);
  }

  async drop(groupId: string): Promise<void> {
    const store = this.#stores.get(groupId);
    if (store) {
      // Handles still open on a dropped database see it empty and read-only.
      store.closed = true;
      store.committed = Object.fromEntries(
        GROUP_TABLES.map((name) => [name, new Map()]),
      );
    }
    this.#stores.delete(groupId);
  }

  /** Ids of groups that currently have a database (for tests). */
  ids(): string[] {
    return [...this.#stores.keys()];
  }
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

const ACCOUNT_TABLES = [
  "meta",
  "keyPackages",
  "invites",
  "groups",
  "intents",
] as const;

const byId = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function accountReader(
  store: MemoryStore,
  tables: () => Tables,
): AccountReader {
  const get = <T>(table: string, key: string): T | undefined => {
    const row = tables()[table].get(key) as T | undefined;
    return row === undefined ? undefined : copyRow(row);
  };
  const invites = () => store.rows<InviteRow>(tables(), "invites");
  return {
    meta: { get: async (key) => get<Uint8Array>("meta", key) },
    keyPackages: {
      get: async (ref) => get<KeyPackageRow>("keyPackages", ref),
      all: async () =>
        store
          .rows<KeyPackageRow>(tables(), "keyPackages")
          .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    },
    invites: {
      get: async (id) => get<InviteRow>("invites", id),
      byState: async (state) =>
        invites()
          .filter((row) => row.state === state)
          .sort((a, b) => a.receivedAt - b.receivedAt || byId(a, b)),
      byRumor: async (rumorId) =>
        invites().find((row) => row.rumorId === rumorId),
    },
    groups: {
      get: async (id) => get<GroupRow>("groups", id),
      all: async () => store.rows<GroupRow>(tables(), "groups").sort(byId),
    },
    intents: {
      all: async () => store.rows<IntentRow>(tables(), "intents").sort(byId),
    },
  };
}

/** In-memory {@link MarmotAccountDatabase}. Not durable. */
export class MemoryAccountDatabase implements MarmotAccountDatabase {
  /** @internal */
  readonly store = new MemoryStore(ACCOUNT_TABLES);
  readonly meta: AccountReader["meta"];
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor() {
    const reader = accountReader(this.store, () => this.store.committed);
    this.meta = reader.meta;
    this.keyPackages = reader.keyPackages;
    this.invites = reader.invites;
    this.groups = reader.groups;
    this.intents = reader.intents;
  }

  transaction<T>(fn: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    return this.store.run((tables, write) => {
      const reader = accountReader(this.store, () => tables);
      const put = (table: string, key: string, row: unknown) => {
        write(table).set(key, copyRow(row));
      };
      const remove = (table: string, key: string) => {
        write(table).delete(key);
      };
      const tx: AccountTransaction = {
        meta: {
          ...reader.meta,
          set: async (key, value) => put("meta", key, value),
          delete: async (key) => remove("meta", key),
        },
        keyPackages: {
          ...reader.keyPackages,
          put: async (row) => put("keyPackages", row.ref, row),
          delete: async (ref) => remove("keyPackages", ref),
        },
        invites: {
          ...reader.invites,
          put: async (row) => put("invites", row.id, row),
          delete: async (id) => remove("invites", id),
        },
        groups: {
          ...reader.groups,
          put: async (row) => put("groups", row.id, row),
          delete: async (id) => remove("groups", id),
        },
        intents: {
          ...reader.intents,
          put: async (row) => put("intents", row.id, row),
          delete: async (id) => remove("intents", id),
        },
      };
      return fn(tx);
    });
  }

  async close(): Promise<void> {}
}

/** A fresh in-memory {@link MarmotDatabase} (tests, demos, ephemeral clients). */
export function memoryDatabase(): MarmotDatabase & {
  account: MemoryAccountDatabase;
  groups: MemoryGroupDatabases;
} {
  return {
    account: new MemoryAccountDatabase(),
    groups: new MemoryGroupDatabases(),
  };
}
