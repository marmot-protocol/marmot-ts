import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { EventsTable, TrafficTable } from "./relay-tables.js";

const event: NostrEvent = {
  id: "a".repeat(64),
  pubkey: "b".repeat(64),
  sig: "c".repeat(128),
  kind: 1,
  created_at: 1,
  tags: [],
  content: "<script>not executable</script>",
};

describe("relay inspector tables", () => {
  it("renders traffic columns, filter previews, zero results and collapsed JSON controls", () => {
    const html = renderToStaticMarkup(
      createElement(TrafficTable, {
        entries: [
          {
            id: 1,
            at: 1000,
            actor: "you",
            tab: "demo-tab",
            op: "publish",
            event,
          },
          {
            id: 2,
            at: 2000,
            actor: "clock",
            op: "request",
            filters: [{ kinds: [1] }],
            results: 0,
          },
        ],
      }),
    );
    for (const heading of [
      "Time",
      "Actor",
      "Tab",
      "Operation",
      "Event / filters",
      "Results",
      "Details",
    ])
      expect(html).toContain(`<th scope="col">${heading}</th>`);
    expect(html).toContain("demo-tab");
    expect(html).toContain("kind 1");
    expect(html).toContain("[{&quot;kinds&quot;:[1]}]");
    expect(html).toContain('class="text-right tabular-nums">0</td>');
    expect(html).toContain('aria-label="Inspect traffic entry 1"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain("<pre");
  });

  it("renders event metadata with full identifiers available and escapes content previews", () => {
    const html = renderToStaticMarkup(
      createElement(EventsTable, { events: [event] }),
    );
    for (const heading of [
      "Created",
      "Kind",
      "Event ID",
      "Author",
      "Content",
      "Details",
    ])
      expect(html).toContain(`<th scope="col">${heading}</th>`);
    expect(html).toContain(`title="${event.id}"`);
    expect(html).toContain(`title="${event.pubkey}"`);
    expect(html).toContain("1970-01-01T00:00:01.000Z");
    expect(html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain(`aria-label="Inspect event ${event.id}"`);
  });

  it("keeps empty states inside the tables", () => {
    expect(
      renderToStaticMarkup(createElement(TrafficTable, { entries: [] })),
    ).toContain(
      'colSpan="7" class="py-8 text-center text-base-content/60">No traffic.</td>',
    );
    expect(
      renderToStaticMarkup(createElement(EventsTable, { events: [] })),
    ).toContain(
      'colSpan="6" class="py-8 text-center text-base-content/60">No stored events.</td>',
    );
  });
});
