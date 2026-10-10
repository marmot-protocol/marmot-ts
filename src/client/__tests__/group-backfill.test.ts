import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import { describe, expect, it, vi } from "vitest";

import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import type { SerializedClientState } from "../../core/client-state.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import {
  BACKFILL_FUTURE_SKEW_SECONDS,
  BACKFILL_MAX_HOLD_BACK_SECONDS,
  backfillCursorKey,
  backfillProgressKey,
  decodeBackfillCursor,
  decodeBackfillProgress,
  encodeBackfillCursor,
  fetchPagedBackfill,
  nextBackfillCursor,
} from "../group-backfill.js";
import { GroupsManager } from "../groups-manager.js";
import type { NostrNetworkInterface } from "../nostr-interface.js";
import { fakeVerifyEvent, type VerifyEventMethod } from "../verify.js";

const RELAY = "wss://relay.test";
const RELAY_B = "wss://relay-b.test";
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A MockNetwork whose `request` behaves like a real relay: honours `since`,
 * `until` (inclusive) and `limit`, returning newest-first. `relayCaps` lets a
 * relay cap results below the requested `limit`. Every request filter is
 * recorded.
 */
class PagingNetwork extends MockNetwork {
  readonly requests: { relays: string[]; filter: Filter }[] = [];
  readonly relayEvents = new Map<string, NostrEvent[]>();
  readonly relayCaps = new Map<string, number>();
  /** Relays that answer as if `until` were absent. */
  readonly ignoresUntil = new Set<string>();
  /** Relays that answer as if `limit` were absent. */
  readonly ignoresLimit = new Set<string>();
  /** Relays whose requests reject, as an unreachable relay's would. */
  readonly unreachable = new Set<string>();
  /** Filters of every live subscription opened. */
  readonly subscriptions: Filter[] = [];

  override subscription(relays: string[], filters: Filter | Filter[]) {
    this.subscriptions.push(...(Array.isArray(filters) ? filters : [filters]));
    return super.subscription(relays, filters);
  }

  override async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    const filter = (Array.isArray(filters) ? filters[0] : filters)!;
    this.requests.push({ relays, filter });
    if (this.unreachable.has(relays[0]!)) throw new Error("unreachable");
    const source =
      relays.length === 1 && this.relayEvents.has(relays[0]!)
        ? this.relayEvents.get(relays[0]!)!
        : await super.request(relays, { ...filter, limit: undefined });
    const relay = relays[0]!;
    const cap = Math.min(
      this.ignoresLimit.has(relay) ? Infinity : (filter.limit ?? Infinity),
      this.relayCaps.get(relay) ?? Infinity,
    );
    const until = this.ignoresUntil.has(relay) ? undefined : filter.until;
    return source
      .filter(
        (e) =>
          (filter.since === undefined || e.created_at >= filter.since) &&
          (until === undefined || e.created_at <= until),
      )
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
      .slice(0, cap);
  }
}

function fakeEvent(id: number, createdAt: number): NostrEvent {
  return {
    id: id.toString(16).padStart(64, "0"),
    pubkey: "0".repeat(64),
    created_at: createdAt,
    kind: 445,
    tags: [["h", "aa"]],
    content: "",
    sig: "0".repeat(128),
  };
}

function newStores() {
  return {
    store: new InMemoryKeyValueStore<SerializedClientState>(),
    ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
    lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
  };
}

function makeManager(
  network: NostrNetworkInterface,
  stores = newStores(),
  verifyEvent: VerifyEventMethod = fakeVerifyEvent,
) {
  return new GroupsManager({
    ...stores,
    ingestPersistence: { kind: "durable" },
    signer: testAccount(0).signer,
    network,
    verifyEvent,
  });
}

/**
 * Creates a group and publishes `count` application messages, then re-dates
 * them one second apart (newest = `newest`) so pages have distinct
 * boundaries. `fakeVerifyEvent` keeps the re-dated events admissible.
 */
async function groupWithHistory(
  network: PagingNetwork,
  count: number,
  newest: number,
  verifyEvent?: VerifyEventMethod,
  relays = [RELAY],
) {
  const stores = newStores();
  const { ingestStateStore } = stores;
  const manager = makeManager(network, stores, verifyEvent);
  const group = await manager.create("Backfill Group", { relays });
  for (let i = 0; i < count; i++) {
    await manager.send(group.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode(`message ${i}`),
    });
  }
  const groupEvents = network.events.filter((e) => e.kind === 445);
  expect(groupEvents).toHaveLength(count);
  groupEvents.forEach((event, i) => {
    event.created_at = newest - (count - 1 - i);
  });
  return { manager, group, groupEvents, ingestStateStore, stores };
}

/**
 * Another group's application message, re-tagged into the group of
 * `template` and dated `createdAt`: this group cannot decrypt it. It is
 * removed from the network's stored events, so only the caller delivers it.
 */
