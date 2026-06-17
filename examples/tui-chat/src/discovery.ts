import type { NostrEvent } from "applesauce-core/helpers/event";
import { getInboxes, getOutboxes } from "applesauce-core/helpers/mailboxes";
import {
  getProfileContent,
  type ProfileContent,
} from "applesauce-core/helpers/profile";
import { EventStore } from "applesauce-core/event-store";
import { createAddressLoader } from "applesauce-loaders/loaders";

import {
  getInboxRelays,
  INBOX_RELAY_LIST_KIND,
  NIP65_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";

const METADATA_KIND = 0;

/**
 * Public relays the {@link Directory} always falls back to when a user's relay
 * lists can't be found on the relays we already know. These are well-known
 * NIP-65 indexers/aggregators plus the White Noise relays, so we can discover
 * the outboxes of users we've never shared a relay with.
 */
export const LOOKUP_RELAYS = [
  "wss://relay.us.whitenoise.chat",
  "wss://relay.eu.whitenoise.chat",
  "wss://purplepag.es",
  "wss://index.hzrd149.com",
];

/** Minimal shape of the loader observables we consume (avoids an rxjs import). */
type Subscribable<T> = {
  subscribe(observer: {
    next: (value: T) => void;
    error: (err: unknown) => void;
    complete: () => void;
  }): { unsubscribe(): void };
};

/** Drain a loader observable into an array, with a safety timeout. */
function collect(
  observable: Subscribable<NostrEvent>,
  timeoutMs = 10_000,
): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sub: { unsubscribe(): void } | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      sub?.unsubscribe();
      resolve(events);
    };
    sub = observable.subscribe({
      next: (event) => events.push(event),
      error: (err) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        reject(err);
      },
      complete: finish,
    });
    if (!done) timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Discovers other accounts' relay lists and profiles using applesauce's
 * {@link createAddressLoader | address loader}. The loader batches and
 * de-duplicates requests through a shared {@link EventStore}, follows relay
 * hints, and falls back to {@link LOOKUP_RELAYS} when an event can't be found
 * on the relays we're already connected to — so callers no longer hand-roll
 * NIP-65 lookups or relay unions.
 */
export class Directory {
  readonly #load: ReturnType<typeof createAddressLoader>;

  constructor(
    pool: Parameters<typeof createAddressLoader>[0],
    store: EventStore = new EventStore(),
  ) {
    // The loader keeps a reference to the store for de-duplication; we don't
    // need to read from it directly here.
    this.#load = createAddressLoader(pool, {
      eventStore: store,
      lookupRelays: LOOKUP_RELAYS,
    });
  }

  /** Latest version of a replaceable event for a pubkey, or undefined. */
  async #latest(
    kind: number,
    pubkey: string,
    hints?: string[],
  ): Promise<NostrEvent | undefined> {
    const events = await collect(this.#load({ kind, pubkey, relays: hints }));
    return events.reduce<NostrEvent | undefined>(
      (best, event) =>
        !best || event.created_at > best.created_at ? event : best,
      undefined,
    );
  }

  /**
   * The account's NIP-65 (kind 10002) outbox relays — where it publishes its
   * KeyPackages and is discoverable by inviters.
   */
  async outboxes(pubkey: string, hints?: string[]): Promise<string[]> {
    const event = await this.#latest(NIP65_RELAY_LIST_KIND, pubkey, hints);
    return event ? getOutboxes(event) : [];
  }

  /** The account's NIP-65 (kind 10002) inbox/read relays. */
  async inboxes(pubkey: string, hints?: string[]): Promise<string[]> {
    const event = await this.#latest(NIP65_RELAY_LIST_KIND, pubkey, hints);
    return event ? getInboxes(event) : [];
  }

  /**
   * The account's Marmot welcome-inbox relays (kind 10050) — where
   * gift-wrapped Welcome events are delivered.
   */
  async welcomeInboxes(pubkey: string, hints?: string[]): Promise<string[]> {
    const event = await this.#latest(INBOX_RELAY_LIST_KIND, pubkey, hints);
    return event ? getInboxRelays(event) : [];
  }

  /** The account's parsed kind 0 profile metadata, or undefined. */
  async profile(
    pubkey: string,
    hints?: string[],
  ): Promise<ProfileContent | undefined> {
    const event = await this.#latest(METADATA_KIND, pubkey, hints);
    return event ? getProfileContent(event) : undefined;
  }
}
