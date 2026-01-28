import { Rumor } from "applesauce-common/helpers";
import { EventEmitter } from "eventemitter3";

import type { GroupHistoryStore } from "../client/group/marmot-group.js";
import { deserializeApplicationRumor } from "../core/group-message.js";
import type { OuterCursor } from "../utils/cursor.js";

export type MarmotGroupHistoryStoreEvents = {
  rumor: (rumor: Rumor) => void;
};

export interface MarmotGroupHistoryStoreBackend {
  /**
   * Record that an outer event has been processed.
   * Must be idempotent under replay.
   */
  markOuterEventProcessed(
    groupId: Uint8Array,
    outer: OuterCursor,
  ): Promise<void>;

  /**
   * Return the greatest processed outer cursor for this group, or null.
   */
  getResumeCursor(groupId: Uint8Array): Promise<OuterCursor | null>;

  /**
   * Store a rumor linked to the outer event cursor.
   * Must be idempotent under replay.
   */
  addRumor(
    groupId: Uint8Array,
    entry: { rumor: Rumor; outer: OuterCursor },
  ): Promise<void>;

  /**
   * Query rumors (newest first) using composite cursor semantics.
   * If `until` is provided, only return rumors with outer cursor < until (exclusive).
   */
  queryRumors(
    groupId: Uint8Array,
    filter: { until?: OuterCursor; limit?: number },
  ): Promise<Rumor[]>;

  /**
   * Optional live subscription support.
   */
  subscribe?(args: { groupId: Uint8Array; handler: (rumor: Rumor) => void }): {
    unsubscribe(): void;
  };
}

/** A per-group history store that stores MIP-03 rumors along with an outer cursor. */
export class MarmotGroupHistoryStore
  extends EventEmitter<MarmotGroupHistoryStoreEvents>
  implements GroupHistoryStore
{
  constructor(
    private groupId: Uint8Array,
    private backend: MarmotGroupHistoryStoreBackend,
  ) {
    super();
  }

  /** Creates a factory that will create group history store instances for a group id */
  static makeGroupHistoryInterface(
    backend: MarmotGroupHistoryStoreBackend,
  ): (groupId: Uint8Array) => MarmotGroupHistoryStore {
    return (groupId: Uint8Array) =>
      new MarmotGroupHistoryStore(groupId, backend);
  }

  markOuterEventProcessed(outer: OuterCursor): Promise<void> {
    return this.backend.markOuterEventProcessed(this.groupId, outer);
  }

  getResumeCursor(): Promise<OuterCursor | null> {
    return this.backend.getResumeCursor(this.groupId);
  }

  async addRumor(entry: { rumor: Rumor; outer: OuterCursor }): Promise<void> {
    await this.backend.addRumor(this.groupId, entry);
    this.emit("rumor", entry.rumor);
  }

  queryRumors(filter: {
    until?: OuterCursor;
    limit?: number;
  }): Promise<Rumor[]> {
    return this.backend.queryRumors(this.groupId, filter);
  }

  subscribe?(handler: (rumor: Rumor) => void): { unsubscribe(): void } {
    if (this.backend.subscribe) {
      return this.backend.subscribe({
        groupId: this.groupId,
        handler,
      });
    }

    this.on("rumor", handler);
    return {
      unsubscribe: () => this.off("rumor", handler),
    };
  }

  /**
   * Convenience: parses an MLS application message and saves it as a MIP-03 rumor.
   *
   * NOTE: This method cannot provide true outer cursor metadata (outer event created_at/id)
   * until Phase 2 refactors ingest() to supply it.
   *
   * @deprecated Prefer {@link addRumor} with explicit `{ rumor, outer }`.
   */
  async saveMessage(message: Uint8Array): Promise<void> {
    try {
      const rumor = deserializeApplicationRumor(message);
      // Best-effort placeholder: use rumor metadata as a stable, composite cursor.
      // This avoids timestamp-only pagination loss.
      const outer: OuterCursor = {
        created_at: rumor.created_at,
        id: rumor.id,
      };
      await this.addRumor({ rumor, outer });
    } catch {
      // Failed to read rumor, skip saving
    }
  }
}
