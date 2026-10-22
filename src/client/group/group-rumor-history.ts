/** @module @category Client - Group History */
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { Filter } from "applesauce-core/helpers/filter";
import { compileFilters } from "applesauce-core/helpers/filter";
import { EventEmitter } from "eventemitter3";
import { deserializeApplicationData } from "../../core/group-message.js";
import { BaseGroupHistory, GroupHistoryFactory } from "../index.js";

/** A rumor storage interface for the {@link GroupRumorHistory} class */
export interface GroupRumorHistoryBackend {
  /** Load rumor events from a specific time in history. Results are ordered by created_at descending (newest first). */
  queryRumors(filters: Filter | Filter[]): Promise<Rumor[]>;
  /** Save a new group rumor event */
  addRumor(message: Rumor): Promise<void>;
  /** Durably remove the exact inner rumor; repeated calls must succeed. */
  removeRumor(rumorId: string): Promise<void>;
  /** Clear all rumor events from the backend */
  clear(): Promise<void>;
}

/** A map of events that can be emitted by a {@link GroupRumorHistory} */
export type GroupRumorHistoryEvents = {
  rumor: (rumor: Rumor) => void;
  cleared: () => void;
  removed: (rumorId: string) => void;
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
    let rumor: Rumor;
    try {
      rumor = deserializeApplicationData(message);
    } catch (error) {
      return; // Invalid payloads have no rumor to store.
    }
    await this.saveRumor(rumor);
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

  /** Retract a validated inner identity before notifying timeline listeners. */
  async removeMessage(rumorId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(rumorId))
      throw new Error("Invalid rumor ID for history removal");
    await this.backend.removeRumor(rumorId);
    this.emit("removed", rumorId);
  }

  /** Request stored rumors by filters */
  async queryRumors(filters: Filter | Filter[]): Promise<Rumor[]> {
    return this.backend.queryRumors(
      Array.isArray(filters) ? filters : [filters],
    );
  }

  /**
   * Async generator that yields the current timeline of {@link Rumor} events whenever a
   * matching rumor is saved, a rumor is removed, or history is cleared. Each
   * snapshot is freshly queried so removal refills limited pages. Changes
   * during loading or paused consumption are latched until the next pull.
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

    const matches = compileFilters<Rumor>(filtersArray);
    let version = 0;
    let observed = -1;
    let wake: (() => void) | undefined;
    const changed = () => {
      version++;
      wake?.();
      wake = undefined;
    };
    const inserted = (rumor: Rumor) => {
      if (matches(rumor)) changed();
    };
    this.on("rumor", inserted);
    this.on("cleared", changed);
    this.on("removed", changed);
    try {
      while (true) {
        if (observed === version)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const snapshotVersion = version;
        const snapshot = await this.backend.queryRumors(filtersArray);
        if (snapshotVersion !== version) continue;
        observed = snapshotVersion;
        yield [...snapshot];
      }
    } finally {
      this.off("rumor", inserted);
      this.off("cleared", changed);
      this.off("removed", changed);
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
