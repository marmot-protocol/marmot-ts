import { useEffect, useMemo, useState, type DependencyList } from "react";

/** Renders the latest watcher snapshot; aborts on input changes and throws failures during render. */
export function useAsyncLatest<T>(
  start: (signal: AbortSignal) => AsyncIterable<T>,
  dependencies: DependencyList,
): T | undefined {
  // The caller's dependencies define when this watcher is replaced.
  const source = useMemo(() => ({ start }), dependencies);
  const [snapshot, setSnapshot] = useState<
    | { source: typeof source; value: T; failed: false }
    | { source: typeof source; error: unknown; failed: true }
  >();

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        for await (const value of source.start(controller.signal)) {
          if (controller.signal.aborted) break;
          setSnapshot({ source, value, failed: false });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setSnapshot({ source, error, failed: true });
      }
    })();

    return () => controller.abort();
  }, [source]);

  // Never render a previous account/group's snapshot while its replacement loads.
  if (snapshot?.source !== source) return undefined;
  if (snapshot.failed) throw snapshot.error;
  return snapshot.value;
}
