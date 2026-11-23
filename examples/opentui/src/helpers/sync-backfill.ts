import { EventStore } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import { matchFilter } from "applesauce-core/helpers/filter";
import { defer, tap } from "rxjs";
import {
  createSyncLoader,
  type SyncAuthHandler,
  type SyncLoaderPool,
  type SyncLoaderStatus,
} from "applesauce-loaders/loaders";
import type {
  BackfillOptions,
  BackfillResult,
  RelayBackfillResult,
  Unsubscribable,
} from "@internet-privacy/marmot-ts/client";

/**
 * Receive-only history reconciliation. Each relay/run has an empty, isolated
 * store: events cached by discovery or an earlier interrupted ingest must not
 * be omitted from the history handed to Marmot. No shared cache is a durable
 * acknowledgement of MLS ingestion.
 */
export async function syncBackfill(
  pool: SyncLoaderPool,
  relays: string[],
  filter: Filter,
  options: BackfillOptions & { onAuthRequired?: SyncAuthHandler } = {},
): Promise<BackfillResult> {
  options.signal?.throwIfAborted();
  // A limit is a page-size hint, never a bound on the historical event set.
  const { limit, ...range } = filter;
  const results = await Promise.all(
    [...new Set(relays)].map(async (relay) => {
      const eventStore = new EventStore();
      let maxLimit: number | undefined;
      let uncertainPage = false;
      const load = createSyncLoader({
        eventStore,
        filterRelays: pool.filterRelays?.bind(pool),
        getSupported: (url) => pool.relay(url).getSupported(),
        getMaxLimit: async (url) => {
          const value = (await pool.relay(url).getLimitations?.())?.max_limit;
          maxLimit =
            value && Number.isSafeInteger(value) && value > 0
              ? value
              : undefined;
          return maxLimit;
        },
        sync: (url, filter, opts) =>
          pool.relay(url).sync(eventStore, filter, undefined, opts),
        request: (url, filters, opts) =>
          defer(() => {
            let count = 0;
            const page = filters[0]!;
            return pool
              .relay(url)
              .request(filters, opts)
              .pipe(
                tap({
                  next: (event) => {
                    count++;
                    if (!matchFilter(page, event)) uncertainPage = true;
                  },
                  complete: () => {
                    // Applesauce currently steps to oldest - 1 without exhausting
                    // the boundary second. A full page (or an unknown relay cap)
                    // cannot prove that it did not skip an event at that boundary.
                    if (
                      count > 0 &&
                      (maxLimit === undefined ||
                        count >= Math.min(page.limit ?? 500, maxLimit))
                    )
                      uncertainPage = true;
                  },
                }),
              );
          }),
      });
      const run = load({
        relays: [relay],
        filter: range,
        limit,
        onAuthRequired: options.onAuthRequired,
      });
      let latest: SyncLoaderStatus | undefined;
      let error: unknown;
      await new Promise<void>((resolve, reject) => {
        let subscription: Unsubscribable | undefined;
        let finished = false;
        const cleanup = () => {
          finished = true;
          subscription?.unsubscribe();
          options.signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(options.signal?.reason);
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) return abort();
        // status$ drives the shared loader and writes all events to this store.
        // Reading the store after completion also covers synchronous emissions.
        subscription = run.status$.subscribe({
          next: (status) => {
            latest = status;
          },
          error: (cause: unknown) => {
            error = cause;
            cleanup();
            resolve();
          },
          complete: () => {
            cleanup();
            resolve();
          },
        });
        if (finished) subscription.unsubscribe();
      });
      const events = eventStore.getByFilters(range);
      // The loader normalizes URLs, whereas the transport contract preserves
      // the caller's URL. A single-relay run has exactly one status entry.
      const statuses = Object.values(latest?.relays ?? {});
      const status = statuses.length === 1 ? statuses[0] : undefined;
      const base = { relay, eventIds: events.map((event) => event.id) };
      const outcome: RelayBackfillResult =
        error !== undefined
          ? { ...base, status: "failed", error }
          : status?.state === "complete" && uncertainPage
            ? {
                ...base,
                status: "incomplete",
                reason: "Paginated timestamp boundaries may be truncated",
              }
            : status?.state === "complete"
              ? { ...base, status: "complete" }
              : status?.state === "error"
                ? { ...base, status: "failed", error: status.error }
                : status?.state === "skipped"
                  ? { ...base, status: "skipped" }
                  : { ...base, status: "incomplete" };
      return { events, outcome };
    }),
  );
  options.signal?.throwIfAborted();
  const events = new Map<string, NostrEvent>();
  for (const result of results)
    for (const event of result.events) events.set(event.id, event);
  return {
    events: [...events.values()],
    relays: results.map((result) => result.outcome),
  };
}
