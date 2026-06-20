# applesauce — process does not exit cleanly after closing the relay pool

**Reporter:** marmot-ts `examples/opentui` (a Bun + OpenTUI Nostr chat client)
**Date:** 2026-06-20
**Severity:** Medium — no crash or data loss, but any non-daemon process (CLI/TUI,
tests, scripts) that uses applesauce **hangs on exit** instead of terminating,
unless it force-kills itself with `process.exit()`.

**Versions observed**

| package | version |
|---|---|
| applesauce-relay | 6.0.3 |
| applesauce-core | 6.1.0 |
| applesauce-loaders | 6.1.0 |
| rxjs | 7.8.2 |
| runtime | Bun 1.3.14 (also relevant to Node) |

---

## TL;DR

After a consumer does everything it can to shut down — closes every relay
(`RelayPool.remove(relay, true)`), unsubscribes all of its own subscriptions,
and drops the `EventStore` — **the Node/Bun event loop stays alive** and the
process never exits.

The cause is **RxJS timer-driven subscriptions inside applesauce that are never
torn down**:

1. **`Relay.close()` is incomplete.** It only calls `this.socket.unsubscribe()`.
   The relay's `keepAlive`, ping, liveness and (critically) **reconnect** timers
   are *separate* subscriptions that keep running. Some even **reschedule
   themselves *after* `close()`**.
2. **`RelayPool` has no full teardown.** Its only lifecycle method is
   `remove()`; there is no `pool.close()/destroy()/dispose()`.
3. **`EventStore` has no `dispose()`**, and the unified event-loader installed
   via `createEventLoaderForStore` keeps a long-lived `bufferTime(1000)`
   batching pipeline alive.

None of this is reachable through public API, so a consumer literally cannot
shut applesauce down cleanly today.

---

## Why this matters / who hits it

Long-lived browser apps never notice (the tab just closes). But anything with a
finite lifetime does:

- CLIs and TUIs that should exit when the user quits.
- Vitest/Jest/Bun test suites — leaked timers cause "did not exit / open handle"
  warnings or hangs.
- One-shot scripts, cron jobs, serverless/worker invocations.

Our workaround (below) is to `unref()` the leaked timers, but that's papering
over the fact that the subscriptions are still live.

---

## Reproduction (no UI, no marmot — pure applesauce)

```ts
// bun run repro.ts   (also reproduces under node via ws polyfill)
import { RelayPool } from "applesauce-relay/pool";
import { EventStore } from "applesauce-core/event-store";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";

const pool = new RelayPool();
const store = new EventStore();
createEventLoaderForStore(store, pool, { extraRelays: ["wss://relay.damus.io"] });

// do some normal work so connections + loaders spin up
await new Promise<void>((resolve) => {
  pool.subscription(["wss://relay.damus.io"], { kinds: [1], limit: 1 }).subscribe({
    next: () => {},
    complete: () => resolve(),
    error: () => resolve(),
  });
  setTimeout(resolve, 3000);
});

// full shutdown, by the book
for (const relay of [...pool.relays.values()]) pool.remove(relay, true);

console.log("shut down — process should now exit");
// EXPECTED: process exits.
// ACTUAL:   process hangs forever (until SIGINT).
```

### How to see the leaked handles

`process.getActiveResourcesInfo()` is **useless on Bun** — it returns `[]` while
the loop is demonstrably held open. Monkeypatch the timer globals instead:

```ts
const live = new Map<any, {kind:string; ms?:number}>();
const _si = globalThis.setInterval, _ci = globalThis.clearInterval;
const _st = globalThis.setTimeout,  _ct = globalThis.clearTimeout;
globalThis.setInterval = ((f:any,ms?:any,...a:any[])=>{const h=_si(f,ms,...a);live.set(h,{kind:"interval",ms});return h;}) as any;
globalThis.clearInterval = ((h:any)=>{live.delete(h);return _ci(h);}) as any;
globalThis.setTimeout = ((f:any,ms?:any,...a:any[])=>{let h:any;const w=(...x:any[])=>{live.delete(h);return f(...x);};h=_st(w,ms,...a);live.set(h,{kind:"timeout",ms});return h;}) as any;
globalThis.clearTimeout = ((h:any)=>{live.delete(h);return _ct(h);}) as any;
// ...after shutdown, inspect `live` — every entry is something applesauce left running.
```

