/** @module @category Storage */
import {
  applyGroupUpdate,
  compareMessages,
  matchesMessageQuery,
} from "./query.js";
import type {
  AccountReader,
  AccountTransaction,
  BackfillRow,
  DeliveryRow,
  EffectRow,
  GroupReader,
  GroupRecord,
  GroupRow,
  GroupTransaction,
  IntentRow,
  InviteRow,
  KeyPackageRow,
  MarmotAccountDatabase,
  MarmotDatabase,
  MarmotGroupDatabase,
  MarmotGroupDatabases,
  MessageRow,
  TreeNodeRow,
  WrapperRow,
} from "./types.js";

type Tables = Record<string, Map<string, unknown>>;

/** Deep-copies a row so callers never share objects or buffers with the store. */
const copy = <T>(value: T): T => structuredClone(value);

/**
 * Serializes transactions and gives each one a copy-on-write view of the
 * committed tables, swapped in only when the callback succeeds.
 */
class MemoryStore {
  committed: Tables;
  #queue: Promise<unknown> = Promise.resolve();
  closed = false;

  constructor(readonly names: readonly string[]) {
    this.committed = MemoryStore.empty(names);
  }

  static empty(names: readonly string[]): Tables {
    return Object.fromEntries(names.map((name) => [name, new Map()]));
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
        return working[table]!;
      };
      const result = await fn(working, write);
      this.committed = working;
      return result;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }
}

const rows = <T>(tables: Tables, table: string): T[] =>
  [...tables[table]!.values()].map((row) => copy(row as T));
const get = <T>(tables: Tables, table: string, key: string): T | undefined => {
  const row = tables[table]!.get(key) as T | undefined;
  return row === undefined ? undefined : copy(row);
};
const byKey =
  <T>(key: (row: T) => string) =>
  (a: T, b: T) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

const GROUP_TABLES = [
  "group",
  "treeNodes",
  "wrappers",
  "effects",
  "backfill",
  "messages",
  "deliveries",
] as const;

function groupReader(tables: () => Tables): GroupReader {
  const deliveries = () => rows<DeliveryRow>(tables(), "deliveries");
  const byId = byKey<DeliveryRow>((row) => row.id);
  return {
    group: async () => get<GroupRecord>(tables(), "group", "group") ?? {},
    treeNodes: {
      all: async () =>
        rows<TreeNodeRow>(tables(), "treeNodes").sort(byKey((row) => row.tag)),
      get: async (tag) => get<TreeNodeRow>(tables(), "treeNodes", tag),
    },
    wrappers: {
      all: async () =>
        rows<WrapperRow>(tables(), "wrappers").sort(byKey((row) => row.id)),
      get: async (id) => get<WrapperRow>(tables(), "wrappers", id),
    },
    effects: {
      all: async () =>
        rows<EffectRow>(tables(), "effects").sort(byKey((row) => row.digest)),
      get: async (digest) => get<EffectRow>(tables(), "effects", digest),
      byState: async (state) =>
        rows<EffectRow>(tables(), "effects")
          .filter((row) => row.state === state)
          .sort(byKey((row) => row.digest)),
    },
    backfill: {
      all: async () =>
        rows<BackfillRow>(tables(), "backfill").sort(byKey((row) => row.relay)),
      get: async (relay) => get<BackfillRow>(tables(), "backfill", relay),
    },
    messages: {
      all: async () =>
        rows<MessageRow>(tables(), "messages").sort(byKey((row) => row.id)),
      get: async (id) => get<MessageRow>(tables(), "messages", id),
      query: async (query) => {
        const found = rows<MessageRow>(tables(), "messages")
          .filter((row) => matchesMessageQuery(row, query))
          .sort(compareMessages);
        return query.limit === undefined ? found : found.slice(0, query.limit);
      },
    },
    deliveries: {
      all: async () => deliveries().sort(byId),
      byRumor: async (rumorId) =>
        deliveries()
          .filter((row) => row.rumorId === rumorId)
          .sort(byId),
      countByRumor: async (rumorId) =>
        deliveries().filter((row) => row.rumorId === rumorId).length,
      withEvidence: async () =>
        deliveries()
          .filter((row) => row.evidence !== undefined)
          .sort(byId),
    },
  };
}

