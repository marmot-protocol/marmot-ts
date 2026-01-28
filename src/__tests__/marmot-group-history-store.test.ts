import { describe, expect, it } from "vitest";

import type { Rumor } from "applesauce-common/helpers";

import {
  MarmotGroupHistoryStore,
  type MarmotGroupHistoryStoreBackend,
} from "../store/marmot-group-history-store.js";
import type { OuterCursor } from "../utils/cursor.js";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

class MemoryHistoryBackend implements MarmotGroupHistoryStoreBackend {
  private processed = new Map<string, OuterCursor>();
  private rumors = new Map<
    string,
    Map<string, { rumor: Rumor; outer: OuterCursor }>
  >();

  private key(groupId: Uint8Array) {
    return Array.from(groupId).join(",");
  }

  async markOuterEventProcessed(groupId: Uint8Array, outer: OuterCursor) {
    // idempotent: store max by composite ordering
    const k = this.key(groupId);
    const prev = this.processed.get(k);
    if (!prev) {
      this.processed.set(k, outer);
      return;
    }
    if (
      prev.created_at < outer.created_at ||
      (prev.created_at === outer.created_at && prev.id < outer.id)
    ) {
      this.processed.set(k, outer);
    }
  }

  async getResumeCursor(groupId: Uint8Array) {
    return this.processed.get(this.key(groupId)) ?? null;
  }

  async addRumor(
    groupId: Uint8Array,
    entry: { rumor: Rumor; outer: OuterCursor },
  ) {
    const gk = this.key(groupId);
    let map = this.rumors.get(gk);
    if (!map) {
      map = new Map();
      this.rumors.set(gk, map);
    }
    // idempotent: key by outer cursor
    const ok = `${entry.outer.created_at}:${entry.outer.id}`;
    if (!map.has(ok)) map.set(ok, entry);
  }

  async queryRumors(
    groupId: Uint8Array,
    filter: { until?: OuterCursor; limit?: number },
  ) {
    const gk = this.key(groupId);
    const list = Array.from(this.rumors.get(gk)?.values() ?? [])
      .map((x) => x)
      .sort((a, b) => {
        // newest first
        if (a.outer.created_at !== b.outer.created_at)
          return b.outer.created_at - a.outer.created_at;
        return b.outer.id.localeCompare(a.outer.id);
      });

    const filtered = filter.until
      ? list.filter((x) => {
          if (x.outer.created_at !== filter.until!.created_at)
            return x.outer.created_at < filter.until!.created_at;
          return x.outer.id < filter.until!.id;
        })
      : list;

    return filtered
      .slice(0, filter.limit ?? filtered.length)
      .map((x) => x.rumor);
  }
}

describe("MarmotGroupHistoryStore backend contract", () => {
  it("getResumeCursor returns greatest processed outer cursor", async () => {
    const backend = new MemoryHistoryBackend();
    const groupId = bytes("g");
    const store = new MarmotGroupHistoryStore(groupId, backend);

    await store.markOuterEventProcessed({ created_at: 10, id: "b" });
    await store.markOuterEventProcessed({ created_at: 10, id: "a" });
    await store.markOuterEventProcessed({ created_at: 11, id: "a" });

    expect(await store.getResumeCursor()).toEqual({ created_at: 11, id: "a" });
  });

  it("addRumor is idempotent under replay of the same outer cursor", async () => {
    const backend = new MemoryHistoryBackend();
    const groupId = bytes("g");
    const store = new MarmotGroupHistoryStore(groupId, backend);

    const rumor: Rumor = {
      id: "r".repeat(64),
      kind: 1,
      content: "hi",
      tags: [],
      created_at: 100,
      pubkey: "p".repeat(64),
    };
    const outer: OuterCursor = { created_at: 123, id: "e".repeat(64) };

    await store.addRumor({ rumor, outer });
    await store.addRumor({ rumor, outer });

    const res = await store.queryRumors({ limit: 10 });
    expect(res.length).toBe(1);
    expect(res[0]).toEqual(rumor);
  });

  it("subscribe emits only after durable persistence (backend-first)", async () => {
    const calls: string[] = [];
    class SubBackend extends MemoryHistoryBackend {
      override async addRumor(
        groupId: Uint8Array,
        entry: { rumor: Rumor; outer: OuterCursor },
      ) {
        calls.push("backend:addRumor");
        await super.addRumor(groupId, entry);
      }
    }

    const backend = new SubBackend();
    const groupId = bytes("g");
    const store = new MarmotGroupHistoryStore(groupId, backend);

    let seen: Rumor | null = null;
    const sub = store.subscribe?.((r) => {
      calls.push("subscriber");
      seen = r;
    });

    const rumor: Rumor = {
      id: "r".repeat(64),
      kind: 1,
      content: "hi",
      tags: [],
      created_at: 100,
      pubkey: "p".repeat(64),
    };
    const outer: OuterCursor = { created_at: 123, id: "e".repeat(64) };

    await store.addRumor({ rumor, outer });

    expect(seen).toEqual(rumor);
    // MUST be backend first, then emit
    expect(calls).toEqual(["backend:addRumor", "subscriber"]);

    sub?.unsubscribe();
  });
});
