import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmot-ts";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type DependencyList,
} from "react";
import type { DemoTransport } from "./transport.js";

/** Snapshot of every loaded group; re-renders only when one changes. */
export function useGroups(client: MarmotClient) {
  const subscribe = useCallback(
    (notify: () => void) => {
      client.groups.on("changed", notify);
      return () => void client.groups.off("changed", notify);
    },
    [client],
  );
  return useSyncExternalStore(subscribe, () => client.groups.snapshot);
}

/** Reactive snapshot of a single group. */
export function useGroupSnapshot(group: MarmotGroup) {
  const subscribe = useCallback(
    (notify: () => void) => {
      group.on("changed", notify);
      return () => void group.off("changed", notify);
    },
    [group],
  );
  return useSyncExternalStore(subscribe, () => group.snapshot);
}

/**
 * Consume one of the library's `watch*()` async generators. `start` receives
 * an AbortSignal that is aborted on unmount or when `deps` change.
 */
export function useWatch<T>(
  start: (signal: AbortSignal) => AsyncIterable<T>,
  deps: DependencyList,
): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        for await (const next of start(controller.signal)) setValue(next);
      } catch (error) {
        if (!controller.signal.aborted) console.error(error);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

/** Re-render whenever the demo relay sees traffic. */
export function useRelay<T extends DemoTransport>(relay: T): T {
  useSyncExternalStore(
    useCallback((notify) => relay.onChange(notify), [relay]),
    () => relay.version,
  );
  return relay;
}

/**
 * Run async setup once per mount (e.g. creating actors). Returns `undefined`
 * until it resolves, and the error if it throws.
 */
export function useSetup<T>(setup: () => Promise<T>): {
  value?: T;
  error?: unknown;
} {
  const [state, setState] = useState<{ value?: T; error?: unknown }>({});
  useEffect(() => {
    let live = true;
    setup().then(
      (value) => live && setState({ value }),
      (error) => live && setState({ error }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
