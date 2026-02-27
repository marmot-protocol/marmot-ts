import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type {
  PublishResponse,
  Subscribable,
  Unsubscribable,
} from "../../client/nostr-interface.js";

/**
 * @deprecated Use {@link MockEventStore} from mock-group-transport.ts together
 * with {@link MockGroupTransport} and {@link MockInviteTransport} instead.
 *
 * Simple mock relay store kept for reference. Implements publish/request/subscription
 * on a shared in-memory events array.
 */
export class MockNetwork {
  // Shared events array - simulates relay storage
  public events: NostrEvent[] = [];

  constructor(public relayUrls: string[] = ["wss://mock-relay.test"]) {}

  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    this.events.push(event);
    const result: Record<string, PublishResponse> = {};
    for (const relay of relays) {
      result[relay] = { from: relay, ok: true };
    }
    return result;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    return this.events.filter((event) => {
      return filterArray.some((filter) => {
        if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
        if (filter.authors && !filter.authors.includes(event.pubkey))
          return false;
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

  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
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
        if (observer.next && matchingEvents.length > 0) {
          observer.next(matchingEvents);
        }
        return { unsubscribe: () => {} };
      },
    };
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    return ["wss://mock-inbox.test"];
  }

  clear(): void {
    this.events = [];
  }
}
