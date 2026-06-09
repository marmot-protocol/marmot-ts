/**
 * Tests the mapping from ingest results to the inbound-processing Disposition
 * taxonomy (protocol-core/inbound-processing.md).
 */
import { describe, expect, it } from "vitest";

import { ingestResultDisposition, type IngestResult } from "../marmot-group.js";

const stub = { event: {} as never, message: {} as never };

describe("ingestResultDisposition", () => {
  it("maps processed to accepted", () => {
    expect(
      ingestResultDisposition({
        kind: "processed",
        result: {} as never,
        ...stub,
      }),
    ).toEqual({ kind: "accepted" });
  });

  it("maps rejected to a stale authorization_failed", () => {
    expect(
      ingestResultDisposition({
        kind: "rejected",
        result: {} as never,
        ...stub,
      }),
    ).toEqual({ kind: "stale", category: "authorization_failed" });
  });

  it("maps skipped reasons to their categories", () => {
    const cases: Array<[IngestResult["kind"], string, string]> = [
      ["skipped", "past-epoch", "already_applied"],
      ["skipped", "self-echo", "own_echo"],
      ["skipped", "wrong-wireformat", "invalid_encoding"],
      // Retained-anchor convergence outcomes (retained-history.md).
      ["skipped", "beyond-anchor", "missing_history"],
      ["skipped", "missing-retained-anchor", "missing_history"],
    ];
    for (const [, reason, category] of cases) {
      expect(
        ingestResultDisposition({
          kind: "skipped",
          reason: reason as never,
          ...stub,
        }),
      ).toEqual({ kind: "stale", category });
    }
  });

  it("maps unreadable to a terminal stale invalid_encoding", () => {
    expect(
      ingestResultDisposition({ kind: "unreadable", errors: [], ...stub }),
    ).toEqual({ kind: "stale", category: "invalid_encoding" });
  });
});
