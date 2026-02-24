import { EventStore } from "applesauce-core";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { RelayPool } from "applesauce-relay";
import { lookupRelays$ } from "./settings";

// Create in-memory event store
export const eventStore = new EventStore();

// Create relay connection pool
export const pool = new RelayPool();

// Attach loaders to event store
createEventLoaderForStore(eventStore, pool, {
  lookupRelays: lookupRelays$,
});

if (import.meta.env.DEV) {
  // @ts-ignore
  window.eventStore = eventStore;
}
