/**
 * Tests the commit-digest-attributed state-notification ledger that backs
 * withdrawal of group-state notifications on a convergence rewind (D-10,
 * D-11, CONV-02/CONV-03, protocol-core/convergence.md).
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import type { StateNotification } from "../state-notifications.js";
import { StateNotificationLedger } from "../state-notifications.js";

const digest = (label: string): Uint8Array =>
  new TextEncoder().encode(label.padEnd(8, "\0"));

const epochAdvanced = (
  label: string,
  from: number,
  to: number,
): StateNotification => ({
  kind: "epochAdvanced",
  commitDigest: digest(label),
  from,
  to,
});

const selfRemoved = (label: string): StateNotification => ({
  kind: "selfRemoved",
  commitDigest: digest(label),
});

describe("StateNotificationLedger", () => {
  it("record preserves an empty derivation as a rewind-reachable digest entry", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("a"), 1, [epochAdvanced("a", 0, 1)]);
    expect(ledger.size).toBe(1);

    ledger.record(digest("empty"), 1, []);
    expect(ledger.size).toBe(2);
    expect(ledger.has(digest("empty"), 1)).toBe(true);

    ledger.invalidatedByRewind(0, new Set([bytesToHex(digest("a"))]));
    expect(ledger.has(digest("empty"), 1)).toBe(false);
    expect(ledger.size).toBe(1);
  });

  /**
   * WR-14 regression: `invalidatedByRewind` KEEPS entries whose digest is on
   * the winning chain, so every prefix link already ledger-recorded when it
   * was first applied in-order survives the rewind. The CR-07 loop then
   * `record()`s each winner-chain link again, which used to push a SECOND
   * entry with the same digest and epoch. A later rewind superseding those
   * links then withdrew each of their notifications twice, breaking CONV-03's
   * "withdraw exactly the notifications it derived" invariant from the other
   * direction, and compounding the ledger's unbounded growth (WR-02).
   */
  it("record is idempotent on (digest, epoch), so a rewind cannot duplicate an already-recorded link", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("c1"), 2, [epochAdvanced("c1", 1, 2)]);

    // The CR-07 winner-chain loop re-records the same already-applied link.
    ledger.record(digest("c1"), 2, [epochAdvanced("c1", 1, 2)]);
    expect(ledger.size).toBe(1);

    // A later rewind that supersedes it withdraws its notifications exactly
    // once, not twice.
    const withdrawn = ledger.invalidatedByRewind(1, new Set());
    expect(withdrawn).toHaveLength(1);
    expect(ledger.size).toBe(0);
  });

  it("has distinguishes the same digest at a different epoch", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("c1"), 2, [epochAdvanced("c1", 1, 2)]);
    expect(ledger.has(digest("c1"), 2)).toBe(true);
    expect(ledger.has(digest("c1"), 3)).toBe(false);
    expect(ledger.has(digest("other"), 2)).toBe(false);
  });

  it("invalidatedByRewind returns notifications above the fork epoch whose digest is absent from canonicalDigests, and removes them", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("shared"), 1, [epochAdvanced("shared", 0, 1)]);
    ledger.record(digest("losing"), 2, [epochAdvanced("losing", 1, 2)]);
    ledger.record(digest("winning"), 2, [epochAdvanced("winning", 1, 2)]);

    const canonical = new Set([
      bytesToHex(digest("shared")),
      bytesToHex(digest("winning")),
    ]);

    const invalidated = ledger.invalidatedByRewind(1, canonical);

    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]?.commitDigest).toEqual(digest("losing"));
    expect(ledger.size).toBe(2);
  });

  it("invalidatedByRewind retains entries at or below the fork epoch (shared history)", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("at-fork"), 2, [epochAdvanced("at-fork", 1, 2)]);
    ledger.record(digest("below-fork"), 1, [epochAdvanced("below-fork", 0, 1)]);

    const invalidated = ledger.invalidatedByRewind(2, new Set());
    expect(invalidated).toEqual([]);
    expect(ledger.size).toBe(2);
  });

  it("invalidatedByRewind retains entries above the fork epoch whose digest IS in canonicalDigests", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("winning"), 2, [epochAdvanced("winning", 1, 2)]);

    const canonical = new Set([bytesToHex(digest("winning"))]);
    const invalidated = ledger.invalidatedByRewind(1, canonical);

    expect(invalidated).toEqual([]);
    expect(ledger.size).toBe(1);
  });

  it("invalidatedByRewind returns an empty array on an empty ledger", () => {
    const ledger = new StateNotificationLedger();
    expect(ledger.invalidatedByRewind(0, new Set())).toEqual([]);
  });

  it("pruneBelow drops entries strictly below the given epoch and keeps entries at that epoch", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("old"), 1, [epochAdvanced("old", 0, 1)]);
    ledger.record(digest("kept"), 3, [epochAdvanced("kept", 2, 3)]);

    ledger.pruneBelow(3);
    expect(ledger.size).toBe(1);

    const invalidated = ledger.invalidatedByRewind(2, new Set());
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0]?.commitDigest).toEqual(digest("kept"));
  });

  it("a selfRemoved notification recorded above the fork epoch on a losing branch is returned by invalidatedByRewind", () => {
    const ledger = new StateNotificationLedger();
    ledger.record(digest("losing"), 2, [selfRemoved("losing")]);

    const invalidated = ledger.invalidatedByRewind(1, new Set());
    expect(invalidated.some((n) => n.kind === "selfRemoved")).toBe(true);
  });
});
