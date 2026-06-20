/**
 * Graceful-shutdown helper for the residual background timers that keep the Bun
 * event loop alive after the app has otherwise torn everything down.
 *
 * Bun/Node keep the process running while any `setInterval`/`setTimeout` is still
 * pending. applesauce's relay layer runs RxJS `keepAlive` (30s) and liveness
 * (60s) timers via `share`/`shareReplay`, and the event-loader batches requests
 * with `bufferTime` (1s) — none of which are stopped by closing the relay pool.
 * `RelayPool` exposes only `remove()` (it closes the WebSocket but not these
 * shared interval chains, which can even reschedule *after* the socket closes),
 * and `EventStore` has no dispose, so there is no public API to stop them.
 *
 * Rather than reach into applesauce internals, we track every timer the process
 * starts and, once our own teardown has closed the real I/O (WebSockets, SQLite,
 * renderer, log file), {@link unrefBackgroundTimers} marks the survivors with
 * `unref()`. `unref()` does not cancel a timer or drop any unflushed state — it
 * only stops an idle in-memory timer from holding the loop open, so Bun can
 * drain and exit on its own. No `process.exit()`, no forced kill.
 *
 * Call {@link installTimerTracking} once, before anything else schedules timers.
 */

const liveTimers = new Set<{ unref?: () => void }>();
let installed = false;

/**
 * Wrap the global `setInterval`/`setTimeout` so every handle is recorded in a
 * registry (and removed on clear / on a one-shot timeout firing). Idempotent.
 */
export function installTimerTracking(): void {
  if (installed) return;
  installed = true;

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle = realSetInterval(fn, ms, ...args) as unknown as { unref?: () => void };
    liveTimers.add(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle) liveTimers.delete(handle as unknown as { unref?: () => void });
    return realClearInterval(handle);
  }) as typeof clearInterval;

  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    let handle: { unref?: () => void };
    const wrapped = (...a: unknown[]) => {
      liveTimers.delete(handle);
      return fn(...a);
    };
    handle = realSetTimeout(wrapped, ms, ...args) as unknown as { unref?: () => void };
    liveTimers.add(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
    if (handle) liveTimers.delete(handle as unknown as { unref?: () => void });
    return realClearTimeout(handle);
  }) as typeof clearTimeout;
}

/**
 * `unref()` every still-pending timer so it no longer keeps the event loop
 * alive. Run this only after all real teardown (sockets, SQLite, renderer, log)
 * has completed; the loop then drains and the process exits on its own.
 */
export function unrefBackgroundTimers(): void {
  for (const handle of liveTimers) handle.unref?.();
}
