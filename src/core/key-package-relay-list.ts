/** @module @category Core - Key Package Relay List */
import { NostrEvent, UnsignedEvent } from "applesauce-core/helpers/event";

import { isValidRelayUrl, normalizeRelayUrl } from "../utils/relay-url.js";
import {
  KEY_PACKAGE_RELAY_LIST_KIND,
  KEY_PACKAGE_RELAY_LIST_RELAY_TAG,
} from "./protocol.js";
import { unixNow } from "../utils/nostr.js";

/**
 * Gets the relay URLs from a kind 10051 event.
 * These relays indicate where a user publishes their KeyPackages.
 *
 * @param event - The kind 10051 event containing relay information
 * @returns Array of relay URLs, or empty array if none found
 */
export function getKeyPackageRelayList(event: NostrEvent): string[] {
  return event.tags
    .filter((tag) => tag[0] === KEY_PACKAGE_RELAY_LIST_RELAY_TAG && tag[1])
    .map((tag) => tag[1])
    .filter(isValidRelayUrl)
    .map(normalizeRelayUrl);
}

/**
 * Validates a kind 10051 relay list event.
 *
 * @param event - The event to validate
 * @returns True if the event is a valid kind 10051 relay list event
 */
export function isValidKeyPackageRelayListEvent(event: NostrEvent): boolean {
  return (
    event.kind === KEY_PACKAGE_RELAY_LIST_KIND &&
    getKeyPackageRelayList(event).length > 0
  );
}

/**
 * Options for creating a key package relay list event
 */
export type CreateKeyPackageRelayListEventOptions = {
  /** The pubkey of the event author */
  pubkey: string;
  /** The relays where key packages should be published */
  relays: string[];
  /** Optional client identifier */
  client?: string;
};

/**
 * Creates an unsigned Nostr event (kind 10051) for a key package relay list.
 * The event specifies where a user publishes their key packages.
 *
 * @param options - Configuration for creating the relay list event
 * @returns An unsigned Nostr event ready to be signed and published
 */
export function createKeyPackageRelayListEvent(
  options: CreateKeyPackageRelayListEventOptions,
): UnsignedEvent {
  const { pubkey, relays, client } = options;

  // Validate relay URLs
  const validRelays = relays
    .filter((relay) => relay.trim().length > 0 && URL.canParse(relay))
    .map(normalizeRelayUrl);

  // Build tags (empty array allowed - users can have no key package relays)
  const tags: string[][] = validRelays.map((relay) => [
    KEY_PACKAGE_RELAY_LIST_RELAY_TAG,
    relay,
  ]);

  // Add client tag if provided
  if (client) {
    tags.push(["client", client]);
  }

  return {
    kind: KEY_PACKAGE_RELAY_LIST_KIND,
    created_at: unixNow(),
    tags,
    content: "",
    pubkey,
  };
}
