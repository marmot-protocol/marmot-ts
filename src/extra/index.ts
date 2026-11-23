/**
 * Storage adapters for `MarmotDatabase`: IndexedDB for browsers and
 * SQLite for any driver that can run a statement. Neither encrypts at rest.
 *
 * @module
 */
export {
  indexedDBDatabase,
  type IndexedDBDatabaseOptions,
} from "./indexeddb-database.js";
export {
  sqliteDatabase,
  type SQLiteConnection,
  type SQLiteDatabaseOptions,
} from "./sqlite-database.js";
