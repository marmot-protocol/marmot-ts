import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { runDatabaseConformance } from "../../client/storage/database/__tests__/conformance.js";
import { sqliteDatabase, type SQLiteConnection } from "../sqlite-database.js";

type NodeSqlite = typeof import("node:sqlite");

let sqlite: NodeSqlite | undefined;
try {
  sqlite = await import("node:sqlite");
} catch {
  // Runtime without node:sqlite: the adapter is exercised elsewhere.
}

const dir = mkdtempSync(join(tmpdir(), "marmot-sqlite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A {@link SQLiteConnection} over a `node:sqlite` database file. */
function connect(file: string): SQLiteConnection {
  const db = new sqlite!.DatabaseSync(file);
  return {
    execute(sql, params = []) {
      const statement = db.prepare(sql);
      const args = params as (string | number | null | Uint8Array)[];
      if (/^\s*(SELECT|WITH)/i.test(sql))
        return statement.all(...args) as Record<string, unknown>[];
      statement.run(...args);
      return [];
    },
  };
}

let counter = 0;
if (sqlite)
  runDatabaseConformance(
    "sqlite",
    async () => sqliteDatabase(connect(join(dir, `db${counter++}.sqlite`))),
    async () => sqliteDatabase(connect(join(dir, `db${counter - 1}.sqlite`))),
    { requireInspection: true },
  );
