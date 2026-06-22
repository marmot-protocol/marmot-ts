import { castUser } from "applesauce-common/casts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { getInboxes, getOutboxes } from "applesauce-core/helpers/mailboxes";
import {
  getProfileContent,
  type ProfileContent,
} from "applesauce-core/helpers/profile";
import type { EventStore } from "applesauce-core/event-store";

import {
  getInboxRelays,
  INBOX_RELAY_LIST_KIND,
  NIP65_RELAY_LIST_KIND,
} from "@internet-privacy/marmot-ts";

const METADATA_KIND = 0;

/**
 * Public relays the {@link Directory} always falls back to when a user's relay
 * lists can't be found on the relays we already know — well-known NIP-65
 * indexers plus the White Noise relays, so we can discover the outboxes of
 * users we've never shared a relay with. Wired into the shared {@link EventStore}
 * loader (see `setup.ts`) so reactive reads and imperative lookups share one
 * cache.
 */
export const LOOKUP_RELAYS = [
  "wss://relay.us.whitenoise.chat",
  "wss://relay.eu.whitenoise.chat",
  "wss://purplepag.es",
  "wss://index.hzrd149.com",
];

/**
 * Imperative accessors for other accounts' relay lists and profiles, reading
 * straight from the shared {@link EventStore}. Subscribing to a replaceable the
 * store doesn't have triggers its `eventLoader` (configured in `setup.ts`),
 * which batches/de-duplicates the request and falls back to
 * {@link LOOKUP_RELAYS}.
 */
export class Directory {
  readonly #store: EventStore;
  #closed = false;

  constructor(store: EventStore) {
    this.#store = store;
  }

  close(): void {
    this.#closed = true;
  }

  /**
   * Latest version of a replaceable event for a pubkey, or undefined. Reads
   * reactively from the store and resolves with the first value the loader
   * produces (or undefined after a timeout).
   */
  async #latest(
    kind: number,
    pubkey: string,
    hints?: string[],
  ): Promise<NostrEvent | undefined> {
    if (this.#closed) return undefined;
    const user = castUser(pubkey, this.#store);
    const event = await user
      .replaceable(kind, undefined, hints)
      .$first(10_000, undefined);
    if (this.#closed) return undefined;
    return event ?? undefined;
  }

  /** The account's NIP-65 (kind 10002) outbox relays. */
  async outboxes(pubkey: string, hints?: string[]): Promise<string[]> {
    const event = await this.#latest(NIP65_RELAY_LIST_KIND, pubkey, hints);
    return event ? getOutboxes(event) : [];
  }

  /** The account's NIP-65 (kind 10002) inbox/read relays. */
  async inboxes(pubkey: string, hints?: string[]): Promise<string[]> {
    const event = await this.#latest(NIP65_RELAY_LIST_KIND, pubkey, hints);
    return event ? getInboxes(event) : [];
  }

  /** The account's Marmot welcome-inbox relays (kind 10050). */
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
