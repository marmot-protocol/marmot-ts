import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClientState } from "ts-mls";
import type { HistoryTreeStore } from "../../engine/history-tree-store.js";
import {
  groupMetaStore,
  groupTreeStore,
  type GroupMetaStore,
} from "../../client/storage/database/group-batch.js";
import {
  memoryDatabase,
  memoryGroupDatabase,
} from "../../client/storage/database/memory.js";
import type {
  MarmotDatabase,
  MarmotGroupDatabase,
} from "../../client/storage/database/types.js";

export { memoryDatabase, memoryGroupDatabase };

/** A fresh in-memory history-tree store (engine tests). */
export function memoryTreeStore(
  db: MarmotGroupDatabase = memoryGroupDatabase(),
): HistoryTreeStore {
  return groupTreeStore(db);
}

/** Opens a group's database in a client database. */
export function openGroup(
  database: MarmotDatabase,
  group: Uint8Array | string | ClientState,
): Promise<MarmotGroupDatabase> {
  const id =
    typeof group === "string"
      ? group
      : group instanceof Uint8Array
        ? bytesToHex(group)
        : bytesToHex(group.groupContext.groupId);
  return database.groups.open(id);
}

/** The `meta` table of a group in a client database. */
export async function groupMeta(
  database: MarmotDatabase,
  group: Uint8Array | string | ClientState,
): Promise<GroupMetaStore> {
  return groupMetaStore(await openGroup(database, group));
}
