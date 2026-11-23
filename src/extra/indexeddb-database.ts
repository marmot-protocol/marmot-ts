/**
 * IndexedDB adapter for {@link MarmotDatabase}: one IndexedDB database per
 * group plus one for the account, each transaction one native `readwrite`
 * transaction across every object store.
 *
 * Values are stored as given (plaintext). Wrap the browser storage with your
 * own encryption if the device threat model requires it.
 *
 * @module @category Storage
 */
import type {
  AccountReader,
  AccountTransaction,
  DeliveryRow,
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
} from "../client/storage/database/types.js";

/** Options for {@link indexedDBDatabase}. */
export interface IndexedDBDatabaseOptions {
  /** Database name prefix; defaults to `marmot`. Use one prefix per account. */
  prefix?: string;
  /** The IndexedDB factory; defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** The matching `IDBKeyRange` class; defaults to `globalThis.IDBKeyRange`. */
  keyRange?: typeof IDBKeyRange;
}

const SCHEMA_VERSION = 1;
const GROUP_STORES = [
  "meta",
  "treeNodes",
  "wrappers",
  "messages",
  "deliveries",
] as const;
const ACCOUNT_STORES = [
  "meta",
  "keyPackages",
  "invites",
  "groups",
  "intents",
] as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function upgradeGroup(db: IDBDatabase): void {
  db.createObjectStore("meta");
  db.createObjectStore("treeNodes", { keyPath: "tag" });
  db.createObjectStore("wrappers", { keyPath: "id" }).createIndex(
    "epoch",
    "epoch",
  );
  const messages = db.createObjectStore("messages", { keyPath: "id" });
  messages.createIndex("createdAt", ["createdAt", "id"]);
  messages.createIndex("kind", ["kind", "createdAt", "id"]);
  messages.createIndex("pubkey", ["pubkey", "createdAt", "id"]);
  messages.createIndex("tags", "tags", { multiEntry: true });
  const deliveries = db.createObjectStore("deliveries", { keyPath: "id" });
  deliveries.createIndex("rumorId", "rumorId");
  // Sparse: only rows holding evidence carry the indexed flag.
  deliveries.createIndex("hasEvidence", "hasEvidence");
}

function upgradeAccount(db: IDBDatabase): void {
  db.createObjectStore("meta");
  db.createObjectStore("keyPackages", { keyPath: "ref" });
  const invites = db.createObjectStore("invites", { keyPath: "id" });
  invites.createIndex("state", "state");
  invites.createIndex("rumorId", "rumorId");
  db.createObjectStore("groups", { keyPath: "id" });
  db.createObjectStore("intents", { keyPath: "id" });
}

/** A lazily opened IndexedDB connection with transaction helpers. */
class Connection {
  #db: Promise<IDBDatabase> | undefined;
  #closed = false;

  constructor(
    readonly factory: IDBFactory,
    readonly keyRange: typeof IDBKeyRange,
    readonly name: string,
    readonly stores: readonly string[],
    readonly upgrade: (db: IDBDatabase) => void,
  ) {}

  #open(): Promise<IDBDatabase> {
    if (this.#closed) return Promise.reject(new Error("Database is closed"));
    this.#db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.name, SCHEMA_VERSION);
      req.onupgradeneeded = () => this.upgrade(req.result);
      req.onsuccess = () => {
        const db = req.result;
        // Another context deleting or upgrading the database closes this one.
        db.onversionchange = () => {
          db.close();
          this.#closed = true;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error(`IndexedDB ${this.name} is blocked`));
    });
    return this.#db;
  }

  async run<T>(
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await this.#open();
    const tx = db.transaction(this.stores as string[], mode, {
      durability: "strict",
    });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
      tx.onerror = () => reject(tx.error);
    });
    let result: T;
    try {
      result = await work(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
      await done.catch(() => undefined);
      throw error;
    }
    await done;
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const db = await this.#db?.catch(() => undefined);
    db?.close();
  }
}

/** Removes adapter-only fields and absent optionals from a stored row. */
function clean<T>(row: unknown): T {
  if (!row || typeof row !== "object") return row as T;
  const copy = { ...(row as Record<string, unknown>) };
  delete copy.hasEvidence;
  for (const key of Object.keys(copy))
    if (copy[key] === undefined) delete copy[key];
  return copy as T;
}

function compareMessages(a: MessageRow, b: MessageRow): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function matches(row: MessageRow, query: MessageQuery): boolean {
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
 * Walks an index newest first over `range`, collecting matching rows. With a
 * limit, it stops once the limit is met and the timestamp has moved on, so
 * same-second ties are complete before the final sort.
 */
async function walk(
  source: IDBIndex,
  range: IDBKeyRange,
  query: MessageQuery,
  out: Map<string, MessageRow>,
): Promise<void> {
  const found: MessageRow[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = source.openCursor(range, "prev");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      const row = clean<MessageRow>(cursor.value);
      const last = found.at(-1);
      if (
        query.limit !== undefined &&
        found.length >= query.limit &&
        last &&
        row.createdAt < last.createdAt
      )
        return resolve();
      if (matches(row, query)) found.push(row);
      cursor.continue();
    };
  });
  for (const row of found) out.set(row.id, row);
}

