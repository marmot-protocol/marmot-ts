import { useEffect, useRef, useState } from "react";

/**
 * Consume an async iterable (e.g. an `async *` generator) into React state.
 *
 * This is the bridge that lets the marmot-ts library's async generators —
 * `client.groups.watch()` and `client.invites.watchUnread()` — drive a React
 * tree: every value the generator yields becomes a state update, and the
 * generator is properly `return()`-ed on unmount so its `finally` block runs
 * (detaching the library's internal event listeners).
 *
 * The `factory` is intentionally re-invoked only when `deps` change, so a fresh
 * generator is started on dependency changes and torn down on unmount.
 */
export function useAsyncIterable<T>(
  factory: () => AsyncIterable<T>,
  initial: T,
  deps: React.DependencyList = [],
): T {
  const [value, setValue] = useState<T>(initial);
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  useEffect(() => {
    let active = true;
    const iterator = factoryRef.current()[Symbol.asyncIterator]();

    (async () => {
      try {
        while (active) {
          const next = await iterator.next();
          if (next.done || !active) break;
          setValue(next.value);
        }
      } catch (err) {
        if (active) throw err;
      }
    })();

    return () => {
      active = false;
      // Resume the generator at its suspension point so `finally` runs and the
      // library can detach its listeners.
      void iterator.return?.(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
