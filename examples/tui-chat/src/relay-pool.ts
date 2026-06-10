import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import {
  getInboxRelays,
  INBOX_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";

function newest(events: NostrEvent[]): NostrEvent | undefined {
  return events.slice().sort((a, b) => b.created_at - a.created_at)[0];
}

function resolveRelays(relays: string[], fallback: string[]): string[] {
  return relays.length ? relays : fallback;
}

/**
 * Thin adapter over `applesauce-relay`'s {@link AsRelayPool} that implements
 * marmot-ts's {@link NostrNetworkInterface} for the TUI demo.
 */
export class RelayPool implements NostrNetworkInterface {
  /** Relays used when a call passes an empty relay list. Mutable: startup may
   * adopt the user's published NIP-65 relays after construction. */
  defaultRelays: string[];

  readonly #pool = new AsRelayPool();

  constructor(defaultRelays: string[]) {
    this.defaultRelays = defaultRelays;
  }

  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    const targets = resolveRelays(relays, this.defaultRelays);
    const responses = await this.#pool.publish(targets, event);
    const results: Record<string, PublishResponse> = {};
    for (const response of responses) {
      results[response.from] = response;
    }
    return results;
  }

  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const targets = resolveRelays(relays, this.defaultRelays);
    const collected: NostrEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      this.#pool.request(targets, filters).subscribe({
        next: (event) => collected.push(event),
        error: reject,
        complete: () => resolve(),
      });
    });
    return collected;
  }

  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    const targets = resolveRelays(relays, this.defaultRelays);
    return this.#pool.subscription(targets, filters);
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    const events = await this.request(this.defaultRelays, {
      kinds: [INBOX_RELAY_LIST_KIND],
      authors: [pubkey],
    });
    const latest = newest(events);
    const relays = latest ? getInboxRelays(latest) : [];
    return relays.length ? relays : this.defaultRelays;
  }

  close(): void {
    for (const relay of [...this.#pool.relays.values()]) {
      this.#pool.remove(relay, true);
    }
  }
}
