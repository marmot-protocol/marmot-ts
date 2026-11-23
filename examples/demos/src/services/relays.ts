import { distinctUntilChanged, map } from "rxjs";
import { mode$ } from "./mode.js";
import { LIVE_RELAYS } from "./internal/relays.js";
import { DEMO_RELAY_URL } from "./internal/relay/demo-relay.js";

/** Explicit relay configuration for client operations, not transport state. */
export const relays$ = mode$.pipe(
  distinctUntilChanged(),
  map((mode) => (mode === "local" ? [DEMO_RELAY_URL] : [...LIVE_RELAYS])),
);