async function queryMessages(
  tx: IDBTransaction,
  query: MessageQuery,
  IDBKeyRange: typeof globalThis.IDBKeyRange,
): Promise<MessageRow[]> {
  const store = tx.objectStore("messages");
  const since = query.since ?? -Infinity;
  const until = query.until ?? Infinity;
  const out = new Map<string, MessageRow>();
  if (query.ids) {
    for (const id of query.ids) {
      const row = await request(store.get(id));
      if (row && matches(clean(row), query)) out.set(id, clean(row));
    }
  } else if (query.tags?.length) {
    // The first tag clause narrows candidates; the rest filter.
    const index = store.index("tags");
    for (const tag of query.tags[0]!)
      for (const row of await request(index.getAll(tag))) {
        const message = clean<MessageRow>(row);
        if (matches(message, query)) out.set(message.id, message);
      }
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
  const rows = [...out.values()].sort(compareMessages);
  return query.limit === undefined ? rows : rows.slice(0, query.limit);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

function groupReader(
  tx: () => Promise<IDBTransaction> | IDBTransaction,
  keyRange: typeof IDBKeyRange,
) {
  const store = async (name: string) => (await tx()).objectStore(name);
  const get = async <T>(name: string, key: string) => {
    const row = await request((await store(name)).get(key));
    return row === undefined ? undefined : clean<T>(row);
  };
  const reader: GroupReader = {
    meta: {
      get: async (key) =>
        (await request((await store("meta")).get(key))) as
          Uint8Array | undefined,
    },
    treeNodes: { get: (tag) => get<TreeNodeRow>("treeNodes", tag) },
    wrappers: { get: (id) => get<WrapperRow>("wrappers", id) },
    messages: {
      get: (id) => get<MessageRow>("messages", id),
      query: async (query) => queryMessages(await tx(), query, keyRange),
    },
    deliveries: {
      byRumor: async (rumorId) =>
        (
          await request(
            (await store("deliveries")).index("rumorId").getAll(rumorId),
          )
        )
          .map((row) => clean<DeliveryRow>(row))
          .sort(byId),
      countByRumor: async (rumorId) =>
        request((await store("deliveries")).index("rumorId").count(rumorId)),
      withEvidence: async () =>
        (
          await request(
            (await store("deliveries")).index("hasEvidence").getAll(),
          )
        )
          .map((row) => clean<DeliveryRow>(row))
          .sort(byId),
    },
  };
  return reader;
}

class IndexedDBGroupDatabase implements MarmotGroupDatabase {
  readonly meta: GroupReader["meta"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(readonly connection: Connection) {
    // Each read outside a transaction runs in its own readonly transaction.
    const read = <T>(fn: (reader: GroupReader) => Promise<T>) =>
      connection.run("readonly", (tx) =>
        fn(groupReader(() => tx, connection.keyRange)),
      );
    this.meta = { get: (key) => read((r) => r.meta.get(key)) };
    this.treeNodes = { get: (tag) => read((r) => r.treeNodes.get(tag)) };
    this.wrappers = { get: (id) => read((r) => r.wrappers.get(id)) };
    this.messages = {
      get: (id) => read((r) => r.messages.get(id)),
      query: (query) => read((r) => r.messages.query(query)),
    };
    this.deliveries = {
      byRumor: (id) => read((r) => r.deliveries.byRumor(id)),
      countByRumor: (id) => read((r) => r.deliveries.countByRumor(id)),
      withEvidence: () => read((r) => r.deliveries.withEvidence()),
    };
  }

  transaction<T>(fn: (tx: GroupTransaction) => Promise<T>): Promise<T> {
    return this.connection.run("readwrite", (tx) => {
      const reader = groupReader(() => tx, this.connection.keyRange);
      const store = (name: string) => tx.objectStore(name);
      const put = async (name: string, row: object) => {
        await request(store(name).put(row));
      };
      const remove = async (name: string, key: string) => {
        await request(store(name).delete(key));
      };
      return fn({
        meta: {
          ...reader.meta,
          set: async (key, value) => {
            await request(store("meta").put(value, key));
          },
          delete: (key) => remove("meta", key),
        },
        treeNodes: {
          ...reader.treeNodes,
          put: (row) => put("treeNodes", row),
          delete: (tag) => remove("treeNodes", tag),
        },
        wrappers: {
          ...reader.wrappers,
          put: (row) => put("wrappers", row),
          deleteBelow: async (floor, except = []) => {
            const keep = new Set(except);
            const index = store("wrappers").index("epoch");
            const ids = (await request(
              index.getAllKeys(
                this.connection.keyRange.upperBound(floor, true),
              ),
            )) as string[];
            for (const id of ids)
              if (!keep.has(id)) await remove("wrappers", id);
          },
        },
        messages: {
          ...reader.messages,
          put: (row) => put("messages", row),
          delete: (id) => remove("messages", id),
        },
        deliveries: {
          ...reader.deliveries,
          put: (row) =>
            put(
              "deliveries",
              row.evidence ? { ...row, hasEvidence: 1 } : { ...row },
            ),
          delete: (id) => remove("deliveries", id),
        },
      });
    });
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}

class IndexedDBGroupDatabases implements MarmotGroupDatabases {
  readonly #open = new Map<string, Set<Connection>>();

  constructor(
    readonly factory: IDBFactory,
    readonly keyRange: typeof IDBKeyRange,
    readonly prefix: string,
  ) {}

  #name(groupId: string): string {
    return `${this.prefix}:group:${groupId}`;
  }

  async open(groupId: string): Promise<MarmotGroupDatabase> {
    const connection = new Connection(
      this.factory,
      this.keyRange,
      this.#name(groupId),
      GROUP_STORES,
      upgradeGroup,
    );
    let set = this.#open.get(groupId);
    if (!set) this.#open.set(groupId, (set = new Set()));
    set.add(connection);
    return new IndexedDBGroupDatabase(connection);
  }

  async drop(groupId: string): Promise<void> {
    for (const connection of this.#open.get(groupId) ?? [])
      await connection.close();
    this.#open.delete(groupId);
    await new Promise<void>((resolve, reject) => {
      const req = this.factory.deleteDatabase(this.#name(groupId));
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error(`Deleting group database ${groupId} is blocked`));
    });
  }
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

function accountReader(tx: () => IDBTransaction): AccountReader {
  const store = (name: string) => tx().objectStore(name);
  const get = async <T>(name: string, key: string) => {
    const row = await request(store(name).get(key));
    return row === undefined ? undefined : clean<T>(row);
  };
  const all = async <T>(name: string) =>
    (await request(store(name).getAll())).map((row) => clean<T>(row));
  return {
    meta: {
      get: async (key) =>
        (await request(store("meta").get(key))) as Uint8Array | undefined,
    },
    keyPackages: {
      get: (ref) => get<KeyPackageRow>("keyPackages", ref),
      all: () => all<KeyPackageRow>("keyPackages"),
    },
    invites: {
      get: (id) => get<InviteRow>("invites", id),
      byState: async (state) =>
        (await request(store("invites").index("state").getAll(state)))
          .map((row) => clean<InviteRow>(row))
          .sort((a, b) => a.receivedAt - b.receivedAt || byId(a, b)),
      byRumor: async (rumorId) => {
        const row = await request(
          store("invites").index("rumorId").get(rumorId),
        );
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

class IndexedDBAccountDatabase implements MarmotAccountDatabase {
  readonly meta: AccountReader["meta"];
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor(readonly connection: Connection) {
    const read = <T>(fn: (reader: AccountReader) => Promise<T>) =>
      connection.run("readonly", (tx) => fn(accountReader(() => tx)));
    this.meta = { get: (key) => read((r) => r.meta.get(key)) };
    this.keyPackages = {
      get: (ref) => read((r) => r.keyPackages.get(ref)),
      all: () => read((r) => r.keyPackages.all()),
    };
    this.invites = {
      get: (id) => read((r) => r.invites.get(id)),
      byState: (state) => read((r) => r.invites.byState(state)),
      byRumor: (id) => read((r) => r.invites.byRumor(id)),
    };
    this.groups = {
      get: (id) => read((r) => r.groups.get(id)),
      all: () => read((r) => r.groups.all()),
    };
    this.intents = { all: () => read((r) => r.intents.all()) };
  }

  transaction<T>(fn: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    return this.connection.run("readwrite", (tx) => {
      const reader = accountReader(() => tx);
      const store = (name: string) => tx.objectStore(name);
      const put = async (name: string, row: object) => {
        await request(store(name).put(row));
      };
      const remove = async (name: string, key: string) => {
        await request(store(name).delete(key));
      };
      return fn({
        meta: {
          ...reader.meta,
          set: async (key, value) => {
            await request(store("meta").put(value, key));
          },
          delete: (key) => remove("meta", key),
        },
        keyPackages: {
          ...reader.keyPackages,
          put: (row) => put("keyPackages", row),
          delete: (ref) => remove("keyPackages", ref),
        },
        invites: {
          ...reader.invites,
          put: (row) => put("invites", row),
          delete: (id) => remove("invites", id),
        },
        groups: {
          ...reader.groups,
          put: (row) => put("groups", row),
          delete: (id) => remove("groups", id),
        },
        intents: {
          ...reader.intents,
          put: (row) => put("intents", row),
          delete: (id) => remove("intents", id),
        },
      });
    });
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}

/** A {@link MarmotDatabase} stored in IndexedDB (browsers, workers). */
export function indexedDBDatabase(
  options: IndexedDBDatabaseOptions = {},
): MarmotDatabase {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  if (!factory || !keyRange) throw new Error("IndexedDB is not available");
  const prefix = options.prefix ?? "marmot";
  return {
    account: new IndexedDBAccountDatabase(
      new Connection(
        factory,
        keyRange,
        `${prefix}:account`,
        ACCOUNT_STORES,
        upgradeAccount,
      ),
    ),
    groups: new IndexedDBGroupDatabases(factory, keyRange, prefix),
  };
}
