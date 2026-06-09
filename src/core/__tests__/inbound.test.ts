/**
 * Tests for the inbound-processing vocabulary (categories, dispositions, and
 * convergence-outcome mapping) from the Marmot v2 inbound-processing + errors
 * specs.
 */
import { describe, expect, it } from "vitest";

import {
  convergenceOutcomeToCategory,
  disposition,
  inputCategories,
} from "../inbound.js";

describe("input categories", () => {
  it("covers the full foundation/errors.md taxonomy with the wire names", () => {
    expect(new Set(Object.values(inputCategories))).toEqual(
      new Set([
        "duplicate",
        "own_echo",
        "wrong_recipient",
        "unknown_group",
        "already_applied",
        "stale_epoch",
        "invalid_encoding",
        "invalid_signature",
        "unsupported_required_feature",
        "authorization_failed",
        "missing_history",
        "transport_rejected",
      ]),
    );
  });
});

describe("convergence outcome mapping", () => {
  it("maps retained-anchor outcomes to missing_history", () => {
    expect(convergenceOutcomeToCategory.BeyondAnchor).toBe("missing_history");
    expect(convergenceOutcomeToCategory.MissingRetainedAnchor).toBe(
      "missing_history",
    );
  });
});

describe("disposition constructors", () => {
  it("builds the four protocol-visible dispositions", () => {
    expect(disposition.accepted()).toEqual({ kind: "accepted" });
    expect(disposition.stale(inputCategories.duplicate)).toEqual({
      kind: "stale",
      category: "duplicate",
    });
    expect(disposition.deferred("future_epoch")).toEqual({
      kind: "deferred",
      reason: "future_epoch",
    });
    expect(disposition.invalidated()).toEqual({ kind: "invalidated" });
  });
});