async function foreignEvent(
  network: PagingNetwork,
  template: NostrEvent,
  createdAt: number,
): Promise<NostrEvent> {
  const other = makeManager(network);
  const otherGroup = await other.create("Other", { relays: [RELAY] });
  await other.send(otherGroup.id, {
    kind: "applicationMessage",
    payload: new TextEncoder().encode("foreign"),
  });
  const foreign = network.events.pop()!;
  foreign.tags = template.tags.map((tag) => [...tag]);
  foreign.created_at = createdAt;
  return foreign;
}

describe("fetchPagedBackfill", () => {
  it("stops paging once the signal is aborted", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(
      RELAY,
      Array.from({ length: 6 }, (_, i) => fakeEvent(i + 1, 1000 + i)),
    );
    const controller = new AbortController();
    const request = network.request.bind(network);
    network.request = async (relays, filters) => {
      controller.abort();
      return request(relays, filters);
    };

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      { kinds: [445], "#h": ["aa"] },
      { pageSize: 2, maxPages: 20, signal: controller.signal },
    );

    expect(network.requests).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([{ relay: RELAY, status: "failed" }]);
  });

  it("pages each relay independently down to its oldest event", async () => {
    const network = new PagingNetwork();
    const a = Array.from({ length: 7 }, (_, i) => fakeEvent(i + 1, 1000 + i));
    const b = Array.from({ length: 4 }, (_, i) => fakeEvent(i + 100, 900 + i));
    network.relayEvents.set("wss://a", a);
    network.relayEvents.set("wss://b", b);
    // Relay A caps below the requested limit: its short pages must not be
    // mistaken for the end of its history.
    network.relayCaps.set("wss://a", 2);

    const result = await fetchPagedBackfill(
      network,
      ["wss://a", "wss://b"],
      { kinds: [445], "#h": ["aa"] },
      { pageSize: 3, maxPages: 20 },
    );

    expect(result.complete).toBe(true);
    expect(new Set(result.events.map((e) => e.id))).toEqual(
      new Set([...a, ...b].map((e) => e.id)),
    );
    expect(network.requests.every((r) => r.filter.limit === 3)).toBe(true);
    expect(network.requests.every((r) => r.relays.length === 1)).toBe(true);
  });

  it("re-reads a page boundary that splits one second", async () => {
    const network = new PagingNetwork();
    // The first page (limit 3) ends inside second 500, cutting event 4 off.
    // An exclusive `until` (499) would skip it.
    const events = [
      fakeEvent(1, 502),
      fakeEvent(2, 501),
      fakeEvent(3, 500),
      fakeEvent(4, 500),
      fakeEvent(5, 499),
    ];
    network.relayEvents.set(RELAY, events);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      {
        pageSize: 3,
        maxPages: 20,
      },
    );

    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(5);
  });

  it("reports a saturated second instead of a complete backfill", async () => {
    const network = new PagingNetwork();
    // Second 700 holds more events (4) than one page (2) can return, so
    // paging by `until` cannot enumerate all of them.
    const events = [
      fakeEvent(1, 701),
      ...[2, 3, 4, 5].map((id) => fakeEvent(id, 700)),
      fakeEvent(6, 699),
    ];
    network.relayEvents.set(RELAY, events);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 2, maxPages: 20 },
    );

    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([{ relay: RELAY, status: "saturated" }]);
    // The walk still continues below the saturated second.
    expect(result.events.map((e) => e.created_at)).toContain(699);
  });

  it("does not report a short history as saturated", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set("wss://one", [fakeEvent(1, 800)]);
    // A short history entirely within one second, well under `pageSize`.
    network.relayEvents.set(
      "wss://same-second",
      [2, 3, 4].map((id) => fakeEvent(id, 900)),
    );

    const result = await fetchPagedBackfill(
      network,
      ["wss://one", "wss://same-second"],
      {},
      { pageSize: 500, maxPages: 20 },
    );

    expect(result.complete).toBe(true);
    expect(result.events).toHaveLength(4);
  });

  it("does not report a one-second history at an unknown relay cap as complete", async () => {
    const network = new PagingNetwork();
    // The relay returns at most 120 events per request and its whole history
    // lies in second 700, so no response ever proves the cap.
    network.relayEvents.set(
      "wss://a",
      Array.from({ length: 150 }, (_, i) => fakeEvent(i + 1, 700)),
    );
    network.relayCaps.set("wss://a", 120);
    // Another relay holds newer events, which would advance the cursor.
    network.relayEvents.set("wss://b", [
      fakeEvent(1001, 2001),
      fakeEvent(1002, 2000),
    ]);

    const result = await fetchPagedBackfill(
      network,
      ["wss://a", "wss://b"],
      {},
      { pageSize: 500, maxPages: 20 },
    );

    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([
      { relay: "wss://a", status: "saturated" },
      { relay: "wss://b", status: "complete" },
    ]);
  });

  it("detects saturation at a relay cap confirmed below `pageSize`", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(RELAY, [
      fakeEvent(1, 701),
      ...[2, 3, 4, 5].map((id) => fakeEvent(id, 700)),
      fakeEvent(6, 699),
    ]);
    // The relay returns at most 2 events per request, whatever the limit.
    network.relayCaps.set(RELAY, 2);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 10, maxPages: 20 },
    );

    expect(result.relays).toEqual([{ relay: RELAY, status: "saturated" }]);
  });

  it("rechecks a boundary stepped past before the relay cap was confirmed", async () => {
    const network = new PagingNetwork();
    // Second 700 overflows a relay cap (2) below `pageSize` (10). The walk
    // steps past 700 before 699 proves the cap; 700 must then count as
    // saturated, not silently complete with two events missing.
    network.relayEvents.set(RELAY, [
      ...[1, 2, 3, 4].map((id) => fakeEvent(id, 700)),
      fakeEvent(5, 699),
    ]);
    network.relayCaps.set(RELAY, 2);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 10, maxPages: 20 },
    );

    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([{ relay: RELAY, status: "saturated" }]);
  });

  it("resumes below a range an earlier capped backfill fetched", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(
      RELAY,
      Array.from({ length: 10 }, (_, i) => fakeEvent(i + 1, 1000 + i)),
    );

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      {
        pageSize: 2,
        maxPages: 3,
        resume: new Map([[RELAY, { from: 1002, to: 1009 }]]),
      },
    );

    // Head page, then straight to the resume point: no re-read of 1003-1007.
    expect(network.requests.map((r) => r.filter.until)).toEqual([
      undefined,
      1002,
      1001,
    ]);
    expect(result.relays).toEqual([
      { relay: RELAY, status: "capped", until: 1000 },
    ]);
  });

  it("keeps the genuine copy whichever relay returns a forged one", async () => {
    const genuine = fakeEvent(1, 1000);
    const newer = fakeEvent(2, 2000);
    const forged = { ...genuine, content: "forged" };
    const accept = (event: NostrEvent) => event !== forged;

    for (const relays of [
      ["wss://a", "wss://b"],
      ["wss://b", "wss://a"],
    ]) {
      const network = new PagingNetwork();
      network.relayEvents.set("wss://a", [genuine, newer]);
      network.relayEvents.set("wss://b", [forged, newer]);

      const result = await fetchPagedBackfill(
        network,
        relays,
        {},
        {
          pageSize: 10,
          maxPages: 20,
          accept,
        },
      );

      expect(result.complete).toBe(true);
      expect(result.events).toHaveLength(2);
      expect(result.events).toContain(genuine);
      expect(result.events).not.toContain(forged);
    }
  });

  it("keeps the genuine copy when one relay returns a forged copy first", async () => {
    const genuine = fakeEvent(1, 1000);
    // Same id, re-dated so the relay returns it ahead of the genuine event.
    const forged = { ...genuine, created_at: 1500 };
    const network = new PagingNetwork();
    network.relayEvents.set(RELAY, [genuine, forged, fakeEvent(2, 2000)]);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      {
        pageSize: 10,
        maxPages: 20,
        accept: (event) => event !== forged,
      },
    );

    expect(result.events).toHaveLength(2);
    expect(result.events).toContain(genuine);
    expect(result.events).not.toContain(forged);
  });

  it("fails a relay that ignores `until`", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(RELAY, [
      fakeEvent(1, 2000),
      fakeEvent(2, 1900),
      fakeEvent(3, 1000),
    ]);
    network.ignoresUntil.add(RELAY);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 2, maxPages: 20 },
    );

    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([{ relay: RELAY, status: "failed" }]);
  });

  it("keeps at most `pageSize` events of a response that ignores `limit`", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(
      RELAY,
      Array.from({ length: 10_000 }, (_, i) => fakeEvent(i + 1, 10_000 + i)),
    );
    network.ignoresLimit.add(RELAY);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 2, maxPages: 1 },
    );

    expect(result.events.map((e) => e.created_at)).toEqual([19_999, 19_998]);
    expect(result.complete).toBe(false);
    expect(result.relays).toEqual([
      { relay: RELAY, status: "capped", until: 19_998 },
    ]);
  });

  it("still pages a relay that ignores `limit` to completion", async () => {
    const network = new PagingNetwork();
    const events = Array.from({ length: 7 }, (_, i) =>
      fakeEvent(i + 1, 1000 + i),
    );
    network.relayEvents.set(RELAY, events);
    network.ignoresLimit.add(RELAY);

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      { pageSize: 2, maxPages: 20 },
    );

    expect(result.complete).toBe(true);
    expect(new Set(result.events.map((e) => e.id))).toEqual(
      new Set(events.map((e) => e.id)),
    );
  });

  it("reports an incomplete backfill when the page cap is hit", async () => {
    const network = new PagingNetwork();
    network.relayEvents.set(
      RELAY,
      Array.from({ length: 10 }, (_, i) => fakeEvent(i + 1, 1000 + i)),
    );

    const result = await fetchPagedBackfill(
      network,
      [RELAY],
      {},
      {
        pageSize: 2,
        maxPages: 2,
      },
    );

    expect(result.complete).toBe(false);
    // Two pages of two, the second re-reading the inclusive `until` boundary.
    expect(result.events).toHaveLength(3);
  });
});

