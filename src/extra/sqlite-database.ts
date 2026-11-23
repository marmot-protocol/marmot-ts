/**
 * SQLite adapter for {@link MarmotDatabase} over any driver that can run a
 * statement and return rows (`node:sqlite`, `bun:sqlite`, `better-sqlite3`,
 * libSQL, SQLCipher). Every group shares one connection: each group's rows
 * carry its id in their primary key, and dropping a group deletes them in one
 * transaction.
 *
 * Scalars are stored in typed columns, MLS objects in BLOB columns and nested
 * records (Nostr events, tags, notifications) in JSON TEXT columns.
 *
 * Values are stored as given (plaintext). Use an encrypted SQLite build
 * (SQLCipher) or an encrypted file system when the threat model requires it.
 *
 * @module @category Storage
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { indexTags, queryTagKeys } from "../client/storage/database/query.js";
import type {
  AccountReader,
  AccountTransaction,
  BackfillRow,
  DeliveryRow,
  EffectRow,
  GroupReader,
  GroupRecord,
  GroupRecordUpdate,
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

const SCHEMA_VERSION = 2;

type Execute = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Value codecs
// ---------------------------------------------------------------------------

/** Normalizes a driver BLOB (Buffer, ArrayBuffer, …) to a plain `Uint8Array`. */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array)
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("SQLite returned a non-binary value");
}

const isNull = (value: unknown): value is null | undefined =>
  value === null || value === undefined;

const optionalBytes = (value: unknown): Uint8Array | undefined =>
  isNull(value) ? undefined : bytes(value);
const optionalString = (value: unknown): string | undefined =>
  isNull(value) ? undefined : String(value);
const optionalNumber = (value: unknown): number | undefined =>
  isNull(value) ? undefined : Number(value);
const optionalBoolean = (value: unknown): boolean | undefined =>
  isNull(value) ? undefined : Number(value) !== 0;

/** Key of the adapter-private JSON wrapper for binary values. */
const BYTES_KEY = "$b";

/**
 * Encodes a nested record as JSON. `Uint8Array` values (MLS objects nested in
 * the group record) are written as `{"$b": "<hex>"}`; this encoding is private
 * to the adapter.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value, function (key, encoded: unknown) {
    // `this[key]` is the raw value, before any `toJSON` (Buffer) ran.
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Uint8Array) return { [BYTES_KEY]: bytesToHex(raw) };
    return encoded;
  });
}

function fromJson<T>(text: unknown): T {
  return JSON.parse(String(text), (_key, value: unknown) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as Record<string, unknown>)[BYTES_KEY] === "string"
    )
      return hexToBytes((value as Record<string, string>)[BYTES_KEY]!);
    return value;
  }) as T;
}

const optionalJson = <T>(text: unknown): T | undefined =>
  isNull(text) ? undefined : fromJson<T>(text);

/** Sets `key` on `target` only when `value` is defined (optional fields stay absent). */
function assign<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

const placeholders = (values: readonly unknown[]) =>
  values.map(() => "?").join(", ");

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Every table this adapter has ever created, for dropping older schemas. */
const ALL_TABLES = [
  "account_meta",
  "key_packages",
  "invites",
  "groups",
  "intents",
  "group_meta",
  "group_records",
  "tree_nodes",
  "wrappers",
  "effects",
  "backfill",
  "messages",
  "message_tags",
  "deliveries",
];

/** Tables holding per-group rows, keyed by `gid`. */
const GROUP_TABLES = [
  "group_records",
  "tree_nodes",
  "wrappers",
  "effects",
  "backfill",
  "messages",
  "message_tags",
  "deliveries",
];

