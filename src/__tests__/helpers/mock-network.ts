import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type {
  Subscribable,
  Unsubscribable,
} from "../../client/nostr-interface.js";

/**
 * Simple mock implementation of NostrNetworkInterface for testing.
 * Uses a shared events array to simulate relay behavior.
 */
export class MockNetwork implements NostrNetworkInterface {
  // Shared events array - simulates relay storage
  public events: NostrEvent[] = [];

  constructor(public relayUrls: string[] = ["wss://mock-relay.test"]) {}

  /**
   * Publish an event to the mock network (adds to events array)
   */
  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    this.events.push(event);

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

    // For mock, just check if any filter matches
    return this.events.filter((event) => {
      return filterArray.some((filter) => {
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (filter.authors && !filter.authors.includes(event.pubkey))
          return false;

        // Handle tag filters (e.g., #h, #e)
        // Tag values can be string or string[] - match if ANY value matches
        if (filter["#h"]) {
          const filterValues = Array.isArray(filter["#h"])
            ? filter["#h"]
            : [filter["#h"]];
          if (
            !event.tags.some(
              (t: any) => t[0] === "h" && filterValues.includes(t[1]),
            )
          )
            return false;
        }
        if (filter["#e"]) {
          const filterValues = Array.isArray(filter["#e"])
            ? filter["#e"]
            : [filter["#e"]];
          if (
            !event.tags.some(
              (t: any) => t[0] === "e" && filterValues.includes(t[1]),
            )
          )
            return false;
        }

        if (filter["#p"]) {
          const filterValues = Array.isArray(filter["#p"])
            ? filter["#p"]
            : [filter["#p"]];
          if (
            !event.tags.some(
              (t: any) => t[0] === "p" && filterValues.includes(t[1]),
            )
          )
            return false;
        }

        return true;
      });
    });
  }

  /**
   * Subscribe to events (simplified - just returns existing events)
   */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const filterArray = Array.isArray(filters) ? filters : [filters];

    // Find matching events
    const matchingEvents = this.events.filter((event) => {
      return filterArray.some((filter) => {
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (filter.authors && !filter.authors.includes(event.pubkey))
          return false;
        return true;
      });
    });

    return {
      subscribe: (observer: any): Unsubscribable => {
        // Immediately send matching events
        if (observer.next && matchingEvents.length > 0) {
          observer.next(matchingEvents);
        }

        return {
          unsubscribe: () => {
            // No-op for mock
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
