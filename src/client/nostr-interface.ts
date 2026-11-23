/** @module @category Client - Nostr */
import { NostrEvent } from "applesauce-core/helpers/event";
import { Filter } from "applesauce-core/helpers/filter";

/** A response from a nostr relay when publishing an event */
export interface PublishResponse {
  /** The relay URL that the event was published to */
  from: string;
  /** The result of the publish */
  ok: boolean;
  /** A message if the publish failed or succeeded */
  message?: string;
  /** Transport failure cannot exclude external acceptance; retry the exact bytes. */
  uncertain?: boolean;
}

/** Generic interface for a writable nostr relay pool */
export interface NostrPoolWrite {
  /** Publish an event to the given relays */
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;
}

/** Interop Observable interfaces */
export interface Observer<T> {
  next: (value: T) => void;
  error: (err: unknown) => void;
  complete: () => void;
}
export interface Unsubscribable {
  unsubscribe(): void;
}
export interface Subscribable<T> {
  subscribe(observer: Partial<Observer<T>>): Unsubscribable;
}

/** Generic interface for a readable nostr pool */
export interface NostrPoolRead {
  /** Make a single request to the given relays with filters */
  request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]>;
  /** Open a subscription to the given relays and filters */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent[]>;
}

/** Merged interface for a nostr relay pool */
export interface NostrPool extends NostrPoolWrite, NostrPoolRead {}

/** Options for a historical backfill. Retrieval policy belongs to the adapter. */
export interface BackfillOptions {
  /** Abort must stop underlying requests and reject the operation. */
  signal?: AbortSignal;
}

/** Outcome for one requested relay, keyed by the exact requested URL. */
export type RelayBackfillResult = {
  relay: string;
  /** IDs in `events` retrieved from, or confirmed present on, this relay. */
  eventIds: string[];
} & (
  | { status: "complete" }
  | { status: "incomplete"; reason?: string }
  | { status: "failed"; error?: unknown }
  | { status: "skipped"; reason?: string }
);

/** History available for ingestion, with explicit per-relay completeness. */
export interface BackfillResult {
  /**
   * All matching events available for ingestion, including cached events used
   * in reconciliation. Cached does not mean durably ingested by Marmot.
   * Deduplicate only verified copies: an invalid copy must not hide a valid one.
   */
  events: NostrEvent[];
  /** One outcome for every requested relay; partial failures preserve events. */
  relays: RelayBackfillResult[];
}

/**
 * Interface for group-specific nostr operations.
 * This is the only network interface used by MarmotGroup.
 * It includes all NostrPool methods plus group-specific operations.
 */
export interface NostrNetworkInterface {
  /** Publish an event to the given relays */
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;

  /** Make a single request to the given relays with filters */
  request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]>;

  /**
   * Exhaust a historical filter using pagination, reconciliation, or another
   * retrieval strategy. `complete` means the range was exhausted, not merely
   * that a stream ended. `filter.limit` must not truncate the history.
   * When absent, Marmot uses its paginated request fallback.
   */
  backfill?(
    relays: string[],
    filter: Filter,
    options?: BackfillOptions,
  ): Promise<BackfillResult>;

  /** Open a subscription to the given relays and filters */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent>;

  /**
   * Request a user's inbox relays.
   * This method should fetch the relays where a user receives gift-wrapped
   * welcomes, from their kind 10050 inbox relay list event
   * (transports/nostr.md "Publish targets and acknowledgements").
   *
   * @param pubkey - The public key (hex string) of the user whose inbox relays to load
   * @returns Promise resolving to an array of relay URLs for the user's inbox
   */
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
