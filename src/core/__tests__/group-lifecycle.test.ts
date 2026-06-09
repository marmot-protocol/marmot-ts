/**
 * Tests for the group lifecycle state machine (Marmot v2 group-state.md):
 * legal transitions and the commit/apply/fork-detection gates.
 */
import { describe, expect, it } from "vitest";

import {
  canTransitionLifecycle,
  groupLifecycleStates as S,
  mayApplyRetainedInbound,
  mayPrepareLocalCommit,
  mayRunForkDetection,
  transitionLifecycle,
} from "../group-lifecycle.js";

describe("legal transitions", () => {
  const legal: Array<[string, string]> = [
    [S.stable, S.pendingPublish],
    [S.pendingPublish, S.merging],
    [S.pendingPublish, S.stable],
    [S.merging, S.stable],
    [S.stable, S.recovering],
    [S.recovering, S.stable],
    [S.recovering, S.unrecoverable],
    [S.unrecoverable, S.stable],
    [S.recovering, S.recovering], // implicit re-entry
  ];

  it("accepts every edge in group-state.md", () => {
    for (const [from, to] of legal) {
      expect(canTransitionLifecycle(from as never, to as never)).toBe(true);
    }
  });

  it("rejects edges not in the spec", () => {
    // No Merging -> Recovering edge (spec is explicit about this).
    expect(canTransitionLifecycle(S.merging, S.recovering)).toBe(false);
    // Cannot jump Stable -> Merging or Stable -> Unrecoverable.
    expect(canTransitionLifecycle(S.stable, S.merging)).toBe(false);
    expect(canTransitionLifecycle(S.stable, S.unrecoverable)).toBe(false);
    expect(canTransitionLifecycle(S.unrecoverable, S.recovering)).toBe(false);
  });

  it("transitionLifecycle throws on an illegal edge", () => {
    expect(() => transitionLifecycle(S.merging, S.recovering)).toThrow(
      /Illegal/,
    );
    expect(transitionLifecycle(S.stable, S.pendingPublish)).toBe(
      S.pendingPublish,
    );
  });
});

describe("lifecycle gates", () => {
  it("only Stable may prepare a local commit and run fork detection", () => {
    expect(mayPrepareLocalCommit(S.stable)).toBe(true);
    expect(mayRunForkDetection(S.stable)).toBe(true);
    for (const s of [
      S.pendingPublish,
      S.merging,
      S.recovering,
      S.unrecoverable,
    ]) {
      expect(mayPrepareLocalCommit(s)).toBe(false);
      expect(mayRunForkDetection(s)).toBe(false);
    }
  });

  it("only Stable and Recovering may apply retained inbound to canonical state", () => {
    expect(mayApplyRetainedInbound(S.stable)).toBe(true);
    expect(mayApplyRetainedInbound(S.recovering)).toBe(true);
    expect(mayApplyRetainedInbound(S.pendingPublish)).toBe(false);
    expect(mayApplyRetainedInbound(S.merging)).toBe(false);
    expect(mayApplyRetainedInbound(S.unrecoverable)).toBe(false);
  });
});
