import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
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

it.skipIf(!sqlite)(
  "preserves the Welcome adoption marker across state updates and reopen",
  async () => {
    const file = join(dir, `adoption${counter++}.sqlite`);
    const database = sqliteDatabase(connect(file));
    const group = await database.groups.open("group");
    await group.transaction((tx) =>
      tx.updateGroup({
        state: new Uint8Array([1]),
        adoptionIds: ["ab".repeat(32)],
      }),
    );
    await group.transaction((tx) =>
      tx.updateGroup({ state: new Uint8Array([2]) }),
    );
    const reopened = await sqliteDatabase(connect(file)).groups.open("group");
    expect(await reopened.group()).toEqual({
      state: new Uint8Array([2]),
      adoptionIds: ["ab".repeat(32)],
    });
  },
);

it.skipIf(!sqlite)(
  "adds Welcome adoption markers to schema v2 without deleting stored state",
  async () => {
    const file = join(dir, `migration${counter++}.sqlite`);
    const connection = connect(file);
    await connection.execute(
      "CREATE TABLE marmot_schema (version INTEGER NOT NULL)",
    );
    await connection.execute("INSERT INTO marmot_schema VALUES (2)");
    await connection.execute(`CREATE TABLE marmot_group_records (
    gid TEXT PRIMARY KEY, state BLOB, registry_state BLOB, removed INTEGER,
    removal TEXT, disband_request TEXT, disband_convergence TEXT,
    disband_tombstone TEXT, publication TEXT, checkpoint TEXT
  ) WITHOUT ROWID`);
    await connection.execute(
      "INSERT INTO marmot_group_records (gid, state) VALUES (?, ?)",
      ["group", new Uint8Array([1])],
    );
    const group = await sqliteDatabase(connection).groups.open("group");
    expect(await group.group()).toEqual({ state: new Uint8Array([1]) });
    await group.transaction((tx) =>
      tx.updateGroup({ adoptionIds: ["cd".repeat(32)] }),
    );
    expect((await group.group()).adoptionIds).toEqual(["cd".repeat(32)]);
    expect(
      await connection.execute("SELECT version FROM marmot_schema"),
    ).toEqual([{ version: 3 }]);
  },
);