describe("nextBackfillCursor", () => {
  const now = 2_000_000;

  it("ignores events dated beyond the future-skew horizon", () => {
    const next = nextBackfillCursor({
      ingested: [
        fakeEvent(1, now - 10),
        fakeEvent(2, now + BACKFILL_FUTURE_SKEW_SECONDS + 1),
      ],
      held: [],
      previous: undefined,
      nowSeconds: now,
    });
    expect(next).toBe(now - 10);
  });

  it("holds the cursor at a held event even if it was not in this batch", () => {
    // e.g. pooled from the live subscription before this reconnect.
    const next = nextBackfillCursor({
      ingested: [fakeEvent(1, now - 10)],
      held: [fakeEvent(2, now - 300)],
      previous: now - 200,
      nowSeconds: now,
    });
    expect(next).toBe(now - 300);
  });

  it("holds the cursor at the oldest event still held in memory", () => {
    const held = fakeEvent(2, now - 50);
    const next = nextBackfillCursor({
      ingested: [fakeEvent(1, now - 100), held, fakeEvent(3, now - 10)],
      held: [held],
      previous: now - 200,
      nowSeconds: now,
    });
    expect(next).toBe(now - 50);
  });

  it("does not let a held event dated far in the past pin the cursor", () => {
    const now = 1_800_000_000;
    const ancient = fakeEvent(2, 0);
    for (const previous of [undefined, now - 30 * 86_400])
      expect(
        nextBackfillCursor({
          ingested: [fakeEvent(1, now - 10)],
          held: [ancient],
          previous,
          nowSeconds: now,
        }),
      ).toBe(now - 10 - BACKFILL_MAX_HOLD_BACK_SECONDS);
  });

  it("lets retained input hold the cursor back past the held-event floor", () => {
    const now = 1_800_000_000;
    const retained = fakeEvent(2, now - 30 * 86_400);
    for (const previous of [undefined, now - 40 * 86_400])
      expect(
        nextBackfillCursor({
          ingested: [fakeEvent(1, now - 10)],
          held: [],
          retained: [retained],
          previous,
          nowSeconds: now,
        }),
      ).toBe(retained.created_at);
  });

  it("holds the cursor at the older of the floored held and retained events", () => {
    const now = 1_800_000_000;
    const ancient = fakeEvent(2, 0);
    const input = (retained: NostrEvent[]) => ({
      ingested: [fakeEvent(1, now - 10)],
      held: [ancient],
      retained,
      previous: undefined,
      nowSeconds: now,
    });
    const floor = now - 10 - BACKFILL_MAX_HOLD_BACK_SECONDS;
    // A recent retained event does not undo the floor on the held one...
    expect(nextBackfillCursor(input([fakeEvent(3, now - 5)]))).toBe(floor);
    // ...and an older one is not raised by it.
    expect(nextBackfillCursor(input([fakeEvent(3, floor - 100)]))).toBe(
      floor - 100,
    );
  });

  it("never moves backwards without a held event", () => {
    const next = nextBackfillCursor({
      ingested: [fakeEvent(1, now - 100)],
      held: [],
      previous: now - 10,
      nowSeconds: now,
    });
    expect(next).toBe(now - 10);
  });

  it("keys a relay's records by its normalised URL", () => {
    expect(backfillCursorKey("aa", "wss://relay.test")).toBe(
      backfillCursorKey("aa", "wss://relay.test/"),
    );
    expect(backfillProgressKey("aa", "wss://Relay.test")).toBe(
      backfillProgressKey("aa", "wss://relay.test/"),
    );
    expect(backfillCursorKey("aa", RELAY)).not.toBe(
      backfillCursorKey("aa", RELAY_B),
    );
  });

  it("round-trips the stored encoding and rejects malformed bytes", () => {
    expect(decodeBackfillCursor(encodeBackfillCursor(now))).toBe(now);
    expect(decodeBackfillCursor(new Uint8Array([9, 0, 0, 0, 1]))).toBe(
      undefined,
    );
    expect(decodeBackfillCursor(null)).toBe(undefined);
  });
});