### Observed survivors (our app, after a normal `start()` → `stop()`)

```
9 timer handles survived full teardown:
  setInterval  1000ms   x2   created during steady-state   → loader bufferTime
  setInterval 30000ms   x4   (some created AFTER stop())    → relay keepAlive / liveness
  setInterval 60000ms   x2                                  → relay liveness
  setInterval  5000ms   x1
```

WebSockets *do* close correctly (3 → 0). The leak is **purely timers**.

---

## Root-cause detail, with source pointers

All paths below are in the published `dist/` of each package.

### 1. `Relay.close()` only unsubscribes the socket

`applesauce-relay/dist/relay.js`

```js
// ~L866
close() {
    this.socket.unsubscribe();
}
```

But the constructor and operators wire up several *independent*, timer-bearing
subscriptions that `close()` never touches:

- **keepAlive** — `applesauce-relay/dist/relay.js` ~L417:
  ```js
  share({ resetOnRefCountZero: () => timer(this.keepAlive) }))  // keepAlive = 30_000 (L175)
  ```
- **ping health check** — `relay.js` ~L345–397: `this.connected$.pipe(switchMap(() =>
  timer(this.pingFrequency, this.pingFrequency) ...))` (`pingFrequency = 29_000`,
  L179; `enablePing = false` by default, but on when configured).
- **reconnect timer — the clearest bug** — `relay.js` ~L423–433:
  ```js
  startReconnectTimer(error) {
      if (!this.ready) return;
      this.error$.next(...);
      this._ready$.next(false);
      this.reconnectTimer(error, this.attempts$.value)   // timer(delay), delay up to 300000ms (L890 createReconnectTimer)
          .pipe(take(1))
          .subscribe(() => { this._ready$.next(true); }); // <-- subscription is NOT retained anywhere
  }
  ```
  This subscription is fire-and-forget: the `Subscription` is never stored, so
  there is nothing to unsubscribe, and `close()` cannot cancel it. It is armed
  on any unclean disconnect (`relay.js` ~L262–264, `if (!event.wasClean)
  this.startReconnectTimer(event)`) and on connection error (~L411–413). A relay
  that drops mid-session leaves a **up-to-5-minute `setTimeout`** holding the
  loop open even after the consumer "closed" everything.

The "some 30s intervals are created *after* `close()`" observation is consistent
with these chains still reacting to `connected$`/`close$` emissions during
teardown and re-arming.

### 2. `RelayPool` has no full teardown

`applesauce-relay/dist/pool.js`

```js
// the ONLY lifecycle method:
remove(relay, close = true) {
    ...
    if (close) instance?.close();      // delegates to the incomplete close() above
    this.relays.delete(instance.url);
    this.relays$.next(this.relays);
    this.remove$.next(instance);
}
```

There is no `pool.close()/destroy()`. Also `status$` is built with
`shareReplay(1)` in the constructor; once subscribed it keeps its upstream alive.
A consumer has no single call to dispose the pool.

### 3. EventStore loader keeps a `bufferTime` pipeline alive

`applesauce-loaders/dist/loaders/unified-event-loader.js` L42:

```js
export function createEventLoaderForStore(store, pool, opts) {
    const loader = createUnifiedEventLoader(pool, { ...opts, eventStore: store });
    store.eventLoader = loader;
    return loader;
}
```

The underlying loaders batch with `bufferTime(opts?.bufferTime ?? 1000, ...)`:
- `applesauce-loaders/dist/loaders/event-loader.js` L78
- `applesauce-loaders/dist/loaders/address-loader.js` L104

