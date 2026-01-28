import { describe, expect, it } from "vitest";

import { compareCursor, type OuterCursor } from "../utils/cursor.js";

describe("compareCursor", () => {
  it("orders by created_at, then by id", () => {
    const a: OuterCursor = { created_at: 10, id: "b" };
    const b: OuterCursor = { created_at: 11, id: "a" };
    const c: OuterCursor = { created_at: 10, id: "a" };

    expect(compareCursor(a, b)).toBe(-1);
    expect(compareCursor(b, a)).toBe(1);
    expect(compareCursor(c, a)).toBe(-1);
    expect(compareCursor(a, c)).toBe(1);
  });

  it("returns 0 only when both created_at and id match", () => {
    const a: OuterCursor = { created_at: 10, id: "a" };
    const b: OuterCursor = { created_at: 10, id: "a" };
    const c: OuterCursor = { created_at: 10, id: "b" };

    expect(compareCursor(a, b)).toBe(0);
    expect(compareCursor(a, c)).not.toBe(0);
  });
});

describe("OuterCursor composite pagination stability", () => {
  it("can paginate through same-second events without skipping any", () => {
    const items: OuterCursor[] = [
      { created_at: 100, id: "a" },
      { created_at: 100, id: "b" },
      { created_at: 100, id: "c" },
      { created_at: 101, id: "a" },
      { created_at: 101, id: "b" },
    ];

    // sort ascending by composite cursor
    const sorted = Array.from(items).sort((x, y) => compareCursor(x, y));

    // simulate backwards pagination (newest first), using an "until" cursor
    // meaning: return entries where cursor < until (exclusive)
    const newestFirst = Array.from(sorted).reverse();

    const limit = 2;
    let until: OuterCursor | undefined = undefined;
    const seen: OuterCursor[] = [];

    while (true) {
      const page = newestFirst
        .filter((c) => (until ? compareCursor(c, until) === -1 : true))
        .slice(0, limit);
      if (page.length === 0) break;
      seen.push(...page);
      until = page[page.length - 1]; // oldest item in this page (since newestFirst)
    }

    expect(seen).toEqual(newestFirst);
  });
});
