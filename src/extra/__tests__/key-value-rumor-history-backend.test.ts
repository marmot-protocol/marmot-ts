import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { describe, expect, it } from "vitest";

import { GroupRumorHistory } from "../../client/group/group-rumor-history.js";
import { InMemoryKeyValueStore } from "../in-memory-key-value-store.js";
import { KeyValueRumorHistoryBackend } from "../key-value-rumor-history-backend.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId(): string {
  return String(_idCounter++).padStart(64, "0");
}

/** Builds a minimal Rumor with only the fields the backend filters care about. */
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

function makeBackend() {
  const store = new InMemoryKeyValueStore<Rumor>();
  return new KeyValueRumorHistoryBackend(store);
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
// queryRumors()
// ---------------------------------------------------------------------------

describe("KeyValueRumorHistoryBackend.queryRumors", () => {
  it("returns rumors newest-first", async () => {
    const backend = makeBackend();
    const older = makeRumor({ id: nextId(), created_at: 1_000 });
    const newer = makeRumor({ id: nextId(), created_at: 2_000 });
    await backend.addRumor(older);
    await backend.addRumor(newer);

    const result = await backend.queryRumors({});
    expect(result.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("filters by kind", async () => {
    const backend = makeBackend();
    const chat = makeRumor({ id: nextId(), kind: 9 });
    const other = makeRumor({ id: nextId(), kind: 1 });
    await backend.addRumor(chat);
    await backend.addRumor(other);

    const result = await backend.queryRumors({ kinds: [9] });
    expect(result.map((r) => r.id)).toEqual([chat.id]);
  });

  it("filters by author", async () => {
    const backend = makeBackend();
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    const fromAlice = makeRumor({ id: nextId(), pubkey: alice });
    const fromBob = makeRumor({ id: nextId(), pubkey: bob });
    await backend.addRumor(fromAlice);
    await backend.addRumor(fromBob);

    const result = await backend.queryRumors({ authors: [alice] });
    expect(result.map((r) => r.id)).toEqual([fromAlice.id]);
  });

  it("applies since/until as inclusive bounds", async () => {
    const backend = makeBackend();
    const a = makeRumor({ id: nextId(), created_at: 100 });
    const b = makeRumor({ id: nextId(), created_at: 200 });
    const c = makeRumor({ id: nextId(), created_at: 300 });
    await backend.addRumor(a);
    await backend.addRumor(b);
    await backend.addRumor(c);

    const result = await backend.queryRumors({ since: 200, until: 300 });
    expect(result.map((r) => r.id).sort()).toEqual([b.id, c.id].sort());
  });

  it("honors limit, keeping the newest", async () => {
    const backend = makeBackend();
    const oldest = makeRumor({ id: nextId(), created_at: 1 });
    const middle = makeRumor({ id: nextId(), created_at: 2 });
    const newest = makeRumor({ id: nextId(), created_at: 3 });
    await backend.addRumor(oldest);
    await backend.addRumor(middle);
    await backend.addRumor(newest);

    const result = await backend.queryRumors({ limit: 2 });
    expect(result.map((r) => r.id)).toEqual([newest.id, middle.id]);
  });

  it("dedupes a rumor matched by multiple filters in an array", async () => {
    const backend = makeBackend();
    const rumor = makeRumor({ id: nextId(), kind: 1, pubkey: "c".repeat(64) });
    await backend.addRumor(rumor);

    const result = await backend.queryRumors([
      { kinds: [1] },
      { authors: ["c".repeat(64)] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(rumor.id);
  });

  it("is idempotent on duplicate ids (re-ingest overwrites in place)", async () => {
    const backend = makeBackend();
    const id = nextId();
    await backend.addRumor(makeRumor({ id, content: "first" }));
    await backend.addRumor(makeRumor({ id, content: "second" }));

    const result = await backend.queryRumors({});
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("second");
  });

  it("clear() empties the store", async () => {
    const backend = makeBackend();
    await backend.addRumor(makeRumor({ id: nextId() }));
    await backend.clear();

    expect(await backend.queryRumors({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration with GroupRumorHistory
// ---------------------------------------------------------------------------

describe("GroupRumorHistory over KeyValueRumorHistoryBackend", () => {
  it("subscribe() yields the persisted snapshot then live additions", async () => {
    const backend = makeBackend();
    const persisted = makeRumor({ id: nextId(), created_at: 1_000 });
    await backend.addRumor(persisted);

    const history = new GroupRumorHistory(backend);
    const gen = history.subscribe();

    const initial = await nextValue(gen);
    expect(initial.map((r) => r.id)).toEqual([persisted.id]);

    const live = makeRumor({ id: nextId(), created_at: 2_000 });
    void history.saveRumor(live);

    const next = await nextValue(gen);
    expect(next.map((r) => r.id)).toEqual([live.id, persisted.id]);

    await gen.return(undefined);
  });

  it("createPaginatedLoader() walks backwards in full + partial pages", async () => {
    const backend = makeBackend();
    // 120 rumors at increasing timestamps
    for (let i = 0; i < 120; i++) {
      await backend.addRumor(makeRumor({ id: nextId(), created_at: 1_000 + i }));
    }

    const history = new GroupRumorHistory(backend);
    const loader = history.createPaginatedLoader({ limit: 50 });

    const page1 = await nextValue(loader as AsyncGenerator<Rumor[]>);
    const page2 = await nextValue(loader as AsyncGenerator<Rumor[]>);
    const page3 = await nextValue(loader as AsyncGenerator<Rumor[]>);

    expect(page1).toHaveLength(50);
    expect(page2).toHaveLength(50);
    expect(page3).toHaveLength(20);

    // Pages are newest-first and strictly older across page boundaries.
    expect(page1[0].created_at).toBe(1_119);
    expect(page1[49].created_at).toBeGreaterThan(page2[0].created_at);
    expect(page2[49].created_at).toBeGreaterThan(page3[0].created_at);
    expect(page3[19].created_at).toBe(1_000);
  });
});