describe("GroupsManager.connect bounded, paged backfill (#106)", () => {
  it("pages through history larger than one page and ingests all of it", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, groupEvents } = await groupWithHistory(
      network,
      7,
      nowSeconds() - 60,
    );
    network.requests.length = 0;
    const ingestSpy = vi.spyOn(group, "ingest");

    const sub = await manager.connect(group.id, { backfillPageSize: 3 });
    sub.unsubscribe();

    const backfillRequests = network.requests;
    expect(backfillRequests.length).toBeGreaterThan(2);
    expect(backfillRequests.every((r) => r.filter.limit === 3)).toBe(true);
    // First connect has no cursor: the full history is paged, no `since`.
    expect(backfillRequests.every((r) => r.filter.since === undefined)).toBe(
      true,
    );
    const backfilled = ingestSpy.mock.calls[0]![0] as NostrEvent[];
    expect(new Set(backfilled.map((e) => e.id))).toEqual(
      new Set(groupEvents.map((e) => e.id)),
    );
  });

  it("bounds the next connect's `since` by the persisted cursor", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      4,
      newest,
    );

    (await manager.connect(group.id, { backfillPageSize: 3 })).unsubscribe();
    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(newest);

    network.requests.length = 0;
    (
      await manager.connect(group.id, {
        backfillPageSize: 3,
        backfillSlackSeconds: 120,
      })
    ).unsubscribe();

    expect(network.requests.length).toBeGreaterThan(0);
    expect(network.requests.every((r) => r.filter.since === newest - 120)).toBe(
      true,
    );
  });

  it("does not advance the cursor from a future-dated event", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 3, newest);
    // Same payload, distinct id, dated an hour ahead.
    network.events.push({
      ...groupEvents[0]!,
      id: "f".repeat(64),
      created_at: nowSeconds() + 3600,
    });

    (await manager.connect(group.id)).unsubscribe();

    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(newest);
  });

  it("does not advance the cursor from a forged copy of an admitted event", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const forgeries = new WeakSet<NostrEvent>();
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 3, newest, (e) => !forgeries.has(e));
    // An open connection keeps every admitted id in the shared dedup cache.
    const open = await manager.connect(group.id);
    // A same-id copy with a newer timestamp that fails verification.
    const forged = { ...groupEvents[2]!, created_at: newest + 120 };
    forgeries.add(forged);
    network.events.push(forged);

    (await manager.connect(group.id)).unsubscribe();
    open.unsubscribe();

    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(newest);
  });

  it("admits the genuine event when its relay returns a forged copy first", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const forgeries = new WeakSet<NostrEvent>();
    const { manager, group, groupEvents } = await groupWithHistory(
      network,
      3,
      newest,
      (e) => !forgeries.has(e),
    );
    // A same-id copy that fails verification, dated so the relay returns it
    // before the genuine event.
    const forged = { ...groupEvents[0]!, created_at: newest - 1 };
    forgeries.add(forged);
    network.relayEvents.set(RELAY, [...groupEvents, forged]);
    const ingestSpy = vi.spyOn(group, "ingest");

    (await manager.connect(group.id)).unsubscribe();

    const backfilled = ingestSpy.mock.calls[0]![0] as NostrEvent[];
    expect(backfilled).toContain(groupEvents[0]);
    expect(backfilled).not.toContain(forged);
  });

  it("stops paging when the connection is aborted mid-backfill", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      6,
      nowSeconds() - 60,
    );
    network.requests.length = 0;
    const controller = new AbortController();
    const request = network.request.bind(network);
    network.request = async (relays, filters) => {
      controller.abort();
      return request(relays, filters);
    };

    const sub = await manager.connect(group.id, {
      backfillPageSize: 2,
      signal: controller.signal,
    });
    sub.unsubscribe();

    expect(network.requests).toHaveLength(1);
    expect(
      await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
    ).toBeNull();
  });

  it("keeps the cursor when the page cap leaves history unfetched", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      6,
      nowSeconds() - 60,
    );

    (
      await manager.connect(group.id, {
        backfillPageSize: 2,
        backfillMaxPages: 1,
      })
    ).unsubscribe();

    expect(
      await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
    ).toBeNull();
  });

  it("holds the cursor at an undecryptable event pooled without a result", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 3, newest);
    // A ciphertext this group cannot decrypt (another group's message,
    // re-tagged into this group). Ingest pools it silently, yielding nothing.
    const other = makeManager(network);
    const otherGroup = await other.create("Other", { relays: [RELAY] });
    await other.send(otherGroup.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("foreign"),
    });
    const foreign = network.events.at(-1)!;
    foreign.tags = groupEvents[0]!.tags.map((tag) => [...tag]);
    foreign.created_at = newest - 30;

    (await manager.connect(group.id)).unsubscribe();

    expect(group.pendingEvents().map((e) => e.id)).toContain(foreign.id);
    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(newest - 30);
  });

  it("ends recorded progress strictly below an event still held", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 6, newest);
    // An undecryptable event (pooled in memory) inside the capped range.
    const other = makeManager(network);
    const otherGroup = await other.create("Other", { relays: [RELAY] });
    await other.send(otherGroup.id, {
      kind: "applicationMessage",
      payload: new TextEncoder().encode("foreign"),
    });
    const foreign = network.events.at(-1)!;
    foreign.tags = groupEvents[0]!.tags.map((tag) => [...tag]);
    // Its own second (no other event shares it), newest in the history.
    foreign.created_at = newest + 1;

    (
      await manager.connect(group.id, {
        backfillPageSize: 2,
        backfillMaxPages: 3,
        backfillSlackSeconds: 0,
      })
    ).unsubscribe();

    expect(group.pendingEvents().map((e) => e.id)).toContain(foreign.id);
    const progress = decodeBackfillProgress(
      await ingestStateStore.getItem(backfillProgressKey(group.idStr, RELAY)),
    );
    // The held event's whole second must be re-read on the next connect, so
    // the range may not include it, even with zero slack.
    expect(progress).toBeDefined();
    expect(progress!.to).toBe(newest);
  });

  it("completes a page-capped backfill over successive connects", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 6, newest);
    const ingestSpy = vi.spyOn(group, "ingest");
    const options = {
      backfillPageSize: 2,
      backfillMaxPages: 3,
      backfillSlackSeconds: 0,
    };
    const cursor = async () =>
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      );

    let connects = 0;
    while ((await cursor()) === undefined && connects < 6) {
      (await manager.connect(group.id, options)).unsubscribe();
      connects++;
    }

    expect(await cursor()).toBe(newest);
    expect(connects).toBeGreaterThan(1);
    const backfilled = new Set(
      ingestSpy.mock.calls.flatMap((call) =>
        (call[0] as NostrEvent[]).map((e) => e.id),
      ),
    );
    expect(backfilled).toEqual(new Set(groupEvents.map((e) => e.id)));
    // A completed relay drops its resumable progress.
    expect(
      await ingestStateStore.getItem(backfillProgressKey(group.idStr, RELAY)),
    ).toBeNull();
  });

  it("re-fetches input retained during a commit publication after a restart", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore, stores } =
      await groupWithHistory(network, 3, newest);
    const older = await foreignEvent(network, groupEvents[0]!, newest - 30);
    network.events.push(older);
    // Hold this member's own commit publication in flight: the engine then
    // retains inbound input, in memory only, until the publication settles.
    let releasePublish!: () => void;
    const publishing = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publish = network.publish.bind(network);
    network.publish = async (relays, event) => {
      await publishing;
      return publish(relays, event);
    };
    const update = group.selfUpdate();
    await vi.waitFor(() => expect(group.lifecycle).toBe("PendingPublish"));

    (await manager.connect(group.id)).unsubscribe();

    expect(group.session.retainedEvents().map((e) => e.id)).toContain(older.id);
    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(newest - 30);

    // Restart before the publication settles: a new manager over the same
    // stores re-fetches the retained event.
    const restarted = makeManager(network, stores);
    const reloaded = await restarted.get(group.id);
    const ingestSpy = vi.spyOn(reloaded, "ingest");
    // Zero slack: only the cursor itself keeps the retained event in range.
    (
      await restarted.connect(group.id, { backfillSlackSeconds: 0 })
    ).unsubscribe();
    const backfilled = ingestSpy.mock.calls[0]![0] as NostrEvent[];
    expect(backfilled.map((e) => e.id)).toContain(older.id);

    releasePublish();
    await update;
  });

  it("does not floor the hold-back of input retained during a first connect with a long history", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore, stores } =
      await groupWithHistory(network, 3, newest);
    // History from more than BACKFILL_MAX_HOLD_BACK_SECONDS before the newest.
    const old = newest - 30 * 86_400;
    const older = await foreignEvent(network, groupEvents[0]!, old);
    network.events.push(older);
    let releasePublish!: () => void;
    const publishing = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publish = network.publish.bind(network);
    network.publish = async (relays, event) => {
      await publishing;
      return publish(relays, event);
    };
    const update = group.selfUpdate();
    await vi.waitFor(() => expect(group.lifecycle).toBe("PendingPublish"));

    (await manager.connect(group.id)).unsubscribe();

    expect(group.session.retainedEvents().map((e) => e.id)).toContain(older.id);
    expect(
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      ),
    ).toBe(old);

    // Restart before the publication settles: the old event is re-fetched.
    const restarted = makeManager(network, stores);
    const reloaded = await restarted.get(group.id);
    const ingestSpy = vi.spyOn(reloaded, "ingest");
    (
      await restarted.connect(group.id, { backfillSlackSeconds: 0 })
    ).unsubscribe();
    const backfilled = ingestSpy.mock.calls[0]![0] as NostrEvent[];
    expect(backfilled.map((e) => e.id)).toContain(older.id);

    releasePublish();
    await update;
  });

  it("persists the cursor before a live batch admitted meanwhile is ingested", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 3, newest);
    // An undecryptable event to deliver live later, kept off the relay.
    const foreign = await foreignEvent(network, groupEvents[0]!, newest - 30);

    // A live connection whose capped backfill records progress, no cursor.
    const live = await manager.connect(group.id, {
      backfillPageSize: 1,
      backfillMaxPages: 1,
    });
    expect(
      await ingestStateStore.getItem(backfillProgressKey(group.idStr, RELAY)),
    ).not.toBeNull();

    // The reconnect completes, so it first drops that progress record (held
    // here), then writes the cursor.
    let reachedRemove!: () => void;
    const removing = new Promise<void>((resolve) => {
      reachedRemove = resolve;
    });
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeItem = ingestStateStore.removeItem.bind(ingestStateStore);
    ingestStateStore.removeItem = async (key) => {
      reachedRemove();
      await removeGate;
      return removeItem(key);
    };
    const ingestSpy = vi.spyOn(group, "ingest");
    const liveIngested = () =>
      ingestSpy.mock.calls.some((call) =>
        (call[0] as NostrEvent[]).some((e) => e.id === foreign.id),
      );
    let liveIngestedAtCursorWrite: boolean | undefined;
    const setItem = ingestStateStore.setItem.bind(ingestStateStore);
    ingestStateStore.setItem = async (key, value) => {
      if (key === backfillCursorKey(group.idStr, RELAY))
        liveIngestedAtCursorWrite = liveIngested();
      return setItem(key, value);
    };

    const reconnect = manager.connect(group.id);
    await removing;
    // A live batch arrives while the reconnect is persisting.
    await network.publish([RELAY], foreign);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(liveIngested()).toBe(false);
    releaseRemove();
    (await reconnect).unsubscribe();
    await vi.waitFor(() => expect(liveIngested()).toBe(true));
    live.unsubscribe();

    expect(liveIngestedAtCursorWrite).toBe(false);
  });

  it("advances a healthy relay's cursor while another relay is unreachable", async () => {
    const network = new PagingNetwork([RELAY, RELAY_B]);
    const newest = nowSeconds() - 60;
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      3,
      newest,
      undefined,
      [RELAY, RELAY_B],
    );
    const cursor = async (relay: string) =>
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, relay)),
      );
    network.unreachable.add(RELAY_B);

    (await manager.connect(group.id)).unsubscribe();

    expect(await cursor(RELAY)).toBe(newest);
    expect(await cursor(RELAY_B)).toBeUndefined();

    // The healthy relay is now fetched from its cursor; the other relay is
    // paged in full until one of its backfills completes.
    network.unreachable.clear();
    network.requests.length = 0;
    (
      await manager.connect(group.id, { backfillSlackSeconds: 120 })
    ).unsubscribe();

    const sinceOf = (relay: string) =>
      network.requests
        .filter((r) => r.relays[0] === relay)
        .map((r) => r.filter.since);
    expect(sinceOf(RELAY).every((since) => since === newest - 120)).toBe(true);
    expect(sinceOf(RELAY_B).every((since) => since === undefined)).toBe(true);
    expect(await cursor(RELAY_B)).toBe(newest);
  });

  it("does not advance a relay's cursor when it ignores `until`", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      5,
      nowSeconds() - 60,
    );
    network.ignoresUntil.add(RELAY);

    (await manager.connect(group.id, { backfillPageSize: 2 })).unsubscribe();

    expect(
      await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
    ).toBeNull();
  });

  it("keeps the cursor while an earlier batch for the group failed to ingest", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      3,
      newest,
    );
    const cursor = async () =>
      decodeBackfillCursor(
        await ingestStateStore.getItem(backfillCursorKey(group.idStr, RELAY)),
      );
    vi.spyOn(group, "ingest").mockImplementationOnce(async function* () {
      throw new Error("ingest failed");
    });

    const open = await manager.connect(group.id);
    expect(await cursor()).toBeUndefined();
    // The failed batch's ids are already admitted, so a reconnect sees them
    // as known; the failure stays recorded while the group is connected.
    (await manager.connect(group.id)).unsubscribe();
    expect(await cursor()).toBeUndefined();

    // Once every connection and queued batch for the group is gone, a fresh
    // backfill re-admits and ingests the history.
    open.unsubscribe();
    await vi.waitFor(async () => {
      (await manager.connect(group.id)).unsubscribe();
      expect(await cursor()).toBe(newest);
    });
  });

  it("starts the live subscription at the backfill window", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group } = await groupWithHistory(
      network,
      2,
      nowSeconds() - 60,
    );
    const before = nowSeconds();

    (
      await manager.connect(group.id, { backfillSlackSeconds: 120 })
    ).unsubscribe();

    const since = network.subscriptions.at(-1)!.since!;
    expect(since).toBeGreaterThanOrEqual(before - 120);
    expect(since).toBeLessThanOrEqual(nowSeconds() - 120);
  });

  it("applies backfill options under connectAll and validates them up front", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager } = await groupWithHistory(network, 3, nowSeconds() - 60);
    network.requests.length = 0;

    expect(() => manager.connectAll({ backfillPageSize: 0 })).toThrow(
      "backfillPageSize",
    );
    await expect(
      manager.connect(new Uint8Array(32), { backfillSlackSeconds: -1 }),
    ).rejects.toThrow("backfillSlackSeconds");

    const all = manager.connectAll({ backfillPageSize: 2 });
    await vi.waitFor(() => expect(network.subscriptions).toHaveLength(1));
    all.unsubscribe();
    expect(network.requests.length).toBeGreaterThan(1);
    expect(network.requests.every((r) => r.filter.limit === 2)).toBe(true);
  });

  it("ends recorded progress below input retained during a commit publication", async () => {
    const network = new PagingNetwork([RELAY]);
    const newest = nowSeconds() - 60;
    const { manager, group, groupEvents, ingestStateStore } =
      await groupWithHistory(network, 6, newest);
    const retained = await foreignEvent(network, groupEvents[0]!, newest + 1);
    network.events.push(retained);
    let releasePublish!: () => void;
    const publishing = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const publish = network.publish.bind(network);
    network.publish = async (relays, event) => {
      await publishing;
      return publish(relays, event);
    };
    const update = group.selfUpdate();
    await vi.waitFor(() => expect(group.lifecycle).toBe("PendingPublish"));

    (
      await manager.connect(group.id, {
        backfillPageSize: 2,
        backfillMaxPages: 3,
        backfillSlackSeconds: 0,
      })
    ).unsubscribe();

    expect(group.session.retainedEvents().map((e) => e.id)).toContain(
      retained.id,
    );
    const progress = decodeBackfillProgress(
      await ingestStateStore.getItem(backfillProgressKey(group.idStr, RELAY)),
    );
    expect(progress).toBeDefined();
    expect(progress!.to).toBe(newest);

    releasePublish();
    await update;
  });

  it("leaves no backfill record behind a group destroyed while it settles", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      3,
      nowSeconds() - 60,
    );
    // A capped first connect records progress, which the next one removes.
    (
      await manager.connect(group.id, {
        backfillPageSize: 1,
        backfillMaxPages: 1,
      })
    ).unsubscribe();
    let reachedRemove!: () => void;
    const removing = new Promise<void>((resolve) => {
      reachedRemove = resolve;
    });
    let releaseRemove!: () => void;
    const removeGate = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeItem = ingestStateStore.removeItem.bind(ingestStateStore);
    let gated = false;
    ingestStateStore.removeItem = async (key) => {
      if (!gated) {
        gated = true;
        reachedRemove();
        await removeGate;
      }
      return removeItem(key);
    };

    const reconnect = manager.connect(group.id);
    await removing;
    await manager.destroy(group.id);
    releaseRemove();
    await reconnect.then((sub) => sub.unsubscribe());

    const records = (await ingestStateStore.keys()).filter((key) =>
      key.startsWith(`${group.idStr}/ingest/backfill-`),
    );
    expect(records).toEqual([]);
  });

  it("removes a backfill record written as the group is destroyed", async () => {
    const network = new PagingNetwork([RELAY]);
    const { manager, group, ingestStateStore } = await groupWithHistory(
      network,
      3,
      nowSeconds() - 60,
    );
    let reachedWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      reachedWrite = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const setItem = ingestStateStore.setItem.bind(ingestStateStore);
    let gated = false;
    ingestStateStore.setItem = async (key, value) => {
      // Gate the first backfill record's write; the destroy lands before it.
      if (!gated && key.startsWith(`${group.idStr}/ingest/backfill-`)) {
        gated = true;
        reachedWrite();
        await writeGate;
      }
      return setItem(key, value);
    };
    const removeItem = vi.spyOn(ingestStateStore, "removeItem");

    const connecting = manager.connect(group.id);
    await writing;
    await manager.destroy(group.id);
    releaseWrite();
    await connecting.then((sub) => sub.unsubscribe());

    // The write completed after the destroy had purged the group's state, so
    // the manager removed the record again.
    expect(gated).toBe(true);
    expect(removeItem).toHaveBeenCalledWith(
      backfillCursorKey(group.idStr, RELAY),
    );
    const records = (await ingestStateStore.keys()).filter((key) =>
      key.startsWith(`${group.idStr}/ingest/backfill-`),
    );
    expect(records).toEqual([]);
  });
});
