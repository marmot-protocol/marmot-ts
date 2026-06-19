/**
 * Tests the delivered-app-payload ledger that backs the `invalidated`
 * disposition on a convergence rewind (M7, protocol-core/inbound-processing.md,
 * convergence.md).
 */
import { describe, expect, it } from "vitest";

import { DeliveredPayloadLedger } from "../delivered-payloads.js";

type Env = { id: string };
const msg = {} as never;
const entry = (id: string, epoch: number, stateTag: string) => ({
  epoch,
  stateTag,
  envelope: { id } as Env,
  message: msg,
});

describe("DeliveredPayloadLedger", () => {
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
});