class MemoryGroupDatabase implements MarmotGroupDatabase {
  readonly group: GroupReader["group"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly effects: GroupReader["effects"];
  readonly backfill: GroupReader["backfill"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(readonly store: MemoryStore) {
    const reader = groupReader(() => store.committed);
    this.group = reader.group;
    this.treeNodes = reader.treeNodes;
    this.wrappers = reader.wrappers;
    this.effects = reader.effects;
    this.backfill = reader.backfill;
    this.messages = reader.messages;
    this.deliveries = reader.deliveries;
  }

  transaction<T>(fn: (tx: GroupTransaction) => Promise<T>): Promise<T> {
    return this.store.run((tables, write) => {
      const reader = groupReader(() => tables);
      const put = (table: string, key: string, row: unknown) => {
        write(table).set(key, copy(row));
      };
      const remove = (table: string, key: string) => {
        write(table).delete(key);
      };
      const tx: GroupTransaction = {
        ...reader,
        updateGroup: async (update) => {
          const current =
            (tables.group!.get("group") as GroupRecord | undefined) ?? {};
          put("group", "group", applyGroupUpdate(current, update));
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
        effects: {
          ...reader.effects,
          put: async (row) => put("effects", row.digest, row),
          delete: async (digest) => remove("effects", digest),
        },
        backfill: {
          ...reader.backfill,
          put: async (row) => put("backfill", row.relay, row),
          delete: async (relay) => remove("backfill", relay),
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
      store.committed = MemoryStore.empty(GROUP_TABLES);
    }
    this.#stores.delete(groupId);
  }

  /** Ids of groups that currently have a database (for tests). */
  ids(): string[] {
    return [...this.#stores.keys()];
  }

  async list(): Promise<string[]> {
    return this.ids().sort();
  }
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

const ACCOUNT_TABLES = ["keyPackages", "invites", "groups", "intents"] as const;

function accountReader(tables: () => Tables): AccountReader {
  const byId = byKey<{ id: string }>((row) => row.id);
  const invites = () => rows<InviteRow>(tables(), "invites");
  return {
    keyPackages: {
      get: async (ref) => get<KeyPackageRow>(tables(), "keyPackages", ref),
      all: async () =>
        rows<KeyPackageRow>(tables(), "keyPackages").sort(
          byKey((row) => row.ref),
        ),
    },
    invites: {
      all: async () => invites().sort(byId),
      get: async (id) => get<InviteRow>(tables(), "invites", id),
      byState: async (state) =>
        invites()
          .filter((row) => row.state === state)
          .sort((a, b) => a.receivedAt - b.receivedAt || byId(a, b)),
      byRumor: async (rumorId) =>
        invites().find((row) => row.rumorId === rumorId),
    },
    groups: {
      get: async (id) => get<GroupRow>(tables(), "groups", id),
      all: async () => rows<GroupRow>(tables(), "groups").sort(byId),
    },
    intents: {
      all: async () => rows<IntentRow>(tables(), "intents").sort(byId),
    },
  };
}

/** In-memory {@link MarmotAccountDatabase}. Not durable. */
export class MemoryAccountDatabase implements MarmotAccountDatabase {
  /** @internal */
  readonly store = new MemoryStore(ACCOUNT_TABLES);
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor() {
    const reader = accountReader(() => this.store.committed);
    this.keyPackages = reader.keyPackages;
    this.invites = reader.invites;
    this.groups = reader.groups;
    this.intents = reader.intents;
  }

  transaction<T>(fn: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    return this.store.run((tables, write) => {
      const reader = accountReader(() => tables);
      const put = (table: string, key: string, row: unknown) => {
        write(table).set(key, copy(row));
      };
      const remove = (table: string, key: string) => {
        write(table).delete(key);
      };
      const tx: AccountTransaction = {
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
