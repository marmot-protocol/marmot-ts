/**
 * SQLite adapter for {@link MarmotDatabase} over any driver that can run a
 * statement and return rows (`node:sqlite`, `bun:sqlite`, `better-sqlite3`,
 * libSQL, SQLCipher). Every group shares one connection: each group's rows
 * carry its id in their primary key, and dropping a group deletes them in one
 * transaction.
 *
 * Values are stored as given (plaintext). Use an encrypted SQLite build
 * (SQLCipher) or an encrypted file system when the threat model requires it.
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
} from "../client/storage/database/types.js";

/**
 * A SQLite connection. `execute` runs one statement with positional `?`
 * parameters and returns its result rows as plain objects (an empty array for
 * statements without results). Use one connection per account, dedicated to
 * this adapter, so its transactions are not interleaved with other work.
 */
export interface SQLiteConnection {
  execute(
    sql: string,
    params?: readonly unknown[],
  ):
    | readonly Record<string, unknown>[]
    | Promise<readonly Record<string, unknown>[]>;
}

/** Options for {@link sqliteDatabase}. */
export interface SQLiteDatabaseOptions {
  /** Table name prefix; defaults to `marmot_`. Letters, digits and `_` only. */
  tablePrefix?: string;
}

const SCHEMA_VERSION = 1;

type Execute = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("SQLite returned a non-binary value");
}

