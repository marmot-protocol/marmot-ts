import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { runDatabaseConformance } from "../../client/storage/database/__tests__/conformance.js";
import { indexedDBDatabase } from "../indexeddb-database.js";

let counter = 0;
const factory = new IDBFactory();

runDatabaseConformance(
  "indexeddb",
  async () =>
    indexedDBDatabase({
      indexedDB: factory,
      keyRange: IDBKeyRange,
      prefix: `t${counter++}`,
    }),
  async () =>
    indexedDBDatabase({
      indexedDB: factory,
      keyRange: IDBKeyRange,
      prefix: `t${counter - 1}`,
    }),
  { requireInspection: true },
);
