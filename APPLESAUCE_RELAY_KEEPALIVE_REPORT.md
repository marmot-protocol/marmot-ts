# Bug report: `Relay.close()` leaves the `keepAlive` reset timer pending (30s shutdown hang)

**Package:** `applesauce-relay`
**Version observed:** `0.0.0-next-20260620175751`
**Reporter:** marmot-ts `examples/opentui` consumer

## TL;DR

After the `EventStore` + event-loader teardown you just shipped
(`EventStore.dispose()` / `Loader.stop()` / signal), the opentui example **still
hangs ~30s on quit**. The remaining leak is in the relay layer, not the loader:
`Relay.close()` does not cancel the `watchTower`'s `keepAlive` reset timer, so
each connected relay leaves a pending `timer(keepAlive)` (default **30000ms**)
holding the event loop open after `RelayPool.close()`.

We worked around it consumer-side with `new RelayPool({ keepAlive: 0 })`, but
that's a lever, not a fix — `close()` should be terminal regardless of
`keepAlive`.

## Root cause

In `relay.js` the health/watch pipeline is shared with a ref-count-zero reset
timer (line numbers from the installed dist):

```js
// relay.js ~421 — the watchTower's outer share
share({ resetOnRefCountZero: () => timer(this.keepAlive) })   // keepAlive = 30_000 (line ~175)
```

`share({ resetOnRefCountZero: () => timer(N) })` is the classic RxJS
"warm for N ms after the last unsubscribe" pattern. When the last subscriber
leaves, `share` subscribes to `timer(N)` and only resets the connector when it
fires. **That timer subscription is internal to `share` and has no external
handle.**

`Relay.close()` (line ~882) tears down everything *except* that timer:

```js
close() {
  this.reconnectSubscription?.unsubscribe();   // reconnect timer ✓
  this.reconnectSubscription = null;
  this.internalSubscriptions.unsubscribe();     // open/close/auth watchers ✓
  if (this.connected$.value) this.connected$.next(false);
  this.socket.unsubscribe();                     // websocket ✓
  // ✗ nothing cancels the watchTower keepAlive reset timer armed on refcount→0
}
```

The critical interaction: the refcount hits zero **precisely at teardown** (when
the loader and all app subscriptions unsubscribe), which *arms* the
`timer(30000)`. Then `close()` runs and doesn't cancel it. So the process waits
out the full `keepAlive` before the loop can drain.

(`enablePing` defaults to `false`, so the `timer(pingFrequency, pingFrequency)`
ping interval at line ~357 is *not* involved — confirmed via timer tracing.)

## Reproduction (pure `applesauce-relay`, no marmot)

```js
import { RelayPool } from "applesauce-relay/pool";

// trace timers so we can see survivors
const live = new Set();
const _si = setInterval, _st = setTimeout;
globalThis.setInterval = (f, ms, ...a) => { const h = _si(f, ms, ...a); live.add([h, ms]); return h; };
globalThis.setTimeout  = (f, ms, ...a) => { const h = _st(f, ms, ...a); live.add([h, ms]); return h; };

const pool = new RelayPool();                  // default keepAlive: 30000
const sub = pool.subscription(["wss://relay.damus.io"], { kinds: [1], limit: 1 })
  .subscribe(() => {});

await new Promise((r) => _st(r, 2000));
sub.unsubscribe();                             // refcount → 0, arms timer(30000)
pool.close();                                  // does NOT cancel it

await new Promise((r) => _st(r, 500));
console.log([...live].filter(([, ms]) => ms === 30000).length, "× 30000ms timers survive");
// Intentionally no process.exit() — process hangs ~30s, then exits when the timer fires.
```

In the opentui app (≈5 relays connected) this prints **5 × 30000ms timers
survive**, and the TUI hangs ~30s on quit. Setting `new RelayPool({ keepAlive: 0 })`
makes it `0 survive` and exit immediately.

## Expected behavior

`Relay.close()` (and therefore `RelayPool.close()` → `remove(relay, true)`) is
documented as: *"Force close the connection and tear down all internal
subscriptions and timers."* The `keepAlive` reset timer is one of those timers
and should be cancelled, so `close()` is fully terminal and the host process can
exit without waiting out `keepAlive`.

## Suggested fix

Give the reset timer (and any other watchTower-internal timers) a teardown
signal that `close()` fires. Minimal sketch:

```js
// field
#destroy$ = new Subject();

// watchTower share — cancel the warm-up timer when the relay is closed
share({ resetOnRefCountZero: () => timer(this.keepAlive).pipe(takeUntil(this.#destroy$)) })

// close()
close() {
  this.#destroy$.next();          // cancels any pending keepAlive reset timer
  this.reconnectSubscription?.unsubscribe();
  this.reconnectSubscription = null;
  this.internalSubscriptions.unsubscribe();
  if (this.connected$.value) this.connected$.next(false);
  this.socket.unsubscribe();
}
```

(You may already have a suitable subject — `close$` is the *socket*-closed
signal, which isn't quite the same as "relay destroyed", so a dedicated
destroy/teardown subject is cleaner. An `AbortSignal`-based variant would also
work and would compose with the loader-signal teardown you just added.)

## Consumer workaround currently in place (to be removed once fixed)

`examples/opentui/src/marmot/setup.ts`:

```js
// keepAlive: 0 so the relay health-watcher tears down immediately on quit
// instead of holding a 30s timer that close() doesn't cancel.
const nostr = new RelayPool({ keepAlive: 0 });
```

Once `close()` cancels the reset timer, we can drop `{ keepAlive: 0 }` and rely
on the default warmth behavior.
