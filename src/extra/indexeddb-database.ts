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
  compileMessageFilter,
  matchesMessage,
  type MessageFilterPlan,
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
  MessageFilter,
  MessageRow,
  TreeNodeRow,
  WrapperRow,
} from "../client/storage/database/types.js";

/** Options for {@link indexedDBDatabase}. */
export interface IndexedDBDatabaseOptions {
  /** Database name prefix; defaults to `marmot`. Use one prefix per account. */
  prefix?: string;
}

const SCHEMA_VERSION = 3;
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
 * on read: `_tags` holds a message's {@link indexTags} keys paired with its
 * `createdAt` (so tag lookups are time-ordered like kind and author), `_evidence`
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
  // Each `[tagKey, createdAt]` entry is its own (array) index key.
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
 * Keys read per clause when sizing it. A clause under the cap yields its
 * exact key set; larger clauses are only walked. Bounded `getAllKeys` stays
 * cheap where `count()` scans the whole range.
 */
const PROBE_LIMIT = 1024;
/** Candidate sets up to this size are loaded directly rather than walked. */
const LOAD_LIMIT = 256;

type Index = IDBPIndex<unknown, string[], string, string, IDBTransactionMode>;

/**
 * One index clause of a filter: the union of `ranges` in `index` holds every
 * match. Every clause index (`tags`, `kind`, `pubkey`) leads with the clause
 * value and then `createdAt`, so ranges carry `since`/`until` and walk newest
 * first.
 */
interface Clause {
  index: string;
  ranges: IDBKeyRange[];
  /** The clause's primary keys, when it is under {@link PROBE_LIMIT}. */
  keys?: Set<string>;
}

/**
 * Collects matching rows newest first. With a limit it is done once the limit
 * is met and the timestamp has moved on, so same-second ties are complete
 * before the final sort.
 */
function collector(plan: MessageFilterPlan) {
  const found: MessageRow[] = [];
  return {
    found,
    done: (createdAt: number) =>
      plan.limit !== undefined &&
      found.length >= plan.limit &&
      createdAt < found.at(-1)!.createdAt,
    add: (row: MessageRow) => {
      if (matchesMessage(row, plan)) found.push(row);
    },
  };
}

/** Walks one range newest first, reading each row. */
async function walkRows(
  index: Index,
  range: IDBKeyRange,
  plan: MessageFilterPlan,
): Promise<MessageRow[]> {
  const out = collector(plan);
  for (
    let cursor = await index.openCursor(range, "prev");
    cursor;
    cursor = await cursor.continue()
  ) {
    const row = clean<MessageRow>(cursor.value);
    if (out.done(row.createdAt)) break;
    out.add(row);
  }
  return out.found;
}

/**
 * Walks one clause range newest first by key alone, reading only rows among
 * `candidates`, so a limited query skips non-candidates without loading them.
 */
async function walkCandidates(
  store: Store,
  index: Index,
  range: IDBKeyRange,
  candidates: Set<string>,
  plan: MessageFilterPlan,
): Promise<MessageRow[]> {
  const out = collector(plan);
  for (
    let cursor = await index.openKeyCursor(range, "prev");
    cursor;
    cursor = await cursor.continue()
  ) {
    if (out.done((cursor.key as [unknown, number])[1])) break;
    const id = cursor.primaryKey as string;
    if (candidates.has(id)) out.add(clean(await store.get(id)));
  }
  return out.found;
}

/** Loads rows by primary key, keeping the matches. */
async function loadRows(
  store: Store,
  ids: Iterable<string>,
  plan: MessageFilterPlan,
): Promise<MessageRow[]> {
  const rows = await Promise.all([...ids].map((id) => store.get(id)));
  return rows.flatMap((row) => {
    if (row === undefined) return [];
    const message = clean<MessageRow>(row);
    return matchesMessage(message, plan) ? [message] : [];
  });
}

