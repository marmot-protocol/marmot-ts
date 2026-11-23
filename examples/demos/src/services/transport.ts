import { EventStore } from "applesauce-core";
import {
  Observable,
  defer,
  distinctUntilChanged,
  firstValueFrom,
  fromEvent,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  takeUntil,
} from "rxjs";
import { mode$ } from "./mode.js";
import { DemoRelay } from "./internal/relay/demo-relay.js";
import { LiveTransport, LOOKUP_RELAYS } from "./internal/live-transport.js";
import { aborted$, stateObservable } from "../utils/observable.js";

export type { RelayLogEntry } from "./internal/relay/demo-relay.js";
export const lookupRelays$ = of([...LOOKUP_RELAYS]);

type Transport = (DemoRelay | LiveTransport) & {
  mode: "local" | "live";
  store: EventStore;
  controller: AbortController;
};

/** Transport is account-independent; only changing mode replaces the connection. */
export const transport$ = mode$.pipe(
  distinctUntilChanged(),
  switchMap(
    (mode) =>
      new Observable<Transport>((subscriber) => {
        const store = new EventStore();
        const controller = new AbortController();
        const transport = Object.assign(
          mode === "local" ? new DemoRelay() : new LiveTransport(store),
          { mode, store, controller },
        );
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

export const relays$ = transport$.pipe(
  map((transport) => [...transport.relays]),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const ready$ = transport$.pipe(
  switchMap((transport) =>
    defer(() => transport.ready).pipe(
      map(() => true),
      startWith(false),
      takeUntil(aborted$(transport.controller.signal)),
    ),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const state$ = transport$.pipe(
  switchMap((transport) =>
    stateObservable(
      () => ({
        transport: transport.transport,
        shared: transport.shared,
        tab: transport.tab,
        local: transport instanceof DemoRelay,
        paused: transport instanceof DemoRelay && transport.paused,
        queued: transport instanceof DemoRelay ? transport.queue.length : 0,
      }),
      (changed) => transport.onChange(changed),
      transport.controller.signal,
      (a, b) =>
        a.transport === b.transport &&
        a.shared === b.shared &&
        a.tab === b.tab &&
        a.paused === b.paused &&
        a.queued === b.queued,
    ),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const events$ = transport$.pipe(
  switchMap((transport) =>
    stateObservable(
      () => [...transport.events],
      (changed) => transport.onChange(changed),
      transport.controller.signal,
      sameItems,
    ),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const log$ = transport$.pipe(
  switchMap((transport) =>
    stateObservable(
      () => [...transport.log],
      (changed) => transport.onChange(changed),
      transport.controller.signal,
      sameItems,
    ),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const peers$ = transport$.pipe(
  switchMap((transport) =>
    stateObservable(
      () => (transport instanceof DemoRelay ? transport.peers : []),
      (changed) => transport.onChange(changed),
      transport.controller.signal,
      sameItems,
    ),
  ),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export async function setPaused(paused: boolean): Promise<void> {
  await firstValueFrom(
    transport$.pipe(
      map((transport) => {
        transport.controller.signal.throwIfAborted();
        if (transport instanceof DemoRelay) {
          transport.paused = paused;
          transport.flush();
        }
      }),
    ),
  );
}

export async function flush(): Promise<void> {
  await firstValueFrom(
    transport$.pipe(
      map((transport) => {
        transport.controller.signal.throwIfAborted();
        if (transport instanceof DemoRelay) transport.flush();
      }),
    ),
  );
}

function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
