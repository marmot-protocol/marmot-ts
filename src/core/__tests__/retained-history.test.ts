/**
 * Tests for retained-history decision logic (Marmot v2 retained-history.md):
 * late-commit classification, app-payload expiry, and retain/prune sets.
 */
import { describe, expect, it } from "vitest";

import {
  classifyLateCommit,
  isAppPayloadExpired,
  prunableRetainedEpochs,
  requiredRetainedEpochs,
} from "../retained-history.js";

const base = {
  anchorEpoch: 5,
  currentTipEpoch: 10,
  maxRewindCommits: 5,
  parentArrived: true,
  retainedParentStateAvailable: true,
};

describe("late commit classification", () => {
  it("replays a commit at/after the anchor with retained parent state", () => {
    expect(classifyLateCommit({ ...base, sourceEpoch: 7 })).toEqual({
      kind: "replay",
    });
  });

  it("drops a commit older than the retained anchor as BeyondAnchor", () => {
    expect(classifyLateCommit({ ...base, sourceEpoch: 4 })).toEqual({
      kind: "beyond_anchor",
    });
  });

  it("defers when the parent commit has not arrived (transport gap)", () => {
    expect(
      classifyLateCommit({ ...base, sourceEpoch: 7, parentArrived: false }),
    ).toEqual({ kind: "deferred" });
  });

  it("reports missing_retained_anchor when retained state was lost from storage", () => {
    expect(
      classifyLateCommit({
        ...base,
        sourceEpoch: 7,
        retainedParentStateAvailable: false,
      }),
    ).toEqual({ kind: "missing_retained_anchor" });
  });

  it("marks an at/after-anchor commit forking outside the horizon as ineligible", () => {
    // anchor low enough to be at/after, but tip far ahead of source epoch.
    expect(
      classifyLateCommit({
        ...base,
        anchorEpoch: 2,
        sourceEpoch: 3,
        currentTipEpoch: 12,
      }),
    ).toEqual({ kind: "ineligible" });
  });
});

describe("app-payload window", () => {
  it("expires messages older than app_payload_past_epoch_limit", () => {
    expect(isAppPayloadExpired(4, 10, 5)).toBe(true); // 6 epochs old > 5
    expect(isAppPayloadExpired(5, 10, 5)).toBe(false); // exactly 5
    expect(isAppPayloadExpired(10, 10, 5)).toBe(false);
  });
});

describe("retain / prune sets", () => {
  it("requires every epoch inside the rollback horizon through the tip", () => {
    expect(requiredRetainedEpochs(10, 5)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(requiredRetainedEpochs(2, 5)).toEqual([0, 1, 2]); // floored at 0
  });

  it("prunes epochs older than the horizon except pinned ones", () => {
    const retained = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(prunableRetainedEpochs(retained, 10, 5)).toEqual([1, 2, 3, 4]);
    // Epoch 2 pinned (e.g. staged commit / recovery) is kept.
    expect(prunableRetainedEpochs(retained, 10, 5, [2])).toEqual([1, 3, 4]);
  });
});
