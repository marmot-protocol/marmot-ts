/** @module @category Client - Group History */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import {
  AsyncRumorStore,
  RumorStore,
  type IAsyncEventDatabase,
} from "applesauce-core/event-store";
import type { Filter } from "applesauce-core/helpers/filter";
import { compileFilters } from "applesauce-core/helpers/filter";
import { EventEmitter } from "eventemitter3";
import { deserializeApplicationData } from "../../core/group-message.js";
import { watchCurrent } from "../../utils/watch-current.js";

/**
 * Per-group rumor databases supplied by the app.
 *
 * Return an applesauce `IAsyncEventDatabase<Rumor>` scoped to exactly one
 * group, or `undefined` to keep that group's history in memory. The library
 * wraps each database in its own `AsyncRumorStore`. Writes must resolve only
 * once committed. The library never closes the database.
 *
 * MLS forward secrecy means processed messages cannot be fetched and decrypted
 * again: history kept in memory is lost on restart.
 */
export interface MarmotRumorDatabases {
  (groupId: string): IAsyncEventDatabase<Rumor> | undefined;
  /** Deletes a group's persisted rumors after the group is destroyed. */
  drop?(groupId: string): Promise<void>;
}

/** The rumor store behind a {@link GroupHistory}. */
export type GroupRumorStore = RumorStore | AsyncRumorStore;

/** Events emitted by {@link GroupHistory}. */
export type GroupHistoryEvents = {
  rumor: (rumor: Rumor) => void;
  removed: (rumorId: string) => void;
  cleared: () => void;
};

/**
 * A group's decrypted application messages (rumors), backed by an applesauce
 * `RumorStore` (in memory) or `AsyncRumorStore` (app database).
 *
 * Read with {@link queryRumors}, {@link subscribe} or
 * {@link createPaginatedLoader}, or use {@link store} directly for applesauce
 * models and RxJS streams. The group session owns all writes.
 */
export class GroupHistory extends EventEmitter<GroupHistoryEvents> {
  /** The underlying applesauce rumor store. */
  readonly store: GroupRumorStore;
  readonly #drop?: () => Promise<void>;

  constructor(
    store: GroupRumorStore = new RumorStore(),
    drop?: () => Promise<void>,
  ) {
    super();
    this.store = store;
    this.#drop = drop;
  }

  /** Builds the history for one group from the app's database factory. */
  static forGroup(
    groupId: string,
    databases?: MarmotRumorDatabases,
  ): GroupHistory {
    const database = databases?.(groupId);
    if (!database) return new GroupHistory();
    return new GroupHistory(
      new AsyncRumorStore({ database }),
      databases?.drop ? () => databases.drop!(groupId) : undefined,
    );
  }

  /**
   * Decodes an MLS application payload and stores its rumor. Invalid payloads
   * have no rumor and are ignored.
   * @internal
   */
  async saveMessage(message: Uint8Array): Promise<void> {
    let rumor: Rumor;
    try {
      rumor = deserializeApplicationData(message);
    } catch {
      return;
    }
    await this.store.add(rumor);
    this.emit("rumor", rumor);
  }

  /**
   * Retracts a rumor by its canonical id. Idempotent.
   * @internal
   */
  async removeMessage(rumorId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(rumorId))
      throw new Error("Invalid rumor ID for history removal");
    await this.store.remove(rumorId);
    this.emit("removed", rumorId);
  }

  /**
   * Removes every rumor and drops the app database partition, if supported.
   * @internal
   */
  async purgeMessages(): Promise<void> {
    await this.store.removeByFilters({});
    await this.#drop?.();
    this.emit("cleared");
  }

  /** Stored rumors matching `filters`, newest first. */
  async queryRumors(filters: Filter | Filter[]): Promise<Rumor[]> {
    return [...(await this.store.getTimeline(filters))];
  }

  /**
   * Yields the matching timeline now and again whenever a matching rumor is
   * saved, a rumor is removed, or history is cleared. Each snapshot is freshly
   * queried, so removals refill limited pages.
   *
   * Abort, return, throw, or async disposal promptly releases listeners.
   */
  subscribe(
    filters: Filter | Filter[] = {},
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<Rumor[]> {
    const filtersArray = Array.isArray(filters) ? filters : [filters];
    const matches = compileFilters<Rumor>(filtersArray);
    return watchCurrent({
      ...options,
      discardStale: true,
      read: () => this.queryRumors(filtersArray),
      subscribe: (changed) => {
        const inserted = (rumor: Rumor) => {
          if (matches(rumor)) changed();
        };
        const insert = this.store.insert$.subscribe(inserted);
        const remove = this.store.remove$.subscribe(() => changed());
        this.on("cleared", changed);
        return () => {
          insert.unsubscribe();
          remove.unsubscribe();
          this.off("cleared", changed);
        };
      },
    });
  }

  /**
   * Pages backwards through history, newest first, `filter.limit` (default 50)
   * rumors at a time. Rumors sharing the boundary second are re-read so none
   * are skipped; duplicates across pages are filtered out.
   */
  async *createPaginatedLoader(filter?: Filter): AsyncGenerator<Rumor[], void> {
    const limit = filter?.limit ?? 50;
    let until = filter?.until;
    const seen = new Set<string>();

    const unseen = (rumors: Rumor[]) => {
      const fresh = rumors.filter((rumor) => !seen.has(rumor.id));
      for (const rumor of fresh) seen.add(rumor.id);
      return fresh;
    };

    while (true) {
      const rumors = await this.queryRumors({ ...filter, until, limit });
      const page = unseen(rumors);
      if (page.length) yield page;
      if (rumors.length < limit) return;

      const oldest = Math.min(...rumors.map((rumor) => rumor.created_at));
      if (rumors.every((rumor) => rumor.created_at === oldest)) {
        // A full page inside one second: read that whole second, then move on.
        const { limit: _limit, ...rest } = filter ?? {};
        const second = unseen(
          await this.queryRumors({ ...rest, since: oldest, until: oldest }),
        );
        if (second.length) yield second;
        until = oldest - 1;
      } else {
        // Re-read the boundary second: it may hold more than this page showed.
        until = oldest;
      }
    }
  }
}
