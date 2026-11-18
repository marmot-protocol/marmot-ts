import type { Database } from "bun:sqlite";
import type { MarmotStorage, StorageOp } from "@internet-privacy/marmot-ts";

/**
 * A durable {@link MarmotStorage} over one `bun:sqlite` table of
 * `(key TEXT PRIMARY KEY, value BLOB)`. `batch` runs in a transaction, so a
 * crash applies all of it or none of it.
 */
export function sqliteStorage(db: Database, table = "kv"): MarmotStorage {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
    throw new Error(`invalid sqlite table name: ${table}`);
  db.run(
    `CREATE TABLE IF NOT EXISTS "${table}" (key TEXT PRIMARY KEY, value BLOB NOT NULL)`,
  );
  const get = db.query(`SELECT value FROM "${table}" WHERE key = ?`);
  const put = db.query(
    `INSERT INTO "${table}" (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const del = db.query(`DELETE FROM "${table}" WHERE key = ?`);
  // Keys are ASCII, so every key with the prefix sorts in [prefix, prefix + U+FFFF).
  const list = db.query(
    `SELECT key FROM "${table}" WHERE key >= ? AND key < ? ORDER BY key`,
  );
  const apply = db.transaction((ops: readonly StorageOp[]) => {
    for (const op of ops)
      if (op.type === "set") put.run(op.key, op.value);
      else del.run(op.key);
  });

  return {
    async get(key) {
      const row = get.get(key) as { value: Uint8Array } | null;
      return row ? new Uint8Array(row.value) : undefined;
    },
    async set(key, value) {
      put.run(key, value);
    },
    async delete(key) {
      del.run(key);
    },
    async list(prefix) {
      return (list.all(prefix, prefix + "￿") as { key: string }[]).map(
        (row) => row.key,
      );
    },
    async batch(ops) {
      apply(ops);
    },
  };
}
