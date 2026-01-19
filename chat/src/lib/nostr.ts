import { EventStore } from "applesauce-core";
import type { CacheRequest } from "applesauce-loaders";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { extraRelays$, lookupRelays$ } from "./settings";

// Import window.nostrdb for global event cache
import "window.nostrdb.js";

import { persistEventsToCache } from "applesauce-core/helpers";
import { initNostrWasm } from "nostr-wasm";
const nw = await initNostrWasm();

// Create in-memory event store
export const eventStore = new EventStore();

// Use nostr-wasm to verify all events added to the store
eventStore.verifyEvent = (e) => {
  try {
    nw.verifyEvent(e);
    return true;
  } catch {
    return false;
  }
};

// Persist the new events to the window.nostrdb cache
persistEventsToCache(eventStore, (events) =>
  Promise.allSettled(events.map((event) => window.nostrdb.add(event))),
);

// Create relay connection pool
export const pool = new RelayPool();

// Create generic method to query window.nostrdb cache
export const cacheRequest: CacheRequest = (filters) =>
  window.nostrdb.filters(filters);

// Attach loaders to event store
export const eventLoader = createEventLoaderForStore(eventStore, pool, {
  cacheRequest,
  lookupRelays: lookupRelays$,
  extraRelays: extraRelays$,
});

if (import.meta.env.DEV) {
  // @ts-ignore
  window.eventStore = eventStore;

  // @ts-ignore
  window.pool = pool;
}
