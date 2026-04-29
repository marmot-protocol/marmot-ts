import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { matchFilters } from "applesauce-core/helpers/filter";
import type { Filter } from "applesauce-core/helpers/filter";
import { EventEmitter } from "eventemitter3";
import { deserializeApplicationData } from "../../core/group-message.js";
import { BaseGroupHistory, GroupHistoryFactory } from "../index.js";
import {
  insertEventIntoDescendingList,
  NostrEvent,
} from "applesauce-core/helpers";

/** A rumor storage interface for the {@link GroupRumorHistory} class */
export interface GroupRumorHistoryBackend {
  /** Load rumor events from a specific time in history. Results are ordered by created_at descending (newest first). */
  queryRumors(filters: Filter | Filter[]): Promise<Rumor[]>;
  /** Save a new group rumor event */
  addRumor(message: Rumor): Promise<void>;
  /** Clear all rumor events from the backend */
  clear(): Promise<void>;
}

/** A map of events that can be emitted by a {@link GroupRumorHistory} */
type GroupRumorHistoryEvents = {
  rumor: (rumor: Rumor) => void;
  cleared: () => void;
};

/** A group.history implementation that stores the parsed rumor events for a group and provies methods for querying */
export class GroupRumorHistory
  extends EventEmitter<GroupRumorHistoryEvents>
  implements BaseGroupHistory
{
  constructor(private backend: GroupRumorHistoryBackend) {
    super();
  }

  /** Creates a new method that will create {@link GroupRumorHistory} instances for a group id */
  static makeFactory(
    backendFactory: (groupId: Uint8Array) => GroupRumorHistoryBackend,
  ): GroupHistoryFactory<GroupRumorHistory> {
    return (groupId: Uint8Array) =>
      new GroupRumorHistory(backendFactory(groupId));
  }

  /** Parses an MLS message and saves it as a rumor event */
  async saveMessage(message: Uint8Array): Promise<void> {
    try {
      const rumor = deserializeApplicationData(message);
      await this.saveRumor(rumor);
    } catch (error) {
      // Failed to read rumor, skip saving
    }
  }

  /** Saves a new rumor event to the backend */
  async saveRumor(rumor: Rumor): Promise<void> {
    await this.backend.addRumor(rumor);

    // Notify listeners that a new rumor has been added
    this.emit("rumor", rumor);
  }

  /** Purge all rumor events from the backend */
  async purgeMessages(): Promise<void> {
    await this.backend.clear();

    // Notify listeners that all rumors have been cleared
    this.emit("cleared");
  }

  /** Request stored rumors by filters */
  async queryRumors(filters: Filter | Filter[]): Promise<Rumor[]> {
    return this.backend.queryRumors(
      Array.isArray(filters) ? filters : [filters],
    );
  }

  /**
   * Async generator that yields the current timeline of {@link Rumor} events whenever a
   * new rumor is saved that matches `filters` or the history is cleared. The initial snapshot
   * is emitted immediately on subscription, then again after every matching `rumor` event or
   * `cleared` event.
   *
   * The generator runs until the caller breaks out of the loop or the consuming
   * iterator is garbage-collected (via the `finally` cleanup).
   */
  async *subscribe(filters?: Filter | Filter[]): AsyncGenerator<Rumor[]> {
    const filtersArray: Filter[] = filters
      ? Array.isArray(filters)
        ? filters
        : [filters]
      : [{}];

    let current: NostrEvent[] = [];
    let next: ((timeline: NostrEvent[]) => void) | null = null;

    const notify = (rumor: Rumor) => {
      // Only wake up if the new rumor matches at least one of the caller's filters.
      // matchFilters expects a signed NostrEvent; Rumor has all checked fields
      // (id, kind, pubkey, tags, created_at) — cast is safe here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!matchFilters(filtersArray, rumor as any)) return;

      if (next) {
        // Add event to timeline
        insertEventIntoDescendingList(current, rumor as NostrEvent);

        // Resolve next promise
        next([...current]);
        next = null;
      }
    };

    const notifyCleared = () => {
      if (next) {
        // Resolve next promise with empty timeline
        next([]);
        next = null;
      }
    };

    this.on("rumor", notify);
    this.on("cleared", notifyCleared);

    try {
      current = (await this.backend.queryRumors(filtersArray)) as NostrEvent[];
      yield current;

      while (true) {
        yield await new Promise<NostrEvent[]>((r) => (next = r));
      }
    } finally {
      this.off("rumor", notify);
      this.off("cleared", notifyCleared);
    }
  }

  /**
   * Creates an async generator for paginated loading of historical rumor events.
   *
   * This method allows UI components to load historical messages in pages, enabling
   * infinite scroll or paginated UI patterns.
   *
   * @param filter - Optional filter to apply to the query
   * @yields Batches of Rumor events, with each batch containing up to `filter.limit` messages
   *
   * @example
   * ```ts
   * const generator = group.history.createPaginatedLoader(groupId, 50);
   * for await (const page of generator) {
   *   // Process page of messages
   *   console.log(`Loaded ${page.length} messages`);
   * }
   * ```
   */
  async *createPaginatedLoader(filter?: Filter): AsyncGenerator<Rumor[], void> {
    const limit = filter?.limit ?? 50;
    let cursor = filter?.until ?? undefined;

    while (true) {
      const rumors = await this.backend.queryRumors({
        ...filter,
        until: cursor,
        limit,
      });

      // If no rumors returned, we've reached the end
      if (rumors.length === 0) return;

      // Find the oldest timestamp in the current page
      // and set it as the new `until` for the next page (going backwards)
      const oldest = Math.min(...rumors.map((rumor) => rumor.created_at));

      // Set the next `until` to be just before the oldest message
      // This ensures we get the next older page without duplicates
      if (!cursor || oldest < cursor) cursor = oldest - 1;

      // Yield the current page
      yield rumors;

      // If we got fewer than the limit, we've reached the end
      if (rumors.length < limit) {
        return;
      }
    }
  }
}
