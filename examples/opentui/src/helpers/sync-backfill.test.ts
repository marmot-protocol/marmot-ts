import { describe, expect, test } from "bun:test";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { SyncLoaderPool } from "applesauce-loaders/loaders";
import { EMPTY, Observable, from, throwError } from "rxjs";
import { syncBackfill } from "./sync-backfill.js";

const A = "wss://a.test";
const B = "wss://b.test";
async function signedEvent(
  created_at = 100,
  content = "encrypted",
): Promise<NostrEvent> {
  const account = PrivateKeyAccount.fromKey("01".repeat(32));
  return account.signer.signEvent({
    kind: 445,
    tags: [["h", "aa"]],
    content,
    created_at,
  });
}

describe("Applesauce backfill adapter", () => {
  test("uses negentropy and returns cached-in-run events again on the next run", async () => {
    const event = await signedEvent();
    let syncs = 0;
    let requests = 0;
    const pool: SyncLoaderPool = {
      relay: () => ({
        getSupported: async () => [77],
        request: () => {
          requests++;
          return EMPTY;
        },
        sync: (_store, _filter, direction) => {
          syncs++;
          expect(direction).toBeUndefined(); // Relay defaults to receive-only.
          return from([{ type: "received" as const, from: A, event }]);
        },
      }),
    };
    for (let i = 0; i < 2; i++) {
      const result = await syncBackfill(pool, [A], { kinds: [445] });
      expect(result.events).toEqual([event]);
      expect(result.relays).toEqual([
        { relay: A, status: "complete", eventIds: [event.id] },
      ]);
    }
    expect(syncs).toBe(2);
    expect(requests).toBe(0);
  });

  test("pages without NIP-77, retaining events despite a failed peer", async () => {
    const events = await Promise.all([
      signedEvent(100),
      signedEvent(101),
      signedEvent(102),
    ]);
    let requests = 0;
    const pool: SyncLoaderPool = {
      relay: (url) => ({
        getSupported: async () => [],
        getLimitations: async () => ({ max_limit: 2 }),
        sync: () => {
          throw new Error("unexpected sync");
        },
        request: (filters) => {
          if (url.startsWith(B)) return throwError(() => new Error("offline"));
          requests++;
          const filter = Array.isArray(filters) ? filters[0]! : filters;
          return from(
            events
              .filter((e) => e.created_at <= (filter.until ?? Infinity))
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, filter.limit),
          );
        },
      }),
    };
    const result = await syncBackfill(pool, [A, B], { kinds: [445], limit: 2 });
    expect(result.events).toHaveLength(3);
    expect(requests).toBeGreaterThan(1);
    expect(result.relays[0]!.status).toBe("incomplete");
    expect(result.relays[1]!.status).toBe("failed");
  });

  test("reports skipped relays without promoting done to complete", async () => {
    const pool: SyncLoaderPool = {
      filterRelays: () => [],
      relay: () => {
        throw new Error("unexpected connection");
      },
    };
    expect((await syncBackfill(pool, [A], {})).relays).toEqual([
      { relay: A, status: "skipped", eventIds: [] },
    ]);
  });

  test("a saturated second is incomplete even when the loader reports done", async () => {
    const events = await Promise.all([
      signedEvent(100, "one"),
      signedEvent(100, "two"),
    ]);
    const pool: SyncLoaderPool = {
      relay: () => ({
        getSupported: async () => [],
        getLimitations: async () => ({ max_limit: 2 }),
        sync: () => EMPTY,
        request: (filters) => {
          const filter = Array.isArray(filters) ? filters[0]! : filters;
          return from(filter.until === undefined ? events : []);
        },
      }),
    };
    const result = await syncBackfill(pool, [A], { kinds: [445] });
    expect(result.events).toHaveLength(2);
    expect(result.relays[0]!.status).toBe("incomplete");
  });

  test("a short page under a known cap can complete, and forwards AUTH", async () => {
    const event = await signedEvent();
    let authenticated = false;
    const pool: SyncLoaderPool = {
      relay: () => ({
        getSupported: async () => [],
        getLimitations: async () => ({ max_limit: 500 }),
        sync: () => EMPTY,
        request: (_filters, opts) => {
          expect(opts?.onAuthRequired).toBeTypeOf("function");
          void opts?.onAuthRequired?.({
            relay: {
              url: A,
              authenticate: async () => {},
              auth: async () => {},
            },
            url: A,
            challenge: null,
            requirement: true,
            missingPubkeys: null,
            reason: "auth-required",
          });
          return from([event]);
        },
      }),
    };
    const onAuthRequired = async () => {
      authenticated = true;
    };
    const result = await syncBackfill(pool, [A], {}, { onAuthRequired });
    expect(authenticated).toBe(true);
    expect(result.relays[0]!.status).toBe("complete");
  });

  test("aborting tears down an active request and rejects", async () => {
    const abort = new AbortController();
    let closed = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pool: SyncLoaderPool = {
      relay: () => ({
        getSupported: async () => [],
        request: () =>
          new Observable(() => {
            started();
            return () => {
              closed = true;
            };
          }),
        sync: () => EMPTY,
      }),
    };
    const pending = syncBackfill(pool, [A], {}, { signal: abort.signal });
    await ready;
    abort.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(closed).toBe(true);
  });
});
