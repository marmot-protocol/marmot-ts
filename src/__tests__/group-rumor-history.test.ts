import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { describe, expect, it } from "vitest";

import {
  GroupRumorHistory,
  type GroupRumorHistoryBackend,
} from "../client/group/group-rumor-history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal Rumor with only the fields matchFilter cares about. */
function makeRumor(overrides: Partial<Rumor> & { id: string }): Rumor {
  return {
    kind: 1,
    pubkey: "a".repeat(64),
    content: "hello",
    tags: [],
    created_at: 1_000_000,
    ...overrides,
  } as Rumor;
}

let _idCounter = 0;
function nextId(): string {
  return String(_idCounter++).padStart(64, "0");
}

/**
 * In-memory backend for testing — stores rumors in insertion order,
 * returns them newest-first (matching the documented contract).
 */
function makeInMemoryBackend(): GroupRumorHistoryBackend & {
  _store: Rumor[];
} {
  const store: Rumor[] = [];

  return {
    _store: store,

    async queryRumors(filters) {
      const seen = new Set<string>();
      const results: Rumor[] = [];
      const filtersArray = Array.isArray(filters) ? filters : [filters];

      for (const filter of filtersArray) {
        for (const r of store) {
          if (seen.has(r.id)) continue;
          if (filter.kinds && !filter.kinds.includes(r.kind)) continue;
          if (filter.authors && !filter.authors.includes(r.pubkey)) continue;
          if (filter.since !== undefined && r.created_at < filter.since)
            continue;
          if (filter.until !== undefined && r.created_at > filter.until)
            continue;
          seen.add(r.id);
          results.push(r);
        }
      }

      // newest-first
      results.sort((a, b) => b.created_at - a.created_at);
      return results;
    },

    async addRumor(rumor) {
      store.push(rumor);
    },

    async clear() {
      store.length = 0;
    },
  };
}

/** Pull the next value from an async generator with a timeout safety net. */
async function nextValue<T>(
  gen: AsyncGenerator<T>,
  timeoutMs = 500,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("nextValue timed out")), timeoutMs),
  );
  const { value } = await Promise.race([gen.next(), timeoutPromise]);
  return value as T;
}

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