function optionalBytes(value: unknown): Uint8Array | undefined {
  return value === null || value === undefined ? undefined : bytes(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function schema(p: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${p}schema (version INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}account_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}key_packages (ref TEXT PRIMARY KEY, identifier TEXT, not_before INTEGER NOT NULL, used INTEGER NOT NULL, value BLOB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}invites (id TEXT PRIMARY KEY, state TEXT NOT NULL, rumor_id TEXT, received_at INTEGER NOT NULL, value BLOB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_state ON ${p}invites (state, received_at, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_rumor ON ${p}invites (rumor_id) WHERE rumor_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${p}groups (id TEXT PRIMARY KEY, status TEXT NOT NULL, value BLOB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT NOT NULL, value BLOB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}group_meta (gid TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (gid, key)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${p}tree_nodes (gid TEXT NOT NULL, tag TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (gid, tag)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${p}wrappers (gid TEXT NOT NULL, id TEXT NOT NULL, epoch INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (gid, id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}wrappers_epoch ON ${p}wrappers (gid, epoch)`,
    `CREATE TABLE IF NOT EXISTS ${p}messages (gid TEXT NOT NULL, id TEXT NOT NULL, kind INTEGER NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY (gid, id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_time ON ${p}messages (gid, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_kind ON ${p}messages (gid, kind, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_pubkey ON ${p}messages (gid, pubkey, created_at DESC, id)`,
    `CREATE TABLE IF NOT EXISTS ${p}message_tags (gid TEXT NOT NULL, tag TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (gid, tag, message_id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}message_tags_message ON ${p}message_tags (gid, message_id)`,
    `CREATE TABLE IF NOT EXISTS ${p}deliveries (gid TEXT NOT NULL, id TEXT NOT NULL, rumor_id TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL, value BLOB NOT NULL, evidence BLOB, PRIMARY KEY (gid, id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}deliveries_rumor ON ${p}deliveries (gid, rumor_id)`,
    `CREATE INDEX IF NOT EXISTS ${p}deliveries_evidence ON ${p}deliveries (gid, id) WHERE evidence IS NOT NULL`,
  ];
}

/** Serializes every statement on one connection; transactions hold the lane. */
class Lane {
  #tail: Promise<unknown> = Promise.resolve();
  #ready: Promise<void> | undefined;

  constructor(
    readonly connection: SQLiteConnection,
    readonly prefix: string,
  ) {}

  readonly execute: Execute = async (sql, params = []) =>
    this.connection.execute(sql, params);

  #init(): Promise<void> {
    this.#ready ??= (async () => {
      for (const statement of schema(this.prefix))
        await this.execute(statement);
      const [row] = await this.execute(
        `SELECT version FROM ${this.prefix}schema LIMIT 1`,
      );
      if (!row)
        await this.execute(
          `INSERT INTO ${this.prefix}schema (version) VALUES (?)`,
          [SCHEMA_VERSION],
        );
      else if (Number(row.version) !== SCHEMA_VERSION)
        throw new Error(
          `Unsupported Marmot SQLite schema version ${String(row.version)}`,
        );
    })();
    return this.#ready;
  }

  /** Runs `work` alone on the connection, optionally inside a transaction. */
  run<T>(write: boolean, work: (execute: Execute) => Promise<T>): Promise<T> {
    const task = this.#tail.then(async () => {
      await this.#init();
      if (!write) return work(this.execute);
      await this.execute("BEGIN IMMEDIATE");
      try {
        const result = await work(this.execute);
        await this.execute("COMMIT");
        return result;
      } catch (error) {
        await this.execute("ROLLBACK");
        throw error;
      }
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }
}

// ---------------------------------------------------------------------------
// Group database
// ---------------------------------------------------------------------------

function messageFromRow(
  row: Record<string, unknown>,
): Omit<MessageRow, "tags"> {
  return {
    id: String(row.id),
    kind: Number(row.kind),
    pubkey: String(row.pubkey),
    createdAt: Number(row.created_at),
    value: bytes(row.value),
  };
}

function deliveryFromRow(row: Record<string, unknown>): DeliveryRow {
  const delivery: DeliveryRow = {
    id: String(row.id),
    rumorId: String(row.rumor_id),
    epoch: Number(row.epoch),
    createdAt: Number(row.created_at),
    value: bytes(row.value),
  };
  const evidence = optionalBytes(row.evidence);
  if (evidence) delivery.evidence = evidence;
  return delivery;
}

function groupReader(p: string, gid: string, execute: Execute): GroupReader {
  const tagsOf = async (id: string) =>
    (
      await execute(
        `SELECT tag FROM ${p}message_tags WHERE gid = ? AND message_id = ? ORDER BY tag`,
        [gid, id],
      )
    ).map((row) => String(row.tag));
  const withTags = async (
    row: Record<string, unknown>,
  ): Promise<MessageRow> => {
    const message = messageFromRow(row);
    return { ...message, tags: await tagsOf(message.id) };
  };
  return {
    meta: {
      get: async (key) => {
        const [row] = await execute(
          `SELECT value FROM ${p}group_meta WHERE gid = ? AND key = ?`,
          [gid, key],
        );
        return row ? bytes(row.value) : undefined;
      },
    },
    treeNodes: {
      get: async (tag) => {
        const [row] = await execute(
          `SELECT value FROM ${p}tree_nodes WHERE gid = ? AND tag = ?`,
          [gid, tag],
        );
        return row ? { tag, value: bytes(row.value) } : undefined;
      },
    },
    wrappers: {
      get: async (id) => {
        const [row] = await execute(
          `SELECT epoch, value FROM ${p}wrappers WHERE gid = ? AND id = ?`,
          [gid, id],
        );
        return row
          ? { id, epoch: Number(row.epoch), value: bytes(row.value) }
          : undefined;
      },
    },
    messages: {
      get: async (id) => {
        const [row] = await execute(
          `SELECT * FROM ${p}messages WHERE gid = ? AND id = ?`,
          [gid, id],
        );
        return row ? withTags(row) : undefined;
      },
      query: async (query: MessageQuery) => {
        const where = ["m.gid = ?"];
        const params: unknown[] = [gid];
        const list = (column: string, values: readonly unknown[]) => {
          where.push(
            values.length
              ? `${column} IN (${values.map(() => "?").join(", ")})`
              : "0",
          );
          params.push(...values);
        };
        if (query.ids) list("m.id", query.ids);
        if (query.kinds) list("m.kind", query.kinds);
        if (query.authors) list("m.pubkey", query.authors);
        if (query.since !== undefined) {
          where.push("m.created_at >= ?");
          params.push(query.since);
        }
        if (query.until !== undefined) {
          where.push("m.created_at <= ?");
          params.push(query.until);
        }
        for (const alternatives of query.tags ?? []) {
          where.push(
            alternatives.length
              ? `EXISTS (SELECT 1 FROM ${p}message_tags t WHERE t.gid = m.gid AND t.message_id = m.id AND t.tag IN (${alternatives.map(() => "?").join(", ")}))`
              : "0",
          );
          params.push(...alternatives);
        }
        let sql = `SELECT m.* FROM ${p}messages m WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id ASC`;
        if (query.limit !== undefined) {
          sql += " LIMIT ?";
          params.push(query.limit);
        }
        const rows = await execute(sql, params);
        const messages: MessageRow[] = [];
        for (const row of rows) messages.push(await withTags(row));
        return messages;
      },
    },
    deliveries: {
      byRumor: async (rumorId) =>
        (
          await execute(
            `SELECT * FROM ${p}deliveries WHERE gid = ? AND rumor_id = ? ORDER BY id`,
            [gid, rumorId],
          )
        ).map(deliveryFromRow),
      countByRumor: async (rumorId) => {
        const [row] = await execute(
          `SELECT COUNT(*) AS n FROM ${p}deliveries WHERE gid = ? AND rumor_id = ?`,
          [gid, rumorId],
        );
        return Number(row?.n ?? 0);
      },
      withEvidence: async () =>
        (
          await execute(
            `SELECT * FROM ${p}deliveries WHERE gid = ? AND evidence IS NOT NULL ORDER BY id`,
            [gid],
          )
        ).map(deliveryFromRow),
    },
  };
}

function groupTransaction(
  p: string,
  gid: string,
  execute: Execute,
): GroupTransaction {
  const reader = groupReader(p, gid, execute);
  return {
    meta: {
      ...reader.meta,
      set: async (key, value) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}group_meta (gid, key, value) VALUES (?, ?, ?)`,
          [gid, key, value],
        );
      },
      delete: async (key) => {
        await execute(`DELETE FROM ${p}group_meta WHERE gid = ? AND key = ?`, [
          gid,
          key,
        ]);
      },
    },
    treeNodes: {
      ...reader.treeNodes,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}tree_nodes (gid, tag, value) VALUES (?, ?, ?)`,
          [gid, row.tag, row.value],
        );
      },
      delete: async (tag) => {
        await execute(`DELETE FROM ${p}tree_nodes WHERE gid = ? AND tag = ?`, [
          gid,
          tag,
        ]);
      },
    },
    wrappers: {
      ...reader.wrappers,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}wrappers (gid, id, epoch, value) VALUES (?, ?, ?, ?)`,
          [gid, row.id, row.epoch, row.value],
        );
      },
      deleteBelow: async (floor, except = []) => {
        const keep = except.length
          ? ` AND id NOT IN (${except.map(() => "?").join(", ")})`
          : "";
        await execute(
          `DELETE FROM ${p}wrappers WHERE gid = ? AND epoch < ?${keep}`,
          [gid, floor, ...except],
        );
      },
    },
    messages: {
      ...reader.messages,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}messages (gid, id, kind, pubkey, created_at, value) VALUES (?, ?, ?, ?, ?, ?)`,
          [gid, row.id, row.kind, row.pubkey, row.createdAt, row.value],
        );
        await execute(
          `DELETE FROM ${p}message_tags WHERE gid = ? AND message_id = ?`,
          [gid, row.id],
        );
        for (const tag of new Set(row.tags))
          await execute(
            `INSERT INTO ${p}message_tags (gid, tag, message_id) VALUES (?, ?, ?)`,
            [gid, tag, row.id],
          );
      },
      delete: async (id) => {
        await execute(`DELETE FROM ${p}messages WHERE gid = ? AND id = ?`, [
          gid,
          id,
        ]);
        await execute(
          `DELETE FROM ${p}message_tags WHERE gid = ? AND message_id = ?`,
          [gid, id],
        );
      },
    },
    deliveries: {
      ...reader.deliveries,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}deliveries (gid, id, rumor_id, epoch, created_at, value, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            gid,
            row.id,
            row.rumorId,
            row.epoch,
            row.createdAt,
            row.value,
            row.evidence ?? null,
          ],
        );
      },
      delete: async (id) => {
        await execute(`DELETE FROM ${p}deliveries WHERE gid = ? AND id = ?`, [
          gid,
          id,
        ]);
      },
    },
  };
}

const GROUP_TABLES = [
  "group_meta",
  "tree_nodes",
  "wrappers",
  "messages",
  "message_tags",
  "deliveries",
];

class SQLiteGroupDatabase implements MarmotGroupDatabase {
  readonly meta: GroupReader["meta"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(
    readonly lane: Lane,
    readonly gid: string,
  ) {
    const read = <T>(fn: (reader: GroupReader) => Promise<T>) =>
      lane.run(false, (execute) => fn(groupReader(lane.prefix, gid, execute)));
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
    return this.lane.run(true, (execute) =>
      fn(groupTransaction(this.lane.prefix, this.gid, execute)),
    );
  }

  async close(): Promise<void> {}
}

class SQLiteGroupDatabases implements MarmotGroupDatabases {
  constructor(readonly lane: Lane) {}

  async open(groupId: string): Promise<MarmotGroupDatabase> {
    return new SQLiteGroupDatabase(this.lane, groupId);
  }

  drop(groupId: string): Promise<void> {
    const p = this.lane.prefix;
    return this.lane.run(true, async (execute) => {
      for (const table of GROUP_TABLES)
        await execute(`DELETE FROM ${p}${table} WHERE gid = ?`, [groupId]);
    });
  }
}

// ---------------------------------------------------------------------------
// Account database
// ---------------------------------------------------------------------------

function keyPackageFromRow(row: Record<string, unknown>): KeyPackageRow {
  const keyPackage: KeyPackageRow = {
    ref: String(row.ref),
    notBefore: Number(row.not_before),
    used: Number(row.used) === 1,
    value: bytes(row.value),
  };
  const identifier = optionalString(row.identifier);
  if (identifier !== undefined) keyPackage.identifier = identifier;
  return keyPackage;
}

function inviteFromRow(row: Record<string, unknown>): InviteRow {
  const invite: InviteRow = {
    id: String(row.id),
    state: String(row.state) as InviteRow["state"],
    receivedAt: Number(row.received_at),
    value: bytes(row.value),
  };
  const rumorId = optionalString(row.rumor_id);
  if (rumorId !== undefined) invite.rumorId = rumorId;
  return invite;
}

function accountReader(p: string, execute: Execute): AccountReader {
  return {
    meta: {
      get: async (key) => {
        const [row] = await execute(
          `SELECT value FROM ${p}account_meta WHERE key = ?`,
          [key],
        );
        return row ? bytes(row.value) : undefined;
      },
    },
    keyPackages: {
      get: async (ref) => {
        const [row] = await execute(
          `SELECT * FROM ${p}key_packages WHERE ref = ?`,
          [ref],
        );
        return row ? keyPackageFromRow(row) : undefined;
      },
      all: async () =>
        (await execute(`SELECT * FROM ${p}key_packages ORDER BY ref`)).map(
          keyPackageFromRow,
        ),
    },
    invites: {
      get: async (id) => {
        const [row] = await execute(`SELECT * FROM ${p}invites WHERE id = ?`, [
          id,
        ]);
        return row ? inviteFromRow(row) : undefined;
      },
      byState: async (state) =>
        (
          await execute(
            `SELECT * FROM ${p}invites WHERE state = ? ORDER BY received_at, id`,
            [state],
          )
        ).map(inviteFromRow),
      byRumor: async (rumorId) => {
        const [row] = await execute(
          `SELECT * FROM ${p}invites WHERE rumor_id = ? LIMIT 1`,
          [rumorId],
        );
        return row ? inviteFromRow(row) : undefined;
      },
    },
    groups: {
      get: async (id) => {
        const [row] = await execute(`SELECT * FROM ${p}groups WHERE id = ?`, [
          id,
        ]);
        return row
          ? {
              id,
              status: String(row.status) as GroupRow["status"],
              value: bytes(row.value),
            }
          : undefined;
      },
      all: async () =>
        (await execute(`SELECT * FROM ${p}groups ORDER BY id`)).map((row) => ({
          id: String(row.id),
          status: String(row.status) as GroupRow["status"],
          value: bytes(row.value),
        })),
    },
    intents: {
      all: async () =>
        (await execute(`SELECT * FROM ${p}intents ORDER BY id`)).map(
          (row): IntentRow => ({
            id: String(row.id),
            kind: String(row.kind) as IntentRow["kind"],
            groupId: String(row.group_id),
            value: bytes(row.value),
          }),
        ),
    },
  };
}

function accountTransaction(p: string, execute: Execute): AccountTransaction {
  const reader = accountReader(p, execute);
  const remove = async (table: string, column: string, key: string) => {
    await execute(`DELETE FROM ${p}${table} WHERE ${column} = ?`, [key]);
  };
  return {
    meta: {
      ...reader.meta,
      set: async (key, value) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}account_meta (key, value) VALUES (?, ?)`,
          [key, value],
        );
      },
      delete: (key) => remove("account_meta", "key", key),
    },
    keyPackages: {
      ...reader.keyPackages,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}key_packages (ref, identifier, not_before, used, value) VALUES (?, ?, ?, ?, ?)`,
          [
            row.ref,
            row.identifier ?? null,
            row.notBefore,
            row.used ? 1 : 0,
            row.value,
          ],
        );
      },
      delete: (ref) => remove("key_packages", "ref", ref),
    },
    invites: {
      ...reader.invites,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}invites (id, state, rumor_id, received_at, value) VALUES (?, ?, ?, ?, ?)`,
          [row.id, row.state, row.rumorId ?? null, row.receivedAt, row.value],
        );
      },
      delete: (id) => remove("invites", "id", id),
    },
    groups: {
      ...reader.groups,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}groups (id, status, value) VALUES (?, ?, ?)`,
          [row.id, row.status, row.value],
        );
      },
      delete: (id) => remove("groups", "id", id),
    },
    intents: {
      ...reader.intents,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}intents (id, kind, group_id, value) VALUES (?, ?, ?, ?)`,
          [row.id, row.kind, row.groupId, row.value],
        );
      },
      delete: (id) => remove("intents", "id", id),
    },
  };
}

class SQLiteAccountDatabase implements MarmotAccountDatabase {
  readonly meta: AccountReader["meta"];
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor(readonly lane: Lane) {
    const read = <T>(fn: (reader: AccountReader) => Promise<T>) =>
      lane.run(false, (execute) => fn(accountReader(lane.prefix, execute)));
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
    return this.lane.run(true, (execute) =>
      fn(accountTransaction(this.lane.prefix, execute)),
    );
  }

  async close(): Promise<void> {}
}

/** A {@link MarmotDatabase} stored in SQLite through `connection`. */
export function sqliteDatabase(
  connection: SQLiteConnection,
  options: SQLiteDatabaseOptions = {},
): MarmotDatabase {
  const prefix = options.tablePrefix ?? "marmot_";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    throw new Error("Invalid SQLite table prefix");
  const lane = new Lane(connection, prefix);
  return {
    account: new SQLiteAccountDatabase(lane),
    groups: new SQLiteGroupDatabases(lane),
  };
}
