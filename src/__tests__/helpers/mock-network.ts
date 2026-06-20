import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type {
  Observer,
  Subscribable,
  Unsubscribable,
} from "../../client/nostr-interface.js";

/** True when `event` matches at least one of the given filters (kinds/authors/#tags). */
function matchesFilters(event: NostrEvent, filters: Filter[]): boolean {
  return filters.some((filter) => {
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
    for (const key of ["#h", "#e", "#p"] as const) {
      const values = filter[key];
      if (!values) continue;
      const list = Array.isArray(values) ? values : [values];
      const tag = key.slice(1);
      if (!event.tags.some((t: any) => t[0] === tag && list.includes(t[1])))
        return false;
    }
    return true;
  });
}

/**
 * Simple mock implementation of NostrNetworkInterface for testing.
 * Uses a shared events array to simulate relay behavior.
 */
export class MockNetwork implements NostrNetworkInterface {
  // Shared events array - simulates relay storage
  public events: NostrEvent[] = [];

  /** Live subscriptions, notified per-event on subsequent publishes. */
  #subscribers = new Set<{
    filters: Filter[];
    observer: Partial<Observer<NostrEvent>>;
  }>();

  constructor(public relayUrls: string[] = ["wss://mock-relay.test"]) {}

  /**
   * Publish an event to the mock network (adds to events array), and deliver it
   * to any live subscription whose filters match.
   */
  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    this.events.push(event);

    for (const sub of this.#subscribers) {
      if (matchesFilters(event, sub.filters)) sub.observer.next?.(event);
    }

    // Return success for all requested relays
    const result: Record<string, PublishResponse> = {};
    for (const relay of relays) {
      result[relay] = { from: relay, ok: true };
    }
    return result;
  }

  /**
   * Query events matching filters (simple implementation)
   */
  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((event) => matchesFilters(event, filterArray));
  }

  /**
   * Subscribe to events: replays currently-matching events one-by-one, then
   * delivers each future matching publish until unsubscribed.
   */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const filterArray = Array.isArray(filters) ? filters : [filters];

    return {
      subscribe: (observer: Partial<Observer<NostrEvent>>): Unsubscribable => {
        // Replay the existing matching events individually.
        for (const event of this.events) {
          if (matchesFilters(event, filterArray)) observer.next?.(event);
        }

        const entry = { filters: filterArray, observer };
        this.#subscribers.add(entry);

        return {
          unsubscribe: () => {
            this.#subscribers.delete(entry);
          },
        };
      },
    };
  }

  /**
   * Get inbox relays for a user (mock)
   */
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    return ["wss://mock-inbox.test"];
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
  }
}