function schema(p: string): string[] {
  return [
    // Account database
    `CREATE TABLE IF NOT EXISTS ${p}key_packages (
      ref TEXT PRIMARY KEY,
      public_package BLOB NOT NULL,
      private_package BLOB,
      identifier TEXT,
      not_before INTEGER NOT NULL,
      used INTEGER NOT NULL,
      published TEXT NOT NULL,
      relays TEXT,
      consumption_receipts TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${p}invites (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      rumor_id TEXT,
      received_at INTEGER NOT NULL,
      giftwrap TEXT,
      rumor TEXT,
      attempted INTEGER,
      invalid INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_state ON ${p}invites (state, received_at, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}invites_rumor ON ${p}invites (rumor_id) WHERE rumor_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${p}groups (id TEXT PRIMARY KEY, status TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${p}intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, group_id TEXT NOT NULL)`,
    // Group databases
    `CREATE TABLE IF NOT EXISTS ${p}group_records (
      gid TEXT PRIMARY KEY,
      state BLOB,
      registry_state BLOB,
      removed INTEGER,
      removal TEXT,
      disband_request TEXT,
      disband_convergence TEXT,
      disband_tombstone TEXT,
      publication TEXT,
      checkpoint TEXT
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${p}tree_nodes (
      gid TEXT NOT NULL,
      tag TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      parent_tag TEXT,
      commit_digest TEXT,
      sender_leaf_index INTEGER,
      snapshot BLOB NOT NULL,
      commit_message BLOB,
      own_commit_stamp TEXT,
      PRIMARY KEY (gid, tag)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${p}wrappers (
      gid TEXT NOT NULL,
      id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY (gid, id)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}wrappers_epoch ON ${p}wrappers (gid, epoch)`,
    `CREATE TABLE IF NOT EXISTS ${p}effects (
      gid TEXT NOT NULL,
      digest TEXT NOT NULL,
      state TEXT NOT NULL,
      direction TEXT NOT NULL,
      fork_epoch INTEGER,
      producing_epoch INTEGER,
      notifications TEXT NOT NULL,
      PRIMARY KEY (gid, digest)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}effects_state ON ${p}effects (gid, state, digest)`,
    `CREATE TABLE IF NOT EXISTS ${p}backfill (
      gid TEXT NOT NULL,
      relay TEXT NOT NULL,
      cursor INTEGER,
      progress_from INTEGER,
      progress_to INTEGER,
      PRIMARY KEY (gid, relay)
    ) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS ${p}messages (
      gid TEXT NOT NULL,
      id TEXT NOT NULL,
      kind INTEGER NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      PRIMARY KEY (gid, id)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_time ON ${p}messages (gid, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_kind ON ${p}messages (gid, kind, created_at DESC, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}messages_pubkey ON ${p}messages (gid, pubkey, created_at DESC, id)`,
    `CREATE TABLE IF NOT EXISTS ${p}message_tags (
      gid TEXT NOT NULL,
      tag TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (gid, tag, message_id)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}message_tags_message ON ${p}message_tags (gid, message_id)`,
    `CREATE TABLE IF NOT EXISTS ${p}deliveries (
      gid TEXT NOT NULL,
      id TEXT NOT NULL,
      rumor_id TEXT NOT NULL,
      state_tag TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      transport_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      evidence_envelope TEXT,
      evidence_message BLOB,
      evidence_payload BLOB,
      evidence_commit_digest TEXT,
      PRIMARY KEY (gid, id)
    ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS ${p}deliveries_rumor ON ${p}deliveries (gid, rumor_id, id)`,
    `CREATE INDEX IF NOT EXISTS ${p}deliveries_evidence ON ${p}deliveries (gid, id) WHERE evidence_envelope IS NOT NULL`,
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
    const p = this.prefix;
    this.#ready ??= (async () => {
      await this.execute(
        `CREATE TABLE IF NOT EXISTS ${p}schema (version INTEGER NOT NULL)`,
      );
      const [row] = await this.execute(
        `SELECT version FROM ${p}schema LIMIT 1`,
      );
      const version = row ? Number(row.version) : undefined;
      if (version !== undefined && version > SCHEMA_VERSION)
        throw new Error(
          `Unsupported Marmot SQLite schema version ${String(row!.version)}`,
        );
      if (version !== SCHEMA_VERSION) {
        // Older schemas predate a released format: start over.
        await this.execute("BEGIN IMMEDIATE");
        try {
          if (version !== undefined)
            for (const table of ALL_TABLES)
              await this.execute(`DROP TABLE IF EXISTS ${p}${table}`);
          for (const statement of schema(p)) await this.execute(statement);
          await this.execute(`DELETE FROM ${p}schema`);
          await this.execute(`INSERT INTO ${p}schema (version) VALUES (?)`, [
            SCHEMA_VERSION,
          ]);
          await this.execute("COMMIT");
        } catch (error) {
          await this.execute("ROLLBACK");
          throw error;
        }
      }
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

/** How each {@link GroupRecord} field maps to a `group_records` column. */
const GROUP_FIELDS: {
  [K in keyof Required<GroupRecord>]: {
    column: string;
    kind: "bytes" | "boolean" | "json";
  };
} = {
  state: { column: "state", kind: "bytes" },
  registryState: { column: "registry_state", kind: "bytes" },
  removed: { column: "removed", kind: "boolean" },
  removal: { column: "removal", kind: "json" },
  disbandRequest: { column: "disband_request", kind: "json" },
  disbandConvergence: { column: "disband_convergence", kind: "json" },
  disbandTombstone: { column: "disband_tombstone", kind: "json" },
  publication: { column: "publication", kind: "json" },
  checkpoint: { column: "checkpoint", kind: "json" },
};

function groupRecordFromRow(row: Row): GroupRecord {
  const record: Record<string, unknown> = {};
  for (const [field, { column, kind }] of Object.entries(GROUP_FIELDS)) {
    const value = row[column];
    if (isNull(value)) continue;
    record[field] =
      kind === "bytes"
        ? bytes(value)
        : kind === "boolean"
          ? Number(value) !== 0
          : fromJson(value);
  }
  return record as GroupRecord;
}

function groupFieldToColumn(
  kind: "bytes" | "boolean" | "json",
  value: unknown,
): unknown {
  if (value === null) return null;
  if (kind === "boolean") return value ? 1 : 0;
  if (kind === "json") return toJson(value);
  return value;
}

function treeNodeFromRow(row: Row): TreeNodeRow {
  const node: TreeNodeRow = {
    tag: String(row.tag),
    epoch: Number(row.epoch),
    snapshot: bytes(row.snapshot),
  };
  assign(node, "parentTag", optionalString(row.parent_tag));
  assign(node, "commitDigest", optionalString(row.commit_digest));
  assign(node, "senderLeafIndex", optionalNumber(row.sender_leaf_index));
  assign(node, "commit", optionalBytes(row.commit_message));
  assign(node, "ownCommitStamp", optionalJson(row.own_commit_stamp));
  return node;
}

function effectFromRow(row: Row): EffectRow {
  const effect: EffectRow = {
    digest: String(row.digest),
    state: String(row.state) as EffectRow["state"],
    direction: String(row.direction) as EffectRow["direction"],
    notifications: fromJson(row.notifications),
  };
  assign(effect, "forkEpoch", optionalNumber(row.fork_epoch));
  assign(effect, "producingEpoch", optionalNumber(row.producing_epoch));
  return effect;
}

function backfillFromRow(row: Row): BackfillRow {
  const backfill: BackfillRow = { relay: String(row.relay) };
  assign(backfill, "cursor", optionalNumber(row.cursor));
  if (!isNull(row.progress_from) && !isNull(row.progress_to))
    backfill.progress = {
      from: Number(row.progress_from),
      to: Number(row.progress_to),
    };
  return backfill;
}

function messageFromRow(row: Row): MessageRow {
  return {
    id: String(row.id),
    kind: Number(row.kind),
    pubkey: String(row.pubkey),
    createdAt: Number(row.created_at),
    content: String(row.content),
    tags: fromJson(row.tags),
  };
}

function deliveryFromRow(row: Row): DeliveryRow {
  const delivery: DeliveryRow = {
    id: String(row.id),
    rumorId: String(row.rumor_id),
    stateTag: String(row.state_tag),
    epoch: Number(row.epoch),
    transportId: String(row.transport_id),
    createdAt: Number(row.created_at),
  };
  if (!isNull(row.evidence_envelope)) {
    delivery.evidence = {
      envelope: fromJson(row.evidence_envelope),
      message: bytes(row.evidence_message),
      payload: bytes(row.evidence_payload),
    };
    assign(
      delivery.evidence,
      "commitDigest",
      optionalString(row.evidence_commit_digest),
    );
  }
  return delivery;
}

function groupReader(p: string, gid: string, execute: Execute): GroupReader {
  const one = async (sql: string, params: unknown[]) =>
    (await execute(sql, params))[0];
  return {
    group: async () => {
      const row = await one(`SELECT * FROM ${p}group_records WHERE gid = ?`, [
        gid,
      ]);
      return row ? groupRecordFromRow(row) : {};
    },
    treeNodes: {
      get: async (tag) => {
        const row = await one(
          `SELECT * FROM ${p}tree_nodes WHERE gid = ? AND tag = ?`,
          [gid, tag],
        );
        return row ? treeNodeFromRow(row) : undefined;
      },
    },
    wrappers: {
      get: async (id) => {
        const row = await one(
          `SELECT epoch, outcome FROM ${p}wrappers WHERE gid = ? AND id = ?`,
          [gid, id],
        );
        return row
          ? {
              id,
              epoch: Number(row.epoch),
              outcome: String(row.outcome) as WrapperRow["outcome"],
            }
          : undefined;
      },
    },
    effects: {
      get: async (digest) => {
        const row = await one(
          `SELECT * FROM ${p}effects WHERE gid = ? AND digest = ?`,
          [gid, digest],
        );
        return row ? effectFromRow(row) : undefined;
      },
      byState: async (state) =>
        (
          await execute(
            `SELECT * FROM ${p}effects WHERE gid = ? AND state = ? ORDER BY digest`,
            [gid, state],
          )
        ).map(effectFromRow),
    },
    backfill: {
      get: async (relay) => {
        const row = await one(
          `SELECT * FROM ${p}backfill WHERE gid = ? AND relay = ?`,
          [gid, relay],
        );
        return row ? backfillFromRow(row) : undefined;
      },
    },
    messages: {
      get: async (id) => {
        const row = await one(
          `SELECT * FROM ${p}messages WHERE gid = ? AND id = ?`,
          [gid, id],
        );
        return row ? messageFromRow(row) : undefined;
      },
      query: async (query: MessageQuery) => {
        const where = ["m.gid = ?"];
        const params: unknown[] = [gid];
        const list = (column: string, values: readonly unknown[]) => {
          where.push(
            values.length ? `${column} IN (${placeholders(values)})` : "0",
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
        for (const alternatives of queryTagKeys(query)) {
          where.push(
            alternatives.length
              ? `EXISTS (SELECT 1 FROM ${p}message_tags t WHERE t.gid = m.gid AND t.message_id = m.id AND t.tag IN (${placeholders(alternatives)}))`
              : "0",
          );
          params.push(...alternatives);
        }
        let sql = `SELECT m.* FROM ${p}messages m WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id ASC`;
        if (query.limit !== undefined) {
          sql += " LIMIT ?";
          params.push(query.limit);
        }
        return (await execute(sql, params)).map(messageFromRow);
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
        const row = await one(
          `SELECT COUNT(*) AS n FROM ${p}deliveries WHERE gid = ? AND rumor_id = ?`,
          [gid, rumorId],
        );
        return Number(row?.n ?? 0);
      },
      withEvidence: async () =>
        (
          await execute(
            `SELECT * FROM ${p}deliveries WHERE gid = ? AND evidence_envelope IS NOT NULL ORDER BY id`,
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
  const remove = async (table: string, column: string, key: string) => {
    await execute(`DELETE FROM ${p}${table} WHERE gid = ? AND ${column} = ?`, [
      gid,
      key,
    ]);
  };
  return {
    ...reader,
    updateGroup: async (update: GroupRecordUpdate) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of Object.entries(update)) {
        if (value === undefined) continue;
        const spec = GROUP_FIELDS[field as keyof GroupRecord];
        if (!spec) throw new Error(`Unknown group record field ${field}`);
        sets.push(`${spec.column} = ?`);
        params.push(groupFieldToColumn(spec.kind, value));
      }
      if (!sets.length) return;
      await execute(
        `INSERT OR IGNORE INTO ${p}group_records (gid) VALUES (?)`,
        [gid],
      );
      await execute(
        `UPDATE ${p}group_records SET ${sets.join(", ")} WHERE gid = ?`,
        [...params, gid],
      );
    },
    treeNodes: {
      ...reader.treeNodes,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}tree_nodes (gid, tag, epoch, parent_tag, commit_digest, sender_leaf_index, snapshot, commit_message, own_commit_stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gid,
            row.tag,
            row.epoch,
            row.parentTag ?? null,
            row.commitDigest ?? null,
            row.senderLeafIndex ?? null,
            row.snapshot,
            row.commit ?? null,
            row.ownCommitStamp ? toJson(row.ownCommitStamp) : null,
          ],
        );
      },
      delete: (tag) => remove("tree_nodes", "tag", tag),
    },
    wrappers: {
      ...reader.wrappers,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}wrappers (gid, id, epoch, outcome) VALUES (?, ?, ?, ?)`,
          [gid, row.id, row.epoch, row.outcome],
        );
      },
      deleteBelow: async (floor, except = []) => {
        const keep = except.length
          ? ` AND id NOT IN (${placeholders(except)})`
          : "";
        await execute(
          `DELETE FROM ${p}wrappers WHERE gid = ? AND epoch < ?${keep}`,
          [gid, floor, ...except],
        );
      },
    },
    effects: {
      ...reader.effects,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}effects (gid, digest, state, direction, fork_epoch, producing_epoch, notifications) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            gid,
            row.digest,
            row.state,
            row.direction,
            row.forkEpoch ?? null,
            row.producingEpoch ?? null,
            toJson(row.notifications),
          ],
        );
      },
      delete: (digest) => remove("effects", "digest", digest),
    },
    backfill: {
      ...reader.backfill,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}backfill (gid, relay, cursor, progress_from, progress_to) VALUES (?, ?, ?, ?, ?)`,
          [
            gid,
            row.relay,
            row.cursor ?? null,
            row.progress?.from ?? null,
            row.progress?.to ?? null,
          ],
        );
      },
      delete: (relay) => remove("backfill", "relay", relay),
    },
    messages: {
      ...reader.messages,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}messages (gid, id, kind, pubkey, created_at, content, tags) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            gid,
            row.id,
            row.kind,
            row.pubkey,
            row.createdAt,
            row.content,
            toJson(row.tags),
          ],
        );
        await remove("message_tags", "message_id", row.id);
        for (const tag of indexTags(row.tags))
          await execute(
            `INSERT INTO ${p}message_tags (gid, tag, message_id) VALUES (?, ?, ?)`,
            [gid, tag, row.id],
          );
      },
      delete: async (id) => {
        await remove("messages", "id", id);
        await remove("message_tags", "message_id", id);
      },
    },
    deliveries: {
      ...reader.deliveries,
      put: async (row) => {
        const evidence = row.evidence;
        await execute(
          `INSERT OR REPLACE INTO ${p}deliveries (gid, id, rumor_id, state_tag, epoch, transport_id, created_at, evidence_envelope, evidence_message, evidence_payload, evidence_commit_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            gid,
            row.id,
            row.rumorId,
            row.stateTag,
            row.epoch,
            row.transportId,
            row.createdAt,
            evidence ? toJson(evidence.envelope) : null,
            evidence?.message ?? null,
            evidence?.payload ?? null,
            evidence?.commitDigest ?? null,
          ],
        );
      },
      delete: (id) => remove("deliveries", "id", id),
    },
  };
}

class SQLiteGroupDatabase implements MarmotGroupDatabase {
  readonly group: GroupReader["group"];
  readonly treeNodes: GroupReader["treeNodes"];
  readonly wrappers: GroupReader["wrappers"];
  readonly effects: GroupReader["effects"];
  readonly backfill: GroupReader["backfill"];
  readonly messages: GroupReader["messages"];
  readonly deliveries: GroupReader["deliveries"];

  constructor(
    readonly lane: Lane,
    readonly gid: string,
  ) {
    const read = <T>(fn: (reader: GroupReader) => Promise<T>) =>
      lane.run(false, (execute) => fn(groupReader(lane.prefix, gid, execute)));
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

function keyPackageFromRow(row: Row): KeyPackageRow {
  const keyPackage: KeyPackageRow = {
    ref: String(row.ref),
    publicPackage: bytes(row.public_package),
    notBefore: Number(row.not_before),
    used: Number(row.used) !== 0,
    published: fromJson(row.published),
    consumptionReceipts: fromJson(row.consumption_receipts),
  };
  assign(keyPackage, "privatePackage", optionalBytes(row.private_package));
  assign(keyPackage, "identifier", optionalString(row.identifier));
  assign(keyPackage, "relays", optionalJson<string[]>(row.relays));
  return keyPackage;
}

function inviteFromRow(row: Row): InviteRow {
  const invite: InviteRow = {
    id: String(row.id),
    state: String(row.state) as InviteRow["state"],
    receivedAt: Number(row.received_at),
  };
  assign(invite, "rumorId", optionalString(row.rumor_id));
  assign(invite, "giftwrap", optionalJson(row.giftwrap));
  assign(invite, "rumor", optionalJson(row.rumor));
  assign(invite, "attempted", optionalBoolean(row.attempted));
  assign(invite, "invalid", optionalBoolean(row.invalid));
  return invite;
}

const groupFromRow = (row: Row): GroupRow => ({
  id: String(row.id),
  status: String(row.status) as GroupRow["status"],
});

const intentFromRow = (row: Row): IntentRow => ({
  id: String(row.id),
  kind: String(row.kind) as IntentRow["kind"],
  groupId: String(row.group_id),
});

const booleanColumn = (value: boolean | undefined) =>
  value === undefined ? null : value ? 1 : 0;

function accountReader(p: string, execute: Execute): AccountReader {
  const one = async (sql: string, params: unknown[]) =>
    (await execute(sql, params))[0];
  return {
    keyPackages: {
      get: async (ref) => {
        const row = await one(`SELECT * FROM ${p}key_packages WHERE ref = ?`, [
          ref,
        ]);
        return row ? keyPackageFromRow(row) : undefined;
      },
      all: async () =>
        (await execute(`SELECT * FROM ${p}key_packages ORDER BY ref`)).map(
          keyPackageFromRow,
        ),
    },
    invites: {
      get: async (id) => {
        const row = await one(`SELECT * FROM ${p}invites WHERE id = ?`, [id]);
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
        const row = await one(
          `SELECT * FROM ${p}invites WHERE rumor_id = ? ORDER BY id LIMIT 1`,
          [rumorId],
        );
        return row ? inviteFromRow(row) : undefined;
      },
    },
    groups: {
      get: async (id) => {
        const row = await one(`SELECT * FROM ${p}groups WHERE id = ?`, [id]);
        return row ? groupFromRow(row) : undefined;
      },
      all: async () =>
        (await execute(`SELECT * FROM ${p}groups ORDER BY id`)).map(
          groupFromRow,
        ),
    },
    intents: {
      all: async () =>
        (await execute(`SELECT * FROM ${p}intents ORDER BY id`)).map(
          intentFromRow,
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
    keyPackages: {
      ...reader.keyPackages,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}key_packages (ref, public_package, private_package, identifier, not_before, used, published, relays, consumption_receipts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.ref,
            row.publicPackage,
            row.privatePackage ?? null,
            row.identifier ?? null,
            row.notBefore,
            row.used ? 1 : 0,
            toJson(row.published),
            row.relays ? toJson(row.relays) : null,
            toJson(row.consumptionReceipts),
          ],
        );
      },
      delete: (ref) => remove("key_packages", "ref", ref),
    },
    invites: {
      ...reader.invites,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}invites (id, state, rumor_id, received_at, giftwrap, rumor, attempted, invalid) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.state,
            row.rumorId ?? null,
            row.receivedAt,
            row.giftwrap ? toJson(row.giftwrap) : null,
            row.rumor ? toJson(row.rumor) : null,
            booleanColumn(row.attempted),
            booleanColumn(row.invalid),
          ],
        );
      },
      delete: (id) => remove("invites", "id", id),
    },
    groups: {
      ...reader.groups,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}groups (id, status) VALUES (?, ?)`,
          [row.id, row.status],
        );
      },
      delete: (id) => remove("groups", "id", id),
    },
    intents: {
      ...reader.intents,
      put: async (row) => {
        await execute(
          `INSERT OR REPLACE INTO ${p}intents (id, kind, group_id) VALUES (?, ?, ?)`,
          [row.id, row.kind, row.groupId],
        );
      },
      delete: (id) => remove("intents", "id", id),
    },
  };
}

class SQLiteAccountDatabase implements MarmotAccountDatabase {
  readonly keyPackages: AccountReader["keyPackages"];
  readonly invites: AccountReader["invites"];
  readonly groups: AccountReader["groups"];
  readonly intents: AccountReader["intents"];

  constructor(readonly lane: Lane) {
    const read = <T>(fn: (reader: AccountReader) => Promise<T>) =>
      lane.run(false, (execute) => fn(accountReader(lane.prefix, execute)));
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
