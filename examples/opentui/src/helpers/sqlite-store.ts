import type { Database } from "bun:sqlite";

/**
 * A persistent key-value backend (shaped like marmot-ts `GenericKeyValueStore`)
 * backed by a single `bun:sqlite` table. Many of these share one {@link Database}
 * connection — each instance owns one `(key TEXT PRIMARY KEY, value TEXT)` table.
 *
 * Marmot group state is a raw `Uint8Array` and key-package material holds nested
 * `Uint8Array`s, neither of which round-trips through plain JSON. We tag both
 * `Uint8Array` (base64) and `bigint` on write and restore them on read — the
 * same encoding the old JSON file store used — and persist the tagged JSON in a
 * TEXT column. Unlike the JSON store, mutations are O(1) upserts/deletes rather
 * than a full-file rewrite, and writes are durable per statement.
 */
export class SqliteKeyValueStore<T> {
  readonly #get: ReturnType<Database["query"]>;
  readonly #set: ReturnType<Database["query"]>;
  readonly #del: ReturnType<Database["query"]>;
  readonly #clear: ReturnType<Database["query"]>;
  readonly #keys: ReturnType<Database["query"]>;

  constructor(db: Database, table: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`invalid sqlite table name: ${table}`);
    }
    db.run(
      `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.#get = db.query(`SELECT value FROM "${table}" WHERE key = ?`);
    this.#set = db.query(
      `INSERT INTO "${table}" (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.#del = db.query(`DELETE FROM "${table}" WHERE key = ?`);
    this.#clear = db.query(`DELETE FROM "${table}"`);
    this.#keys = db.query(`SELECT key FROM "${table}"`);
  }

  async getItem(key: string): Promise<T | null> {
    const row = this.#get.get(key) as { value: string } | null;
    return row ? (JSON.parse(row.value, reviver) as T) : null;
  }

  async setItem(key: string, value: T): Promise<T> {
    this.#set.run(key, JSON.stringify(value, replacer));
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.#del.run(key);
  }

  async clear(): Promise<void> {
    this.#clear.run();
  }

  async keys(): Promise<string[]> {
    return (this.#keys.all() as { key: string }[]).map((row) => row.key);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __u8a__: Buffer.from(value).toString("base64") };
  }
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const tagged = value as { __u8a__?: unknown; __bigint__?: unknown };
    if (typeof tagged.__u8a__ === "string") {
      return new Uint8Array(Buffer.from(tagged.__u8a__, "base64"));
    }
    if (typeof tagged.__bigint__ === "string") {
      return BigInt(tagged.__bigint__);
    }
  }
  return value;
}
