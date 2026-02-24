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

  /** Open a subscription to the given relays and filters */
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent>;

  /**
   * Request a user's inbox relays.
   * This method should fetch the relays where a user receives their messages
   * (e.g., from a kind 10051 key package relay list event).
   *
   * @param pubkey - The public key (hex string) of the user whose inbox relays to load
   * @returns Promise resolving to an array of relay URLs for the user's inbox
   */
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
