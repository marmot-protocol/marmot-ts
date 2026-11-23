import {
  BehaviorSubject,
  Observable,
  combineLatest,
  fromEvent,
  map,
  of,
  shareReplay,
  takeUntil,
} from "rxjs";
import { DEMO_RELAY_CHANNEL } from "./internal/relay/demo-relay.js";
import type {
  InspectorResponse,
  RelayState,
} from "./internal/relay/relay-inspector.js";

export type { RelayLogEntry } from "./internal/relay/relay-inspector.js";
export type { RelayState } from "./internal/relay/relay-inspector.js";

const errors = new BehaviorSubject<string | undefined>(undefined);
const received = new BehaviorSubject(0);
const resetting = new BehaviorSubject(false);
const clock = new BehaviorSubject(Date.now());
let worker: SharedWorker | undefined;

export const channel$ = of(DEMO_RELAY_CHANNEL);
export const error$ = errors.asObservable();
export const receivedAt$ = received.asObservable();
export const resetting$ = resetting.asObservable();

/** Anonymous inspector connection; it does not subscribe to accounts or the demo client. */
export const state$ = new Observable<RelayState | undefined>((subscriber) => {
  subscriber.next(undefined);
  received.next(0);
  resetting.next(false);
  errors.next(undefined);
  if (typeof SharedWorker === "undefined") {
    errors.next(
      "SharedWorker is unavailable. Open this view in a browser with SharedWorker support.",
    );
    return;
  }
  let relay: SharedWorker;
  try {
    relay = new SharedWorker(
      new URL("./internal/relay/demo-relay.worker.ts", import.meta.url),
      { type: "module", name: DEMO_RELAY_CHANNEL },
    );
  } catch (cause) {
    errors.next(String(cause));
    return;
  }
  worker = relay;
  relay.onerror = () =>
    errors.next("Relay worker failed. Reload this view to reconnect.");
  relay.port.onmessage = ({ data }: MessageEvent<InspectorResponse>) => {
    if (subscriber.closed || data.type !== "relay-state") return;
    received.next(Date.now());
    errors.next(undefined);
    resetting.next(false);
    subscriber.next(data.state);
  };
  relay.port.start();
  const inspect = () => {
    clock.next(Date.now());
    relay.port.postMessage({ type: "inspect" });
  };
  inspect();
  const timer = setInterval(inspect, 2000);
  return () => {
    clearInterval(timer);
    relay.port.postMessage({ type: "disconnect" });
    relay.port.close();
    if (worker === relay) worker = undefined;
  };
}).pipe(
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export const healthy$ = combineLatest([
  state$,
  receivedAt$,
  clock,
  error$,
]).pipe(map(([state, at, now, error]) => !!state && now - at < 6000 && !error));

export async function resetRelay(): Promise<void> {
  if (!worker) throw new Error("Relay inspector is not connected");
  resetting.next(true);
  worker.port.postMessage({ type: "reset" });
}
