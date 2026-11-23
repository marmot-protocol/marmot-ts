/**
 * IndexedDB adapter for {@link MarmotDatabase}: one IndexedDB database per
 * group plus one for the account, each transaction one native `readwrite`
 * transaction across every object store. Built on
 * [`idb`](https://github.com/jakearchibald/idb), so it uses the global
 * `indexedDB` (browsers, workers, or `fake-indexeddb/auto` in tests).
 *
 * Values are stored as given (plaintext). Wrap the browser storage with your
 * own encryption if the device threat model requires it.
 *
 * @module @category Storage
 */
import {
  deleteDB,
  openDB,
  type IDBPDatabase,
  type IDBPIndex,
  type IDBPObjectStore,
  type IDBPTransaction,
} from "idb";
import {
  applyGroupUpdate,
  compareMessages,
  indexTags,
  matchesMessageQuery as matches,
  queryTagKeys,
} from "../client/storage/database/query.js";
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
  MessageQuery,
  MessageRow,
  TreeNodeRow,
  WrapperRow,
} from "../client/storage/database/types.js";

/** Options for {@link indexedDBDatabase}. */
export interface IndexedDBDatabaseOptions {
  /** Database name prefix; defaults to `marmot`. Use one prefix per account. */
  prefix?: string;
}

const SCHEMA_VERSION = 2;
/** Key of the singleton group record in the `group` store. */
const GROUP_KEY = "group";
const GROUP_STORES = [
  "group",
  "treeNodes",
  "wrappers",
  "effects",
  "backfill",
  "messages",
  "deliveries",
];
const ACCOUNT_STORES = ["keyPackages", "invites", "groups", "intents"];

type Store = IDBPObjectStore<unknown, string[], string, IDBTransactionMode>;
type WriteTx = IDBPTransaction<unknown, string[], "readwrite">;
/** Resolves an object store, in a shared or a fresh transaction. */
type StoreSource = (name: string) => Store | Promise<Store>;

/**
 * Hidden, adapter-only fields kept on stored rows for indexing and stripped
 * on read: `_tags` holds a message's {@link indexTags} keys, `_evidence`
 * marks deliveries that hold evidence (a sparse index).
 */
const HIDDEN = ["_tags", "_evidence"] as const;