describe("GroupRumorHistory.subscribe", () => {
  it("yields an empty array immediately when the store is empty", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen = history.subscribe();

    const first = await nextValue(gen);
    expect(first).toEqual([]);

    await gen.return(undefined);
  });

  it("yields existing rumors as the initial snapshot", async () => {
    const backend = makeInMemoryBackend();
    const rumor = makeRumor({ id: nextId(), created_at: 1_000_000 });
    await backend.addRumor(rumor);

    const history = new GroupRumorHistory(backend);
    const gen = history.subscribe();

    const first = await nextValue(gen);
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe(rumor.id);

    await gen.return(undefined);
  });

  it("yields a new snapshot when a rumor is saved after subscription", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen = history.subscribe();

    // Consume initial snapshot
    await nextValue(gen);

    // Save a new rumor after subscribing
    const rumor = makeRumor({ id: nextId() });
    void history.saveRumor(rumor);

    const second = await nextValue(gen);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(rumor.id);

    await gen.return(undefined);
  });

  it("re-yields on each subsequent saveRumor call", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen = history.subscribe();

    await nextValue(gen); // initial empty snapshot

    const r1 = makeRumor({ id: nextId() });
    void history.saveRumor(r1);
    const snap1 = await nextValue(gen);
    expect(snap1).toHaveLength(1);

    const r2 = makeRumor({ id: nextId() });
    void history.saveRumor(r2);
    const snap2 = await nextValue(gen);
    expect(snap2).toHaveLength(2);

    await gen.return(undefined);
  });

  it("filters by kind — only wakes up for matching kinds", async () => {
    const backend = makeInMemoryBackend();
    const history = new GroupRumorHistory(backend);
    const gen = history.subscribe({ kinds: [1] });

    await nextValue(gen); // initial empty snapshot

    // Save a kind-9 rumor — should NOT trigger a new yield
    const nonMatching = makeRumor({ id: nextId(), kind: 9 });
    void history.saveRumor(nonMatching);

    // Save a matching kind-1 rumor
    const matching = makeRumor({ id: nextId(), kind: 1 });

    // Race: the first yield after the kind-9 save should come only after
    // matching is saved.  We trigger both in sequence.
    const yieldPromise = nextValue(gen, 1000);
    void history.saveRumor(matching);

    const snap = await yieldPromise;
    // Backend stores both (no kind filter in addRumor), but only the
    // matching rumor triggered the yield.  The snapshot from the filtered
    // query should only include kind-1 rumors.
    expect(snap.every((r) => r.kind === 1)).toBe(true);
    expect(snap.some((r) => r.id === matching.id)).toBe(true);

    await gen.return(undefined);
  });

  it("filters by authors — only wakes up for matching pubkeys", async () => {
    const backend = makeInMemoryBackend();
    const history = new GroupRumorHistory(backend);
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    const gen = history.subscribe({ authors: [alice] });

    await nextValue(gen); // initial snapshot

    // Bob's rumor should not trigger a yield
    const bobRumor = makeRumor({ id: nextId(), pubkey: bob });
    void history.saveRumor(bobRumor);

    // Alice's rumor should trigger a yield
    const aliceRumor = makeRumor({ id: nextId(), pubkey: alice });
    const yieldPromise = nextValue(gen, 1000);
    void history.saveRumor(aliceRumor);

    const snap = await yieldPromise;
    expect(snap.every((r) => r.pubkey === alice)).toBe(true);

    await gen.return(undefined);
  });

  it("does not leak event listeners after the caller breaks", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());

    const listenersBefore = history.listenerCount("rumor");
    const clearedListenersBefore = history.listenerCount("cleared");

    const gen = history.subscribe();
    await nextValue(gen); // consume initial snapshot

    // Explicitly close the generator — this should trigger finally cleanup
    await gen.return(undefined);

    expect(history.listenerCount("rumor")).toBe(listenersBefore);
    expect(history.listenerCount("cleared")).toBe(clearedListenersBefore);
  });

  it("multiple concurrent subscribers each receive independent snapshots", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen1 = history.subscribe();
    const gen2 = history.subscribe();

    // Consume initial snapshots
    const init1 = await nextValue(gen1);
    const init2 = await nextValue(gen2);
    expect(init1).toEqual([]);
    expect(init2).toEqual([]);

    // Save a rumor — both generators should wake up
    const rumor = makeRumor({ id: nextId() });
    void history.saveRumor(rumor);

    const [snap1, snap2] = await Promise.all([
      nextValue(gen1),
      nextValue(gen2),
    ]);

    expect(snap1).toHaveLength(1);
    expect(snap2).toHaveLength(1);

    await gen1.return(undefined);
    await gen2.return(undefined);
  });

  it("subscribe with no filter wakes up for every rumor kind", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen = history.subscribe();

    await nextValue(gen); // initial

    const r = makeRumor({ id: nextId(), kind: 42 });
    void history.saveRumor(r);

    const snap = await nextValue(gen);
    expect(snap).toHaveLength(1);

    await gen.return(undefined);
  });

  it("yields an empty snapshot when the history is purged", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const rumor = makeRumor({ id: nextId() });

    await history.saveRumor(rumor);

    const gen = history.subscribe();
    const first = await nextValue(gen);
    expect(first).toHaveLength(1);

    const yieldPromise = nextValue(gen, 1000);
    await history.purgeMessages();

    const second = await yieldPromise;
    expect(second).toEqual([]);

    await gen.return(undefined);
  });

  it("purge wakes up filtered subscribers even when no rumor matches", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const rumor = makeRumor({ id: nextId(), kind: 9 });

    await history.saveRumor(rumor);

    const gen = history.subscribe({ kinds: [1] });
    const first = await nextValue(gen);
    expect(first).toEqual([]);

    const yieldPromise = nextValue(gen, 1000);
    await history.purgeMessages();

    const second = await yieldPromise;
    expect(second).toEqual([]);

    await gen.return(undefined);
  });

  // -------------------------------------------------------------------------
  // Array-of-filters overload
  // -------------------------------------------------------------------------

  it("accepts an array of filters and wakes up when any filter matches", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    const gen = history.subscribe([{ kinds: [1] }, { kinds: [6] }]);

    await nextValue(gen); // initial empty snapshot

    // kind-1 rumor — matches first filter
    const r1 = makeRumor({ id: nextId(), kind: 1 });
    void history.saveRumor(r1);
    const snap1 = await nextValue(gen);
    expect(snap1.some((r) => r.id === r1.id)).toBe(true);

    // kind-6 rumor — matches second filter
    const r6 = makeRumor({ id: nextId(), kind: 6 });
    void history.saveRumor(r6);
    const snap2 = await nextValue(gen);
    expect(snap2.some((r) => r.id === r6.id)).toBe(true);

    await gen.return(undefined);
  });

  it("does not wake up when no filter in the array matches", async () => {
    const history = new GroupRumorHistory(makeInMemoryBackend());
    // Only interested in kinds 1 and 6
    const gen = history.subscribe([{ kinds: [1] }, { kinds: [6] }]);

    await nextValue(gen); // initial empty snapshot

    // kind-9 — matches neither filter; should NOT trigger a yield
    const nonMatch = makeRumor({ id: nextId(), kind: 9 });
    void history.saveRumor(nonMatch);

    // kind-1 — matches; this should be the next yield
    const match = makeRumor({ id: nextId(), kind: 1 });
    const yieldPromise = nextValue(gen, 1000);
    void history.saveRumor(match);

    const snap = await yieldPromise;
    // The snapshot should contain the kind-1 rumor
    expect(snap.some((r) => r.id === match.id)).toBe(true);

    await gen.return(undefined);
  });

  it("an array with a single filter behaves identically to passing that filter directly", async () => {
    const backend = makeInMemoryBackend();
    const historyA = new GroupRumorHistory(backend);
    const historyB = new GroupRumorHistory(backend);

    const genSingle = historyA.subscribe({ kinds: [1] });
    const genArray = historyB.subscribe([{ kinds: [1] }]);

    const initSingle = await nextValue(genSingle);
    const initArray = await nextValue(genArray);
    expect(initSingle).toEqual(initArray);

    const r = makeRumor({ id: nextId(), kind: 1 });
    void historyA.saveRumor(r);
    void historyB.saveRumor(r);

    const [snapSingle, snapArray] = await Promise.all([
      nextValue(genSingle),
      nextValue(genArray),
    ]);
    expect(snapSingle).toHaveLength(snapArray.length);

    await genSingle.return(undefined);
    await genArray.return(undefined);
  });
});
