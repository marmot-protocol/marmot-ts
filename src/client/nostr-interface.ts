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
