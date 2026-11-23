import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { AsyncRumorStore } from "applesauce-core/event-store";
import { getEventHash } from "applesauce-core/helpers/event";
import { describe, expect, it } from "vitest";
import { memoryDatabase } from "../memory.js";
import {
  filterToQuery,
  GroupMessageDatabase,
  messageRow,
  rumorOfRow,
} from "../message-database.js";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
let counter = 0;

function rumor(
  created_at: number,
  extra: Partial<Pick<Rumor, "kind" | "pubkey" | "tags">> = {},
): Rumor {
  const draft = {
    kind: 9,
    pubkey: ALICE,
    content: `message ${counter++}`,
    tags: [] as string[][],
    created_at,
    ...extra,
  };
  return { ...draft, id: getEventHash(draft) } as Rumor;
}

async function setup(...rumors: Rumor[]) {
  const db = await memoryDatabase().groups.open("aa");
  await db.transaction(async (tx) => {
    for (const r of rumors) await tx.messages.put(messageRow(r));
  });
  return { db, messages: new GroupMessageDatabase(db) };
}

describe("messageRow", () => {
  it("indexes single-letter tags and round-trips the rumor", () => {
    const r = rumor(5, {
      tags: [["e", "x"], ["p", "y"], ["e", "x"], ["subject", "hi"], ["t"]],
    });
    const row = messageRow(r);
    expect(row).toMatchObject({
      id: r.id,
      kind: 9,
      pubkey: ALICE,
      createdAt: 5,
    });
    expect(row.tags).toEqual(["e:x", "p:y"]);
    expect(rumorOfRow(row)).toEqual(r);
  });
});

describe("filterToQuery", () => {
  it("maps indexable clauses and flags the rest for post-filtering", () => {
    expect(
      filterToQuery({ kinds: [9], authors: [ALICE], "#e": ["x"], limit: 3 }),
    ).toEqual({
      query: { kinds: [9], authors: [ALICE], tags: [["e:x"]], limit: 3 },
      exact: true,
    });
    const search = filterToQuery({ search: "hi", limit: 3 });
    expect(search.exact).toBe(false);
    expect(search.query.limit).toBeUndefined();
  });
});

describe("GroupMessageDatabase", () => {
  it("answers timelines through the index, newest first", async () => {
    const a = rumor(1);
    const b = rumor(3, { pubkey: BOB, tags: [["e", "x"]] });
    const c = rumor(2, { kind: 7, tags: [["e", "x"]] });
    const { messages } = await setup(a, b, c);
    expect((await messages.getTimeline({})).map((r) => r.id)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
    expect(
      (await messages.getTimeline({ "#e": ["x"], limit: 1 })).map((r) => r.id),
    ).toEqual([b.id]);
    expect(
      (await messages.getTimeline([{ kinds: [7] }, { authors: [BOB] }])).map(
        (r) => r.id,
      ),
    ).toEqual([b.id, c.id]);
    expect(await messages.getEvent(a.id)).toEqual(a);
    expect(await messages.hasEvent("f".repeat(64))).toBe(false);
  });

  it("post-filters clauses the index cannot express", async () => {
    const both = rumor(1, {
      tags: [
        ["t", "a"],
        ["t", "b"],
      ],
    });
    const one = rumor(2, { tags: [["t", "a"]] });
    const { messages } = await setup(both, one);
    // NIP-91 `&` requires every value; the index only knows alternatives.
    expect(
      (await messages.getByFilters({ "&t": ["a", "b"], limit: 5 })).map(
        (r) => r.id,
      ),
    ).toEqual([both.id]);
  });

  it("resolves replaceable and addressable rumors", async () => {
    const old = rumor(1, { kind: 30000, tags: [["d", "list"]] });
    const latest = rumor(2, { kind: 30000, tags: [["d", "list"]] });
    const other = rumor(3, { kind: 30000, tags: [["d", "other"]] });
    const { messages } = await setup(old, latest, other);
    expect((await messages.getReplaceable(30000, ALICE, "list"))?.id).toBe(
      latest.id,
    );
    expect(
      (await messages.getReplaceableHistory(30000, ALICE, "list"))?.map(
        (r) => r.id,
      ),
    ).toEqual([latest.id, old.id]);
    expect(await messages.hasReplaceable(30000, BOB, "list")).toBe(false);
  });

  it("backs an AsyncRumorStore and reports session-written rows", async () => {
    const { db, messages } = await setup();
    const store = new AsyncRumorStore({ database: messages });
    const inserted: string[] = [];
    store.insert$.subscribe((r) => inserted.push(r.id));
    const r = rumor(1);
    // The session commits the row first, then announces it to the store.
    await db.transaction((tx) => tx.messages.put(messageRow(r)));
    await store.add(r);
    expect(inserted).toEqual([r.id]);
    expect((await store.getTimeline({})).map((e) => e.id)).toEqual([r.id]);

    const removed: string[] = [];
    store.remove$.subscribe((e) => removed.push(e.id));
    await db.transaction((tx) => tx.messages.delete(r.id));
    await store.remove(r.id);
    expect(removed).toEqual([r.id]);
    expect(await store.getTimeline({})).toEqual([]);
  });

  it("inserts rumors added directly and removes by filters", async () => {
    const { messages } = await setup();
    const a = rumor(1);
    const b = rumor(2, { kind: 7 });
    await messages.add(a);
    await messages.add(a);
    await messages.add(b);
    expect(await messages.removeByFilters({ kinds: [7] })).toBe(1);
    expect((await messages.getTimeline({})).map((r) => r.id)).toEqual([a.id]);
  });
});
