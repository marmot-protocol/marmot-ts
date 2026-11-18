import type { Database } from "bun:sqlite";
import type { MarmotRumorDatabases } from "@internet-privacy/marmot-ts";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  RumorStore,
  type IAsyncEventDatabase,
} from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers/filter";

/**
 * Per-group rumor databases persisted to one `bun:sqlite` table.
 *
 * Each group's rumors are loaded into an in-memory applesauce database on
 * first use (fine for a terminal demo); every add/remove is written through
 * to SQLite. A browser app would use an IndexedDB-backed database instead.
 */
export function sqliteRumorDatabases(db: Database): MarmotRumorDatabases {
  db.run(
    `CREATE TABLE IF NOT EXISTS rumors (
       gid TEXT NOT NULL, id TEXT NOT NULL, rumor TEXT NOT NULL,
       PRIMARY KEY (gid, id))`,
  );
  const load = db.query(`SELECT rumor FROM rumors WHERE gid = ?`);
  const insert = db.query(
    `INSERT OR REPLACE INTO rumors (gid, id, rumor) VALUES (?, ?, ?)`,
  );
  const remove = db.query(`DELETE FROM rumors WHERE gid = ? AND id = ?`);
  const drop = db.query(`DELETE FROM rumors WHERE gid = ?`);

  const open = (gid: string): IAsyncEventDatabase<Rumor> => {
    const memory = new RumorStore().database;
    for (const row of load.all(gid) as { rumor: string }[])
      memory.add(JSON.parse(row.rumor) as Rumor);
    const idOf = (event: string | Rumor) =>
      typeof event === "string" ? event : event.id;
    return {
      hasEvent: async (id) => memory.hasEvent(id),
      getEvent: async (id) => memory.getEvent(id),
      hasReplaceable: async (kind, pubkey, d) =>
        memory.hasReplaceable(kind, pubkey, d),
      getReplaceable: async (kind, pubkey, d) =>
        memory.getReplaceable(kind, pubkey, d),
      getReplaceableHistory: async (kind, pubkey, d) =>
        memory.getReplaceableHistory(kind, pubkey, d),
      getByFilters: async (filters: Filter | Filter[]) =>
        memory.getByFilters(filters),
      getTimeline: async (filters: Filter | Filter[]) =>
        memory.getTimeline(filters),
      async add(rumor) {
        insert.run(gid, rumor.id, JSON.stringify(rumor));
        return memory.add(rumor);
      },
      async remove(event) {
        remove.run(gid, idOf(event));
        return memory.remove(event);
      },
      async removeByFilters(filters) {
        for (const rumor of memory.getByFilters(filters))
          remove.run(gid, rumor.id);
        return memory.removeByFilters(filters);
      },
    };
  };

  return Object.assign(open, {
    drop: async (gid: string) => {
      drop.run(gid);
    },
  });
}
