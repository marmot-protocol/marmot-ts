import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { bytesToHex } from "applesauce-core/helpers";
import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { MarmotGroupHistoryStoreBackend } from "marmot-ts/store";

import type { OuterCursor } from "marmot-ts";
import { compareCursor } from "marmot-ts";

const DB_VERSION = 2;
const RUMOR_STORE = "rumors";
const RUMOR_BY_OUTER_INDEX = "by_group_outer_cursor";

const OUTER_STORE = "processed_outer_events";
const OUTER_BY_CURSOR_INDEX = "by_group_outer_cursor";

interface StoredRumor {
  groupId: string;
  rumor_created_at: number;
  rumor_id: string;
  rumor: Rumor;

  outer_created_at: number;
  outer_event_id: string;
}

interface StoredOuterEvent {
  groupId: string;
  outer_created_at: number;
  outer_event_id: string;
}

interface GroupHistoryDB extends DBSchema {
  [RUMOR_STORE]: {
    value: StoredRumor;
    key: [string, string];
    indexes: {
      [RUMOR_BY_OUTER_INDEX]: [string, number, string];
    };
  };

  [OUTER_STORE]: {
    value: StoredOuterEvent;
    key: [string, string];
    indexes: {
      [OUTER_BY_CURSOR_INDEX]: [string, number, string];
    };
  };
}

/**
 * IndexedDB-backed implementation of {@link MarmotGroupHistoryStoreBackend}.
 * Stores and retrieves group history (MIP-03 rumors) using the `idb` package.
 */
export class IdbGroupHistoryStore implements MarmotGroupHistoryStoreBackend {
  private name: string;

  private dbPromise: Promise<IDBPDatabase<GroupHistoryDB>> | null = null;
  private async getDB(): Promise<IDBPDatabase<GroupHistoryDB>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<GroupHistoryDB>(this.name, DB_VERSION, {
        upgrade(db) {
          const rumorStore = db.createObjectStore(RUMOR_STORE, {
            keyPath: ["groupId", "rumor_id"],
          });
          rumorStore.createIndex(RUMOR_BY_OUTER_INDEX, [
            "groupId",
            "outer_created_at",
            "outer_event_id",
          ]);

          const outerStore = db.createObjectStore(OUTER_STORE, {
            keyPath: ["groupId", "outer_event_id"],
          });
          outerStore.createIndex(OUTER_BY_CURSOR_INDEX, [
            "groupId",
            "outer_created_at",
            "outer_event_id",
          ]);
        },
      });
    }
    return this.dbPromise;
  }

  constructor(name: string) {
    this.name = name;
  }

  async markOuterEventProcessed(
    groupId: Uint8Array,
    outer: OuterCursor,
  ): Promise<void> {
    const db = await this.getDB();
    const groupKey = bytesToHex(groupId);
    const entry: StoredOuterEvent = {
      groupId: groupKey,
      outer_created_at: outer.created_at,
      outer_event_id: outer.id,
    };
    await db.put(OUTER_STORE, entry);
  }

  async getResumeCursor(groupId: Uint8Array): Promise<OuterCursor | null> {
    const db = await this.getDB();
    const groupKey = bytesToHex(groupId);

    const range = IDBKeyRange.bound(
      [groupKey, 0, ""],
      [groupKey, Number.MAX_SAFE_INTEGER, "~"],
    );
    const tx = db.transaction(OUTER_STORE, "readonly");
    const index = tx.objectStore(OUTER_STORE).index(OUTER_BY_CURSOR_INDEX);
    const cursor = await index.openCursor(range, "prev");
    if (!cursor) return null;

    const value = cursor.value as StoredOuterEvent;
    return {
      created_at: value.outer_created_at,
      id: value.outer_event_id,
    };
  }

  async addRumor(
    groupId: Uint8Array,
    entry: { rumor: Rumor; outer: OuterCursor },
  ): Promise<void> {
    const db = await this.getDB();
    const groupKey = bytesToHex(groupId);

    const row: StoredRumor = {
      groupId: groupKey,
      rumor_created_at: entry.rumor.created_at,
      rumor_id: entry.rumor.id,
      rumor: entry.rumor,
      outer_created_at: entry.outer.created_at,
      outer_event_id: entry.outer.id,
    };

    // Idempotent on rumor id.
    await db.put(RUMOR_STORE, row);

    // Also record the outer event as processed (idempotent on outer id).
    await this.markOuterEventProcessed(groupId, entry.outer);
  }

  async queryRumors(
    groupId: Uint8Array,
    filter: { until?: OuterCursor; limit?: number },
  ): Promise<Rumor[]> {
    const db = await this.getDB();
    const groupKey = bytesToHex(groupId);
    const { until, limit } = filter;

    // Query newest-first by outer cursor.
    // If `until` is provided, return items strictly older than `until`.
    const range = until
      ? IDBKeyRange.upperBound([groupKey, until.created_at, until.id], true)
      : IDBKeyRange.bound(
          [groupKey, 0, ""],
          [groupKey, Number.MAX_SAFE_INTEGER, "~"],
        );

    const tx = db.transaction(RUMOR_STORE, "readonly");
    const index = tx.objectStore(RUMOR_STORE).index(RUMOR_BY_OUTER_INDEX);
    const cursor = await index.openCursor(range, "prev");

    const rumors: Rumor[] = [];
    let cur = cursor;
    while (cur && (limit === undefined || rumors.length < limit)) {
      const value = cur.value as StoredRumor;
      rumors.push(value.rumor);
      cur = await cur.continue();
    }

    // Defensive: ensure stable ordering (by rumor created_at/id) for rendering.
    // IndexedDB index already orders by outer cursor, but sorting here guarantees
    // deterministic output if backends change.
    rumors.sort((a, b) => {
      // emulate MIP-03 tie-breaker on the rumor cursor
      const ca: OuterCursor = { created_at: a.created_at, id: a.id };
      const cb: OuterCursor = { created_at: b.created_at, id: b.id };
      return compareCursor(ca, cb);
    });

    return rumors;
  }
}
