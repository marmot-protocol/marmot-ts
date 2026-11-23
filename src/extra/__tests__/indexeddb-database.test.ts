import "fake-indexeddb/auto";
import { runDatabaseConformance } from "../../client/storage/database/__tests__/conformance.js";
import { indexedDBDatabase } from "../indexeddb-database.js";

let counter = 0;

runDatabaseConformance(
  "indexeddb",
  async () => indexedDBDatabase({ prefix: `t${counter++}` }),
  async () => indexedDBDatabase({ prefix: `t${counter - 1}` }),
  { requireInspection: true },
);
