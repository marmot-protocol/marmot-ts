import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import {
  Observable,
  distinctUntilChanged,
  fromEvent,
  shareReplay,
  switchMap,
  takeUntil,
} from "rxjs";
import { mode$ } from "./mode.js";
import { DemoRelay } from "./internal/relay/demo-relay.js";
import { LiveTransport } from "./internal/live-transport.js";

/** Account-independent network interface, replaced and disposed when mode changes. */
export const transport$ = mode$.pipe(
  distinctUntilChanged(),
  switchMap(
    (mode) =>
      new Observable<NostrNetworkInterface>((subscriber) => {
        const transport =
          mode === "local" ? new DemoRelay() : new LiveTransport();
        subscriber.next(transport.network("you"));
        return () => transport.close();
      }),
  ),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);