These are the surviving **1000ms** intervals. `EventStore` exposes no
`dispose()` and the loader pipeline is never completed, so the batching
subscription (and its scheduler timer) lives forever.

### 4. (Adjacent) EventStore model keep-warm timers

`applesauce-core/dist/event-store/event-models.js` L57–58 uses
`resetOnComplete: () => timer(this.modelKeepWarm)` /
`resetOnRefCountZero: () => timer(this.modelKeepWarm)`. These are one-shot
`timer()`s (bounded), so they self-clear, but they extend the time-to-idle after
the UI unmounts and are worth keeping in mind for a deterministic shutdown story.

---

## Suggested fixes (for the applesauce maintainer)

Ordered by leverage:

1. **Make `Relay.close()` actually tear the relay down.** Retain every
   long-lived subscription created for a relay (keepAlive `share`, ping,
   **reconnect**, the eager `open$/close$` subscriptions) in an internal
   `Subscription`, and have `close()` call `subscription.unsubscribe()` in
   addition to `socket.unsubscribe()`. In particular, store the reconnect
   subscription from `startReconnectTimer` and cancel/replace it (it should also
   be cancelled on a clean `close()` and on successful reconnect).

2. **Add `RelayPool.close()/destroy()`** that removes+closes every relay,
   completes `add$`/`remove$`/`relays$`, and tears down `status$`. Give consumers
   one call for "I'm done with this pool."

3. **Add a `dispose()`/`destroy()` to `EventStore`** (or have the loader return a
   teardown handle) that completes the loader's `bufferTime` pipeline and any
   model keep-warm subscriptions. `createEventLoaderForStore` currently returns
   the loader but no way to detach it.

4. **Consider `.unref()`-ing internal interval timers by default**, or exposing
   an option to. Pure-timer/no-I/O background work generally shouldn't keep a
   process alive; this single change would make applesauce "just exit" for all
   non-browser consumers even before the structural fixes above land. (rxjs
   timers created via the async scheduler don't expose the handle to the
   consumer, so this has to happen inside applesauce or via a custom scheduler.)

5. **Docs:** whichever lands, document the canonical shutdown sequence
   ("dispose loaders → close pool → dispose store").

### Investigation notes for whoever picks this up

- rxjs's async scheduler creates its `setInterval`/`setTimeout` lazily inside its
  own recursion, so a creation stack trace shows only rxjs internals — it will
  **not** point at the subscriber. Attribute by **period** and by **toggling
  features** (e.g. set `keepAlive`/`enablePing`, add/remove the loader) and
  re-counting survivors, rather than by stack.
- Verify each fix by asserting the process exits with **no** `process.exit()` and
  **no** unref hack: a clean drain is the pass condition; a hang is the failure.
- Don't trust `process.getActiveResourcesInfo()` on Bun (returns `[]`). Use the
  timer-global monkeypatch above, or run under Node with `why-is-node-running`.

---

## Consumer-side workaround currently in use (for context)

We could not reach the leaked subscriptions, so after closing all real I/O
(WebSockets, SQLite, renderer, log file) we `unref()` the residual timers so the
loop drains naturally — **no `process.exit()`, no dropped state**:

- `examples/opentui/src/helpers/timers.ts` — wraps the timer globals into a
  registry (`installTimerTracking()`) and `unref()`s survivors at quit
  (`unrefBackgroundTimers()`).
- `examples/opentui/src/index.tsx` — installs tracking first thing in `main()`;
  calls `unrefBackgroundTimers()` at the end of the quit handler.
- `examples/opentui/scripts/probe-shutdown.ts` — standalone regression probe:
  builds + starts + stops the stack with no forced exit; a clean exit means
  shutdown is healthy, a timeout means a leak is back.

This workaround is exactly what we'd like to delete once applesauce can be shut
down through its own API.
```
