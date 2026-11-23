import { EventStore } from "applesauce-core";
import {
  Observable,
  distinctUntilChanged,
  firstValueFrom,
  fromEvent,
  map,
  of,
  shareReplay,
  switchMap,
  takeUntil,
} from "rxjs";
import { mode$ } from "./mode.js";
import { DemoRelay } from "./internal/relay/demo-relay.js";
import { LiveTransport, LOOKUP_RELAYS } from "./internal/live-transport.js";
import { reactiveTransport } from "./internal/reactive-transport.js";

export type { RelayLogEntry } from "./internal/relay/demo-relay.js";
export const lookupRelays$ = of([...LOOKUP_RELAYS]);

/** Transport is account-independent; only changing mode replaces the connection. */
export const transport$ = mode$.pipe(
  distinctUntilChanged(),
  switchMap(
    (mode) =>
      new Observable<ReturnType<typeof openTransport>>((subscriber) => {
        const transport = openTransport(mode);
        subscriber.next(transport);
        return () => {
          transport.controller.abort();
          transport.close();
          transport.store.dispose();
        };
      }),
  ),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);

function openTransport(mode: "local" | "live") {
  const store = new EventStore();
  const controller = new AbortController();
  const transport =
    mode === "local" ? new DemoRelay() : new LiveTransport(store);
  return Object.assign(transport, { mode, store, controller });
}

const observableTransport$ = transport$.pipe(
  map((transport) => reactiveTransport(transport, transport.controller.signal)),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const relays$ = transport$.pipe(
  map((transport) => [...transport.relays]),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const ready$ = observableTransport$.pipe(
  switchMap((transport) => transport.ready$),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const state$ = observableTransport$.pipe(
  switchMap((transport) => transport.state$),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const events$ = observableTransport$.pipe(
  switchMap((transport) => transport.events$),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const log$ = observableTransport$.pipe(
  switchMap((transport) => transport.log$),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const peers$ = observableTransport$.pipe(
  switchMap((transport) => transport.peers$),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export async function setPaused(paused: boolean): Promise<void> {
  await firstValueFrom(
    observableTransport$.pipe(map((transport) => transport.setPaused(paused))),
  );
}

export async function flush(): Promise<void> {
  await firstValueFrom(
    observableTransport$.pipe(map((transport) => transport.flush())),
  );
}
