/** @module @category Storage */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { IAsyncEventDatabase } from "applesauce-core/event-store";
import {
  getReplaceableIdentifier,
  isAddressableKind,
} from "applesauce-core/helpers/event";
import { matchFilters, type Filter } from "applesauce-core/helpers/filter";
import type { MarmotGroupDatabase, MessageQuery, MessageRow } from "./types.js";

/** The message row of a rumor. */
export function messageRow(rumor: Rumor): MessageRow {
  return {
    id: rumor.id,
    kind: rumor.kind,
    pubkey: rumor.pubkey,
    createdAt: rumor.created_at,
    content: rumor.content,
    tags: rumor.tags.map((tag) => [...tag]),
  };
}

/** The rumor stored in a message row. */
export function rumorOfRow(row: MessageRow): Rumor {
  return {
    id: row.id,
    kind: row.kind,
    pubkey: row.pubkey,
    created_at: row.createdAt,
    content: row.content,
    tags: row.tags,
  } as Rumor;
}

/**
 * Translates one NIP-01 filter into an index query. `exact` is false when the
 * filter has clauses the query cannot express (`search`, `&` tags, multi-letter
 * tags); callers then post-filter.
 */
export function filterToQuery(filter: Filter): {
  query: MessageQuery;
  exact: boolean;
} {
  const query: MessageQuery = {};
  let exact = true;
  const tags: Record<string, string[]> = {};
  let tagged = false;
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    switch (key) {
      case "ids":
        query.ids = value as string[];
        break;
      case "kinds":
        query.kinds = value as number[];
        break;
      case "authors":
        query.authors = value as string[];
        break;
      case "since":
        query.since = value as number;
        break;
      case "until":
        query.until = value as number;
        break;
      case "limit":
        break;
      default:
        if (key.startsWith("#") && key.length === 2) {
          tags[key[1]!] = value as string[];
          tagged = true;
        } else exact = false;
    }
  }
  if (tagged) query.tags = tags;
  // A post-filtered query cannot apply its limit inside the database.
  if (exact && filter.limit !== undefined) query.limit = filter.limit;
  return { query, exact };
}

/**
 * Exposes a group database's `messages` table as an applesauce
 * `IAsyncEventDatabase<Rumor>`, for `AsyncRumorStore` and applesauce models.
 *
 * The group session writes message rows inside its own transactions; `add`
 * here only inserts rumors the table does not already hold, and `remove`
 * reports success once the rumor is absent.
 */
export class GroupMessageDatabase implements IAsyncEventDatabase<Rumor> {
  constructor(readonly database: MarmotGroupDatabase) {}

  async #query(filters: Filter | Filter[]): Promise<Rumor[]> {
    const list = Array.isArray(filters) ? filters : [filters];
    const byId = new Map<string, Rumor>();
    for (const filter of list) {
      const { query, exact } = filterToQuery(filter);
      let rumors = (await this.database.messages.query(query)).map(rumorOfRow);
      if (!exact) {
        rumors = rumors.filter((rumor) => matchFilters([filter], rumor));
        if (filter.limit !== undefined) rumors = rumors.slice(0, filter.limit);
      }
      for (const rumor of rumors) byId.set(rumor.id, rumor);
    }
    return [...byId.values()];
  }

  async hasEvent(id: string): Promise<boolean> {
    return (await this.database.messages.get(id)) !== undefined;
  }

  async getEvent(id: string): Promise<Rumor | undefined> {
    const row = await this.database.messages.get(id);
    return row && rumorOfRow(row);
  }

  #replaceableFilter(
    kind: number,
    pubkey: string,
    identifier?: string,
  ): Filter {
    const filter: Filter = { kinds: [kind], authors: [pubkey] };
    if (isAddressableKind(kind)) filter["#d"] = [identifier ?? ""];
    return filter;
  }

  async hasReplaceable(
    kind: number,
    pubkey: string,
    identifier?: string,
  ): Promise<boolean> {
    return (await this.getReplaceable(kind, pubkey, identifier)) !== undefined;
  }

  async getReplaceable(
    kind: number,
    pubkey: string,
    identifier?: string,
  ): Promise<Rumor | undefined> {
    return (await this.getReplaceableHistory(kind, pubkey, identifier))?.[0];
  }

  async getReplaceableHistory(
    kind: number,
    pubkey: string,
    identifier?: string,
  ): Promise<Rumor[] | undefined> {
    const rumors = (
      await this.getTimeline(this.#replaceableFilter(kind, pubkey, identifier))
    ).filter(
      (rumor) =>
        !isAddressableKind(kind) ||
        getReplaceableIdentifier(rumor) === (identifier ?? ""),
    );
    return rumors.length ? rumors : undefined;
  }

  getByFilters(filters: Filter | Filter[]): Promise<Rumor[]> {
    return this.#query(filters);
  }

  async getTimeline(filters: Filter | Filter[]): Promise<Rumor[]> {
    return (await this.#query(filters)).sort(
      (a, b) =>
        b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  async add(rumor: Rumor): Promise<Rumor> {
    await this.database.transaction(async (tx) => {
      if (!(await tx.messages.get(rumor.id)))
        await tx.messages.put(messageRow(rumor));
    });
    return rumor;
  }

  async remove(rumor: string | Rumor): Promise<boolean> {
    const id = typeof rumor === "string" ? rumor : rumor.id;
    await this.database.transaction((tx) => tx.messages.delete(id));
    return true;
  }

  async removeByFilters(filters: Filter | Filter[]): Promise<number> {
    const rumors = await this.#query(filters);
    if (!rumors.length) return 0;
    await this.database.transaction(async (tx) => {
      for (const rumor of rumors) await tx.messages.delete(rumor.id);
    });
    return rumors.length;
  }
}