/**
 * Answers one filter, borrowing nostr-idb's approach: each index clause
 * (`&`/`#` tags, kinds, authors) is probed for at most
 * {@link PROBE_LIMIT} keys, and the exact key sets of small clauses are
 * intersected. Small candidate sets are loaded directly; otherwise the
 * smallest clause is walked newest first, by key when there are candidates
 * to check, so a limited query reads about `limit` rows.
 */
async function queryMessages(
  store: Store,
  filter: MessageFilter,
): Promise<MessageRow[]> {
  const plan = compileMessageFilter(filter);
  if (!plan.possible) return [];
  const finish = (rows: MessageRow[]) => {
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    unique.sort(compareMessages);
    return plan.limit === undefined ? unique : unique.slice(0, plan.limit);
  };
  if (plan.ids) return finish(await loadRows(store, new Set(plan.ids), plan));

  const since = plan.since ?? -Infinity;
  const until = plan.until ?? Infinity;
  const clause = (index: string, values: readonly IDBValidKey[]): Clause => ({
    index,
    ranges: values.map((value) =>
      IDBKeyRange.bound([value, since], [value, until, []]),
    ),
  });
  const clauses = [
    ...plan.allTags.map((key) => clause("tags", [key])),
    ...plan.anyTags.map((keys) => clause("tags", keys)),
  ];
  if (plan.kinds) clauses.push(clause("kind", plan.kinds));
  if (plan.authors) clauses.push(clause("pubkey", plan.authors));

  if (!clauses.length) {
    const index = store.index("createdAt");
    const time = IDBKeyRange.bound([since], [until, []]);
    if (plan.limit !== undefined)
      return finish(await walkRows(index, time, plan));
    return finish(
      (await index.getAll(time))
        .map((row) => clean<MessageRow>(row))
        .filter((row) => matchesMessage(row, plan)),
    );
  }

  // Sizing only pays off when there is something to intersect.
  if (clauses.length > 1)
    await Promise.all(
      clauses.map(async (clause) => {
        const index = store.index(clause.index);
        const parts = await Promise.all(
          clause.ranges.map((range) => index.getAllKeys(range, PROBE_LIMIT)),
        );
        if (parts.every((part) => part.length < PROBE_LIMIT))
          clause.keys = new Set(parts.flat() as string[]);
      }),
    );
  const sized = clauses
    .filter((clause) => clause.keys)
    .sort((a, b) => a.keys!.size - b.keys!.size);
  let candidates: Set<string> | undefined;
  for (const { keys } of sized)
    candidates = candidates
      ? new Set([...candidates].filter((id) => keys!.has(id)))
      : keys;
  if (candidates?.size === 0) return [];
  if (candidates && (plan.limit === undefined || candidates.size <= LOAD_LIMIT))
    return finish(await loadRows(store, candidates, plan));

  // Walk the smallest clause; every range is newest first.
  const driver = sized[0] ?? clauses[0]!;
  const index = store.index(driver.index);
  if (plan.limit === undefined) {
    const rows = await Promise.all(
      driver.ranges.map((range) => index.getAll(range)),
    );
    return finish(
      rows
        .flat()
        .map((row) => clean<MessageRow>(row))
        .filter((row) => matchesMessage(row, plan)),
    );
  }
  // Candidates narrower than the driver are checked by key before loading.
  const narrower =
    candidates && candidates.size < (driver.keys?.size ?? Infinity)
      ? candidates
      : undefined;
  const walks = await Promise.all(
    driver.ranges.map((range) =>
      narrower
        ? walkCandidates(store, index, range, narrower, plan)
        : walkRows(index, range, plan),
    ),
  );
  return finish(walks.flat());
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
      query: async (filter) => queryMessages(await store("messages"), filter),
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
      put: (row) =>
        w("messages").put({
          ...row,
          _tags: indexTags(row.tags).map((key) => [key, row.createdAt]),
        }),
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
