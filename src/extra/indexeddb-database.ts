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
  /** The IndexedDB factory; defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** The matching `IDBKeyRange` class; defaults to `globalThis.IDBKeyRange`. */
  keyRange?: typeof IDBKeyRange;
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
] as const;
const ACCOUNT_STORES = ["keyPackages", "invites", "groups", "intents"] as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Hidden, adapter-only fields kept on stored rows for indexing and stripped
 * on read: `_tags` holds a message's {@link indexTags} keys, `_evidence`
 * marks deliveries that hold evidence (a sparse index).
 */
const HIDDEN = ["_tags", "_evidence"] as const;

/** Drops every existing store; the schema is recreated from scratch. */
function reset(db: IDBDatabase): void {
  for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
}

function upgradeGroup(db: IDBDatabase): void {
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

function upgradeAccount(db: IDBDatabase): void {
  reset(db);
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
  for (const key of HIDDEN) delete copy[key];
  for (const key of Object.keys(copy))
    if (copy[key] === undefined) delete copy[key];
  return copy as T;
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
  const tagKeys = queryTagKeys(query);
  if (query.ids) {
    for (const id of query.ids) {
      const row = await request(store.get(id));
      if (row && matches(clean(row), query)) out.set(id, clean(row));
    }
  } else if (tagKeys.length) {
    // The first tag clause narrows candidates; the rest filter.
    const index = store.index("tags");
    for (const key of tagKeys[0]!)
      for (const row of await request(index.getAll(key))) {
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
    group: async () =>
      (await get<GroupRecord>("group", GROUP_KEY)) ?? ({} as GroupRecord),
    treeNodes: { get: (tag) => get<TreeNodeRow>("treeNodes", tag) },
    wrappers: { get: (id) => get<WrapperRow>("wrappers", id) },
    effects: {
      get: (digest) => get<EffectRow>("effects", digest),
      // Index order within one state is primary-key (digest) order.
      byState: async (state) =>
        (
          await request((await store("effects")).index("state").getAll(state))
        ).map((row) => clean<EffectRow>(row)),
    },
    backfill: { get: (relay) => get<BackfillRow>("backfill", relay) },
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
        (await request((await store("deliveries")).index("evidence").getAll()))
          .map((row) => clean<DeliveryRow>(row))
          .sort(byId),
    },
  };
  return reader;
}

class IndexedDBGroupDatabase implements MarmotGroupDatabase {
  readonly group: GroupReader["group"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly effects: GroupReader["effects"];
  readonly backfill: GroupReader["backfill"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(readonly connection: Connection) {
    // Each read outside a transaction runs in its own readonly transaction.
    const read = <T>(fn: (reader: GroupReader) => Promise<T>) =>
      connection.run("readonly", (tx) =>
        fn(groupReader(() => tx, connection.keyRange)),
      );
    this.group = () => read((r) => r.group());
    this.treeNodes = { get: (tag) => read((r) => r.treeNodes.get(tag)) };
    this.wrappers = { get: (id) => read((r) => r.wrappers.get(id)) };
    this.effects = {
      get: (digest) => read((r) => r.effects.get(digest)),
      byState: (state) => read((r) => r.effects.byState(state)),
    };
    this.backfill = { get: (relay) => read((r) => r.backfill.get(relay)) };
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
        ...reader,
        updateGroup: async (update) => {
          const current = (await request(store("group").get(GROUP_KEY))) ?? {};
          await request(
            store("group").put(
              applyGroupUpdate(clean<GroupRecord>(current), update),
              GROUP_KEY,
            ),
          );
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
        effects: {
          ...reader.effects,
          put: (row) => put("effects", row),
          delete: (digest) => remove("effects", digest),
        },
        backfill: {
          ...reader.backfill,
          put: (row) => put("backfill", row),
          delete: (relay) => remove("backfill", relay),
        },
        messages: {
          ...reader.messages,
          put: (row) => put("messages", { ...row, _tags: indexTags(row.tags) }),
          delete: (id) => remove("messages", id),
        },
        deliveries: {
          ...reader.deliveries,
          put: (row) =>
            put(
              "deliveries",
              row.evidence ? { ...row, _evidence: 1 } : { ...row },
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
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor(readonly connection: Connection) {
    const read = <T>(fn: (reader: AccountReader) => Promise<T>) =>
      connection.run("readonly", (tx) => fn(accountReader(() => tx)));
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
