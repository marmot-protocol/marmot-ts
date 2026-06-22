import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { RelayPool as AsRelayPool } from "applesauce-relay/pool";

import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";

import type { Directory } from "./discovery.js";

function resolveRelays(relays: string[], fallback: string[]): string[] {
  return relays.length ? relays : fallback;
}

/**
 * Thin adapter over `applesauce-relay`'s {@link AsRelayPool} that implements
 * marmot-ts's {@link NostrNetworkInterface}. The pool is shared with the
 * {@link Directory} so relay-list/profile discovery reuses the same
 * connections, and `getUserInboxRelays` delegates to the Directory's loader.
 */
export class RelayPool implements NostrNetworkInterface {
  /** Relays used when a call passes an empty relay list. */
  defaultRelays: string[];

  readonly #pool: AsRelayPool;
  readonly #directory: Directory;
  #closed = false;

  constructor(
    pool: AsRelayPool,
    defaultRelays: string[],
    directory: Directory,
  ) {
    this.#pool = pool;
    this.defaultRelays = defaultRelays;
    this.#directory = directory;
  }

  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    if (this.#closed) return {};
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
    if (this.#closed) return [];
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
    if (this.#closed) {
      return {
        subscribe: (observer) => {
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
      };
    }
    const targets = resolveRelays(relays, this.defaultRelays);
    return this.#pool.subscription(targets, filters);
  }

  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    if (this.#closed) return this.defaultRelays;
    const relays = await this.#directory.welcomeInboxes(
      pubkey,
      this.defaultRelays,
    );
    return relays.length ? relays : this.defaultRelays;
  }

  get relayCount(): number {
    return this.#pool.relays.size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#directory.close();
    this.#pool.close();
  }
}
