import { describe, expect, it } from "vitest";

import { groupLifecycleStates } from "../group-lifecycle.js";
import {
  convergenceStatuses,
  deriveConvergenceStatus,
  isConvergenceStatusLegal,
  mayReleaseOutbound,
  shouldQueueOutbound,
  type ConvergenceStatusInput,
} from "../convergence-status.js";

const base: ConvergenceStatusInput = {
  nowMs: 10_000,
  lastConvergenceRelevantInputMs: 10_000,
  settlementQuiescenceMs: 1_000,
  hasUnresolvedInput: false,
  hasBlockingError: false,
};

describe("deriveConvergenceStatus", () => {
  it("is Syncing while the quiescence window has not elapsed", () => {
    expect(deriveConvergenceStatus({ ...base, nowMs: 10_500 })).toBe(
      convergenceStatuses.syncing,
    );
    // Exactly at the boundary the window has NOT elapsed (strict `<`).
    expect(deriveConvergenceStatus({ ...base, nowMs: 10_999 })).toBe(
      convergenceStatuses.syncing,
    );
  });

  it("Syncing wins even when there is unresolved input or a blocking error", () => {
    expect(
      deriveConvergenceStatus({
        ...base,
        nowMs: 10_100,
        hasUnresolvedInput: true,
        hasBlockingError: true,
      }),
    ).toBe(convergenceStatuses.syncing);
  });

  it("is Settled once the window elapses with a clean fixed point", () => {
    expect(deriveConvergenceStatus({ ...base, nowMs: 11_000 })).toBe(
      convergenceStatuses.settled,
    );
  });

  it("is Resolving when the window elapsed but input is unresolved", () => {
    expect(
      deriveConvergenceStatus({
        ...base,
        nowMs: 12_000,
        hasUnresolvedInput: true,
      }),
    ).toBe(convergenceStatuses.resolving);
  });

  it("Resolving takes precedence over Blocked", () => {
    expect(
      deriveConvergenceStatus({
        ...base,
        nowMs: 12_000,
        hasUnresolvedInput: true,
        hasBlockingError: true,
      }),
    ).toBe(convergenceStatuses.resolving);
  });

  it("is Blocked when the window elapsed, input resolved, but a blocking error remains", () => {
    expect(
      deriveConvergenceStatus({
        ...base,
        nowMs: 12_000,
        hasBlockingError: true,
      }),
    ).toBe(convergenceStatuses.blocked);
  });

  it("clamps a clock that runs backwards to Syncing", () => {
    expect(
      deriveConvergenceStatus({
        ...base,
        nowMs: 5_000,
        lastConvergenceRelevantInputMs: 10_000,
      }),
    ).toBe(convergenceStatuses.syncing);
  });
});

describe("isConvergenceStatusLegal", () => {
  const { stable, recovering, unrecoverable, pendingPublish, merging } =
    groupLifecycleStates;

  it("matches the group-state.md legal-combination table", () => {
    expect(isConvergenceStatusLegal(convergenceStatuses.syncing, stable)).toBe(
      true,
    );
    expect(
      isConvergenceStatusLegal(convergenceStatuses.syncing, recovering),
    ).toBe(true);
    expect(
      isConvergenceStatusLegal(convergenceStatuses.resolving, recovering),
    ).toBe(true);
    expect(isConvergenceStatusLegal(convergenceStatuses.settled, stable)).toBe(
      true,
    );
    expect(
      isConvergenceStatusLegal(convergenceStatuses.blocked, recovering),
    ).toBe(true);
    expect(
      isConvergenceStatusLegal(convergenceStatuses.blocked, unrecoverable),
    ).toBe(true);
  });

  it("rejects Settled outside Stable and any status in the local-publish states", () => {
    expect(
      isConvergenceStatusLegal(convergenceStatuses.settled, recovering),
    ).toBe(false);
    expect(isConvergenceStatusLegal(convergenceStatuses.blocked, stable)).toBe(
      false,
    );
    expect(
      isConvergenceStatusLegal(convergenceStatuses.syncing, pendingPublish),
    ).toBe(false);
    expect(isConvergenceStatusLegal(convergenceStatuses.settled, merging)).toBe(
      false,
    );
  });
});

describe("outbound gating", () => {
  it("queues outbound unless Settled", () => {
    expect(shouldQueueOutbound(convergenceStatuses.syncing)).toBe(true);
    expect(shouldQueueOutbound(convergenceStatuses.resolving)).toBe(true);
    expect(shouldQueueOutbound(convergenceStatuses.blocked)).toBe(true);
    expect(shouldQueueOutbound(convergenceStatuses.settled)).toBe(false);
  });

  it("releases outbound only when Settled and Stable", () => {
    expect(
      mayReleaseOutbound(
        convergenceStatuses.settled,
        groupLifecycleStates.stable,
      ),
    ).toBe(true);
    expect(
      mayReleaseOutbound(
        convergenceStatuses.settled,
        groupLifecycleStates.recovering,
      ),
    ).toBe(false);
    expect(
      mayReleaseOutbound(
        convergenceStatuses.syncing,
        groupLifecycleStates.stable,
      ),
    ).toBe(false);
  });
});
