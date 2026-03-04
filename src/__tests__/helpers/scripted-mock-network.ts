import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

import type {
  PublishResponse,
  Subscribable,
  Unsubscribable,
} from "../../client/nostr-interface.js";
import { MockNetwork } from "./mock-network.js";

type StoredEvent = {
  event: NostrEvent;
  relays: string[];
  visible: boolean;
  seq: number;
};

/**
 * Deterministic network test harness with explicit visibility control.
 *
 * Publish always succeeds immediately, but events stay hidden until released via
 * step/stepWhere/stepAll. This lets tests reproduce race windows deterministically.
 */
export class ScriptedMockNetwork extends MockNetwork {
  private seq = 0;
  private readonly stored: StoredEvent[] = [];

  override async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    this.stored.push({
      event,
      relays: [...relays],
      visible: false,
      seq: this.seq++,
    });
    this.events.push(event);

    const result: Record<string, PublishResponse> = {};
    for (const relay of relays) {
      result[relay] = { from: relay, ok: true };
    }
    return result;
  }

  step(count = 1): number {
    let released = 0;
    for (const item of this.stored) {
      if (released >= count) break;
      if (item.visible) continue;
      item.visible = true;
      released++;
    }
    return released;
  }

  stepWhere(predicate: (event: NostrEvent) => boolean, count = 1): number {
    let released = 0;
    for (const item of this.stored) {
      if (released >= count) break;
      if (item.visible) continue;
      if (!predicate(item.event)) continue;
      item.visible = true;
      released++;
    }
    return released;
  }

  stepAll(): number {
    return this.step(Number.MAX_SAFE_INTEGER);
  }

  override async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const filterArray = Array.isArray(filters) ? filters : [filters];
    const relaySet = new Set(relays);

    return this.stored
      .filter((item) => item.visible)
      .filter((item) => item.relays.some((r) => relaySet.has(r)))
      .filter((item) =>
        filterArray.some((filter) => this.matchesFilter(item.event, filter)),
      )
      .sort((a, b) => a.seq - b.seq)
      .map((item) => item.event);
  }

  override subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const relaySet = new Set(relays);
    const filterArray = Array.isArray(filters) ? filters : [filters];
    const matchingEvents = this.stored
      .filter((item) => item.visible)
      .filter((item) => item.relays.some((r) => relaySet.has(r)))
      .filter((item) =>
        filterArray.some((filter) => this.matchesFilter(item.event, filter)),
      )
      .map((item) => item.event);

    return {
      subscribe: (observer: any): Unsubscribable => {
        if (observer.next && matchingEvents.length > 0) {
          observer.next(matchingEvents);
        }
        return { unsubscribe: () => undefined };
      },
    };
  }

  override clear(): void {
    super.clear();
    this.stored.length = 0;
    this.seq = 0;
  }

  private matchesFilter(event: NostrEvent, filter: Filter): boolean {
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false;

    if (!this.matchesTagFilter(event, "#h", filter["#h"])) return false;
    if (!this.matchesTagFilter(event, "#e", filter["#e"])) return false;
    if (!this.matchesTagFilter(event, "#p", filter["#p"])) return false;

    return true;
  }

  private matchesTagFilter(
    event: NostrEvent,
    filterKey: "#h" | "#e" | "#p",
    values: string[] | string | undefined,
  ): boolean {
    if (!values) return true;
    const wanted = Array.isArray(values) ? values : [values];
    const tagName = filterKey[1];
    return event.tags.some((t) => t[0] === tagName && wanted.includes(t[1]));
  }
}
