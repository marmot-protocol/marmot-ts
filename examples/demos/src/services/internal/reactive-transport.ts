import type { DemoTransport } from "./transport.js";
import { DemoRelay } from "./relay/demo-relay.js";
import { defer, map, of, shareReplay, startWith, takeUntil } from "rxjs";
import { aborted$, stateObservable } from "../../utils/observable.js";

/** Copy mutable relay arrays so previous emissions remain stable snapshots. */
export function reactiveTransport(
  transport: DemoTransport,
  lifetime: AbortSignal,
) {
  const listen = (changed: () => void) => transport.onChange(changed);
  return {
    relays$: of([...transport.relays]).pipe(takeUntil(aborted$(lifetime))),
    ready$: defer(() => transport.ready).pipe(
      map(() => true),
      startWith(false),
      takeUntil(aborted$(lifetime)),
      shareReplay({ bufferSize: 1, refCount: true }),
    ),
    state$: stateObservable(
      () => ({
        transport: transport.transport,
        shared: transport.shared,
        tab: transport.tab,
        local: transport instanceof DemoRelay,
        paused: transport instanceof DemoRelay && transport.paused,
        queued: transport instanceof DemoRelay ? transport.queue.length : 0,
      }),
      listen,
      lifetime,
      (a, b) =>
        a.transport === b.transport &&
        a.shared === b.shared &&
        a.tab === b.tab &&
        a.paused === b.paused &&
        a.queued === b.queued,
    ),
    events$: stateObservable(
      () => [...transport.events],
      listen,
      lifetime,
      sameItems,
    ),
    log$: stateObservable(
      () => [...transport.log],
      listen,
      lifetime,
      sameItems,
    ),
    peers$: stateObservable(
      () => (transport instanceof DemoRelay ? transport.peers : []),
      listen,
      lifetime,
      sameItems,
    ),
    setPaused(paused: boolean) {
      lifetime.throwIfAborted();
      if (transport instanceof DemoRelay) {
        transport.paused = paused;
        transport.flush();
      }
    },
    flush() {
      lifetime.throwIfAborted();
      if (transport instanceof DemoRelay) transport.flush();
    },
  } as const;
}

function sameItems<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export type ReactiveTransport = ReturnType<typeof reactiveTransport>;