/** Removes adapter-only fields and absent optionals from a stored row. */
function clean<T>(row: unknown): T {
  if (!row || typeof row !== "object") return row as T;
  const copy = { ...(row as Record<string, unknown>) };
  for (const key of HIDDEN) delete copy[key];
  for (const key of Object.keys(copy))
    if (copy[key] === undefined) delete copy[key];
  return copy as T;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Drops every existing store; the schema is recreated from scratch. */
function reset(db: IDBPDatabase): void {
  for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
}

function upgradeGroup(db: IDBPDatabase): void {
  reset(db);
  db.createObjectStore("group");
  db.createObjectStore("treeNodes", { keyPath: "tag" });
  db.createObjectStore("wrappers", { keyPath: "id" }).createIndex(
    "epoch",
    "epoch",
  );
  db.createObjectStore("effects", { keyPath: "digest" }).createIndex(
    "state",
    "state",
  );
  db.createObjectStore("backfill", { keyPath: "relay" });
  const messages = db.createObjectStore("messages", { keyPath: "id" });
  messages.createIndex("createdAt", ["createdAt", "id"]);
  messages.createIndex("kind", ["kind", "createdAt", "id"]);
  messages.createIndex("pubkey", ["pubkey", "createdAt", "id"]);
  messages.createIndex("tags", "_tags", { multiEntry: true });
  const deliveries = db.createObjectStore("deliveries", { keyPath: "id" });
  deliveries.createIndex("rumorId", "rumorId");
  // Sparse: only rows holding evidence carry the indexed flag.
  deliveries.createIndex("evidence", "_evidence");
}

function upgradeAccount(db: IDBPDatabase): void {
  reset(db);
  db.createObjectStore("keyPackages", { keyPath: "ref" });
  const invites = db.createObjectStore("invites", { keyPath: "id" });
  invites.createIndex("state", "state");
  invites.createIndex("rumorId", "rumorId");
  db.createObjectStore("groups", { keyPath: "id" });
  db.createObjectStore("intents", { keyPath: "id" });
}

/** A lazily opened IndexedDB connection. */
class Connection {
  #db: Promise<IDBPDatabase> | undefined;
  #closed = false;

  constructor(
    readonly name: string,
    readonly stores: string[],
    readonly upgrade: (db: IDBPDatabase) => void,
  ) {}

  #open(): Promise<IDBPDatabase> {
    if (this.#closed) return Promise.reject(new Error("Database is closed"));
    return (this.#db ??= openDB(this.name, SCHEMA_VERSION, {
      upgrade: this.upgrade,
      // Another context deleting or upgrading the database closes this one.
      blocking: () => void this.close(),
    }));
  }

  /** One store in its own readonly transaction, for reads outside `write`. */
  read: StoreSource = async (name) =>
    (await this.#open()).transaction(name, "readonly").store;

  /** Runs `work` in one strict-durability readwrite transaction. */
  async write<T>(work: (tx: WriteTx) => Promise<T>): Promise<T> {
    const db = await this.#open();
    const tx = db.transaction(this.stores, "readwrite", {
      durability: "strict",
    });
    // Observed below; this only keeps an early abort from going unhandled.
    tx.done.catch(() => undefined);
    try {
      const result = await work(tx);
      await tx.done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    (await this.#db?.catch(() => undefined))?.close();
  }
}

/** Row helpers over a {@link StoreSource}. */
function rows(store: StoreSource) {
  return {
    get: async <T>(name: string, key: string) => {
      const row = await (await store(name)).get(key);
      return row === undefined ? undefined : clean<T>(row);
    },
    /** All rows of a store, or of an index when `index` is given. */
    all: async <T>(name: string, index?: string, key?: IDBValidKey) => {
      const source = await store(name);
      const found = index
        ? await source.index(index).getAll(key)
        : await source.getAll();
      return found.map((row) => clean<T>(row));
    },
  };
}

/** Put/delete for one store of a write transaction. */
function writer(tx: WriteTx, name: string) {
  return {
    put: async (row: object) => {
      await tx.objectStore(name).put(row);
    },
    delete: async (key: string) => {
      await tx.objectStore(name).delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Walks an index newest first over `range`, collecting matching rows. With a
 * limit, it stops once the limit is met and the timestamp has moved on, so
 * same-second ties are complete before the final sort.
 */
async function walk(
  index: IDBPIndex<unknown, string[], string, string, IDBTransactionMode>,
  range: IDBKeyRange,
  query: MessageQuery,
  out: Map<string, MessageRow>,
): Promise<void> {
  const found: MessageRow[] = [];
  for (
    let cursor = await index.openCursor(range, "prev");
    cursor;
    cursor = await cursor.continue()
  ) {
    const row = clean<MessageRow>(cursor.value);
    const last = found.at(-1);
    if (
      query.limit !== undefined &&
      found.length >= query.limit &&
      last &&
      row.createdAt < last.createdAt
    )
      break;
    if (matches(row, query)) found.push(row);
  }
  for (const row of found) out.set(row.id, row);
}

async function queryMessages(
  store: Store,
  query: MessageQuery,
): Promise<MessageRow[]> {
  const since = query.since ?? -Infinity;
  const until = query.until ?? Infinity;
  const out = new Map<string, MessageRow>();
  const keep = (row: unknown) => {
    if (row === undefined) return;
    const message = clean<MessageRow>(row);
    if (matches(message, query)) out.set(message.id, message);
  };
  const tagKeys = queryTagKeys(query);
  if (query.ids) {
    for (const row of await Promise.all(query.ids.map((id) => store.get(id))))
      keep(row);
  } else if (tagKeys.length) {
    // The first tag clause narrows candidates; the rest filter.
    const index = store.index("tags");
    const found = await Promise.all(
      tagKeys[0]!.map((key) => index.getAll(key)),
    );
    for (const row of found.flat()) keep(row);
  } else if (query.authors) {
    for (const pubkey of query.authors)
      await walk(
        store.index("pubkey"),
        IDBKeyRange.bound([pubkey, since], [pubkey, until, []]),
        query,
        out,
      );
  } else if (query.kinds) {
    for (const kind of query.kinds)
      await walk(
        store.index("kind"),
        IDBKeyRange.bound([kind, since], [kind, until, []]),
        query,
        out,
      );
  } else {
    await walk(
      store.index("createdAt"),
      IDBKeyRange.bound([since], [until, []]),
      query,
      out,
    );
  }
  const sorted = [...out.values()].sort(compareMessages);
  return query.limit === undefined ? sorted : sorted.slice(0, query.limit);
}

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

function groupReader(store: StoreSource): GroupReader {
  const { get, all } = rows(store);
  return {
    group: async () =>
      (await get<GroupRecord>("group", GROUP_KEY)) ?? ({} as GroupRecord),
    treeNodes: {
      all: () => all<TreeNodeRow>("treeNodes"),
      get: (tag) => get<TreeNodeRow>("treeNodes", tag),
    },
    wrappers: {
      all: () => all<WrapperRow>("wrappers"),
      get: (id) => get<WrapperRow>("wrappers", id),
    },
    effects: {
      all: () => all<EffectRow>("effects"),
      get: (digest) => get<EffectRow>("effects", digest),
      // Index order within one state is primary-key (digest) order.
      byState: (state) => all<EffectRow>("effects", "state", state),
    },
    backfill: {
      all: () => all<BackfillRow>("backfill"),
      get: (relay) => get<BackfillRow>("backfill", relay),
    },
    messages: {
      all: () => all<MessageRow>("messages"),
      get: (id) => get<MessageRow>("messages", id),
      query: async (query) => queryMessages(await store("messages"), query),
    },
    deliveries: {
      all: () => all<DeliveryRow>("deliveries"),
      byRumor: async (rumorId) =>
        (await all<DeliveryRow>("deliveries", "rumorId", rumorId)).sort(byId),
      countByRumor: async (rumorId) =>
        (await store("deliveries")).index("rumorId").count(rumorId),
      withEvidence: async () =>
        (await all<DeliveryRow>("deliveries", "evidence")).sort(byId),
    },
  };
}

function groupTransaction(tx: WriteTx): GroupTransaction {
  const reader = groupReader((name) => tx.objectStore(name));
  const w = (name: string) => writer(tx, name);
  return {
    ...reader,
    updateGroup: async (update) => {
      const store = tx.objectStore("group");
      const current = clean<GroupRecord>((await store.get(GROUP_KEY)) ?? {});
      await store.put(applyGroupUpdate(current, update), GROUP_KEY);
    },
    treeNodes: { ...reader.treeNodes, ...w("treeNodes") },
    wrappers: {
      ...reader.wrappers,
      ...w("wrappers"),
      deleteBelow: async (floor, except = []) => {
        const keep = new Set(except);
        const store = tx.objectStore("wrappers");
        const ids = await store
          .index("epoch")
          .getAllKeys(IDBKeyRange.upperBound(floor, true));
        await Promise.all(
          ids.flatMap((id) =>
            keep.has(id as string) ? [] : [store.delete(id)],
          ),
        );
      },
    },
    effects: { ...reader.effects, ...w("effects") },
    backfill: { ...reader.backfill, ...w("backfill") },
    messages: {
      ...reader.messages,
      ...w("messages"),
      put: (row) => w("messages").put({ ...row, _tags: indexTags(row.tags) }),
    },
    deliveries: {
      ...reader.deliveries,
      ...w("deliveries"),
      put: (row) =>
        w("deliveries").put(row.evidence ? { ...row, _evidence: 1 } : row),
    },
  };
}

function groupDatabase(connection: Connection): MarmotGroupDatabase {
  return {
    // Each read outside a transaction runs in its own readonly transaction.
    ...groupReader(connection.read),
    transaction: (fn) => connection.write((tx) => fn(groupTransaction(tx))),
    close: () => connection.close(),
  };
}

function groupDatabases(prefix: string): MarmotGroupDatabases {
  const open = new Map<string, Set<Connection>>();
  const name = (groupId: string) => `${prefix}:group:${groupId}`;
  return {
    async list() {
      if (typeof indexedDB.databases !== "function")
        throw new Error("IndexedDB database enumeration is not available");
      const start = name("");
      return (await indexedDB.databases())
        .flatMap(({ name }) =>
          name?.startsWith(start) ? [name.slice(start.length)] : [],
        )
        .sort();
    },
    async open(groupId) {
      const connection = new Connection(
        name(groupId),
        GROUP_STORES,
        upgradeGroup,
      );
      let set = open.get(groupId);
      if (!set) open.set(groupId, (set = new Set()));
      set.add(connection);
      return groupDatabase(connection);
    },
    async drop(groupId) {
      await Promise.all([...(open.get(groupId) ?? [])].map((c) => c.close()));
      open.delete(groupId);
      await deleteDB(name(groupId));
    },
  };
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

function accountReader(store: StoreSource): AccountReader {
  const { get, all } = rows(store);
  return {
    keyPackages: {
      get: (ref) => get<KeyPackageRow>("keyPackages", ref),
      all: () => all<KeyPackageRow>("keyPackages"),
    },
    invites: {
      all: () => all<InviteRow>("invites"),
      get: (id) => get<InviteRow>("invites", id),
      byState: async (state) =>
        (await all<InviteRow>("invites", "state", state)).sort(
          (a, b) => a.receivedAt - b.receivedAt || byId(a, b),
        ),
      byRumor: async (rumorId) => {
        const row = await (
          await store("invites")
        )
          .index("rumorId")
          .get(rumorId);
        return row === undefined ? undefined : clean<InviteRow>(row);
      },
    },
    groups: {
      get: (id) => get<GroupRow>("groups", id),
      all: () => all<GroupRow>("groups"),
    },
    intents: { all: () => all<IntentRow>("intents") },
  };
}

function accountTransaction(tx: WriteTx): AccountTransaction {
  const reader = accountReader((name) => tx.objectStore(name));
  return {
    keyPackages: { ...reader.keyPackages, ...writer(tx, "keyPackages") },
    invites: { ...reader.invites, ...writer(tx, "invites") },
    groups: { ...reader.groups, ...writer(tx, "groups") },
    intents: { ...reader.intents, ...writer(tx, "intents") },
  };
}

function accountDatabase(connection: Connection): MarmotAccountDatabase {
  return {
    ...accountReader(connection.read),
    transaction: (fn) => connection.write((tx) => fn(accountTransaction(tx))),
    close: () => connection.close(),
  };
}

/** A {@link MarmotDatabase} stored in the global IndexedDB (browsers, workers). */
export function indexedDBDatabase(
  options: IndexedDBDatabaseOptions = {},
): MarmotDatabase {
  if (!globalThis.indexedDB || !globalThis.IDBKeyRange)
    throw new Error("IndexedDB is not available");
  const prefix = options.prefix ?? "marmot";
  return {
    account: accountDatabase(
      new Connection(`${prefix}:account`, ACCOUNT_STORES, upgradeAccount),
    ),
    groups: groupDatabases(prefix),
  };
}
