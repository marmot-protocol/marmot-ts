/**
 * Tests the delivered-app-payload ledger that backs the `invalidated`
 * disposition on a convergence rewind (M7, protocol-core/inbound-processing.md,
 * convergence.md).
 */
import { describe, expect, it } from "vitest";

import { DeliveredPayloadLedger } from "../delivered-payloads.js";

type Env = { id: string };
const entry = (id: string, epoch: number, stateTag: string) => ({
  epoch,
  stateTag,
  envelope: { id } as Env,
  message: { id } as never,
  payload: new Uint8Array(),
});

describe("DeliveredPayloadLedger", () => {
  it("record is idempotent for the same state-tag and message identity", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    const delivered = entry("same", 2, "tag-fork");

    ledger.record(delivered);
    ledger.record(delivered);

    expect(ledger.size).toBe(1);
    expect(ledger.has(delivered.stateTag, delivered.message)).toBe(true);
  });

  it("keeps distinct messages delivered against the same branch state", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    const first = entry("first", 2, "tag-fork");
    const second = entry("second", 2, "tag-fork");

    ledger.record(first);
    ledger.record(second);

    expect(ledger.size).toBe(2);
    expect(ledger.has(first.stateTag, first.message)).toBe(true);
    expect(ledger.has(second.stateTag, second.message)).toBe(true);
  });

  it("invalidates payloads above the fork epoch whose branch is abandoned", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    // Two payloads at epoch 2 on competing branches, one at epoch 1 (shared).
    ledger.record(entry("shared", 1, "tag-root"));
    ledger.record(entry("losing", 2, "tag-losing"));
    ledger.record(entry("winning", 2, "tag-winning"));

    const canonical = new Set(["tag-root", "tag-winning"]);
    const invalidated = ledger.invalidatedByRewind(1, canonical);

    // Only the payload on the abandoned (non-canonical) branch is retracted.
    expect(invalidated.map((e) => e.envelope.id)).toEqual(["losing"]);
    // It is removed; the others remain for any future evaluation.
    expect(ledger.size).toBe(2);
  });

  it("keeps payloads at or below the fork epoch (shared history)", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    ledger.record(entry("at-fork", 2, "tag-fork"));
    ledger.record(entry("below-fork", 1, "tag-below"));

    // Fork at epoch 2: nothing above it, so the rewind invalidates nothing even
    // though neither delivery tag is on the canonical chain.
    const invalidated = ledger.invalidatedByRewind(2, new Set(["tag-other"]));
    expect(invalidated).toEqual([]);
    expect(ledger.size).toBe(2);
  });

  it("prunes entries below the retained anchor", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    ledger.record(entry("old", 1, "tag-1"));
    ledger.record(entry("kept", 3, "tag-3"));

    ledger.pruneBelow(3);
    expect(ledger.size).toBe(1);
    // The pruned (sub-anchor) payload can never be invalidated by a later rewind.
    const invalidated = ledger.invalidatedByRewind(2, new Set());
    expect(invalidated.map((e) => e.envelope.id)).toEqual(["kept"]);
  });

  it("retains entries named by a fork node older than the retained anchor", () => {
    const ledger = new DeliveredPayloadLedger<Env>();
    ledger.record(entry("old-fork", 1, "tag-old-fork"));
    ledger.record(entry("tip", 4, "tag-tip"));

    const retainedAnchor = 3;
    const oldestTreeEpoch = 1;
    ledger.pruneBelow(Math.min(retainedAnchor, oldestTreeEpoch));

    expect(ledger.size).toBe(2);
    expect(
      ledger.invalidatedByRewind(0, new Set(["tag-tip"])).map((item) =>
        item.envelope.id,
      ),
    ).toEqual(["old-fork"]);
  });
});
