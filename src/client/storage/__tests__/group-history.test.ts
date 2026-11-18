import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { RumorStore } from "applesauce-core/event-store";
import { getEventHash } from "applesauce-core/helpers/event";
import { describe, expect, it, vi } from "vitest";
import { serializeApplicationRumor } from "../../../core/application-rumor.js";
import { GroupHistory, type MarmotRumorDatabases } from "../group-history.js";

const PUBKEY = "a".repeat(64);
let counter = 0;

function rumor(created_at: number, kind = 9, content?: string): Rumor {
  const draft = {
    kind,
    pubkey: PUBKEY,
    content: content ?? `message ${counter++}`,
    tags: [],
    created_at,
  };
  return { ...draft, id: getEventHash(draft) } as Rumor;
}

async function collect<T>(generator: AsyncGenerator<T[]>): Promise<T[][]> {
  const pages: T[][] = [];
  for await (const page of generator) pages.push(page);
  return pages;
}

describe("GroupHistory", () => {
  it("stores decoded application messages and queries newest first", async () => {
    const history = new GroupHistory();
    const older = rumor(100);
    const newer = rumor(200);
    await history.saveMessage(serializeApplicationRumor(older));
    await history.saveMessage(serializeApplicationRumor(newer));
    expect((await history.queryRumors({})).map((r) => r.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("ignores payloads that are not rumors", async () => {
    const history = new GroupHistory();
    await history.saveMessage(new Uint8Array([1, 2, 3]));
    expect(await history.queryRumors({})).toEqual([]);
  });

  it("supports full filters including ids and tags", async () => {
    const history = new GroupHistory();
    const tagged = { ...rumor(100), tags: [["e", "x".repeat(64)]] };
    const fixed = { ...tagged, id: getEventHash(tagged) } as Rumor;
    const plain = rumor(101);
    await history.store.add(fixed);
    await history.store.add(plain);
    expect(
      (await history.queryRumors({ "#e": ["x".repeat(64)] })).map((r) => r.id),
    ).toEqual([fixed.id]);
    expect(
      (await history.queryRumors({ ids: [plain.id] })).map((r) => r.id),
    ).toEqual([plain.id]);
  });

  it("removes and purges, emitting events", async () => {
    const history = new GroupHistory();
    const removed = vi.fn();
    const cleared = vi.fn();
    history.on("removed", removed);
    history.on("cleared", cleared);
    const a = rumor(1);
    const b = rumor(2);
    await history.store.add(a);
    await history.store.add(b);
    await history.removeMessage(a.id);
    expect(removed).toHaveBeenCalledWith(a.id);
    expect((await history.queryRumors({})).map((r) => r.id)).toEqual([b.id]);
    await history.purgeMessages();
    expect(cleared).toHaveBeenCalled();
    expect(await history.queryRumors({})).toEqual([]);
  });

  it("rejects malformed rumor ids on removal", async () => {
    await expect(new GroupHistory().removeMessage("nope")).rejects.toThrow();
  });

  it("subscribe yields a fresh snapshot after inserts and removals", async () => {
    const history = new GroupHistory();
    const controller = new AbortController();
    const iterator = history.subscribe(
      { kinds: [9] },
      {
        signal: controller.signal,
      },
    );
    expect((await iterator.next()).value).toEqual([]);
    const a = rumor(10);
    await history.store.add(a);
    expect(((await iterator.next()).value as Rumor[]).map((r) => r.id)).toEqual(
      [a.id],
    );
    await history.removeMessage(a.id);
    expect((await iterator.next()).value).toEqual([]);
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
  });

  it("pages backwards without skipping rumors that share a second", async () => {
    const history = new GroupHistory();
    const rumors = [rumor(30), rumor(20), rumor(20), rumor(20), rumor(10)];
    for (const r of rumors) await history.store.add(r);
    const pages = await collect(history.createPaginatedLoader({ limit: 2 }));
    const ids = pages.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(rumors.map((r) => r.id)));
  });

  it("uses the app database and drops it on purge", async () => {
    const backing = new RumorStore();
    const drop = vi.fn(async () => {});
    const databases = Object.assign(
      vi.fn(() => backing.database as never),
      { drop },
    ) as unknown as MarmotRumorDatabases;
    const history = GroupHistory.forGroup("ab", databases);
    expect(databases).toHaveBeenCalledWith("ab");
    const a = rumor(5);
    await history.store.add(a);
    expect(backing.database.hasEvent(a.id)).toBe(true);
    await history.purgeMessages();
    expect(drop).toHaveBeenCalledWith("ab");
  });

  it("keeps history in memory when the factory returns undefined", () => {
    const history = GroupHistory.forGroup("ab", () => undefined);
    expect(history.store).toBeInstanceOf(RumorStore);
  });
});
