import { describe, expect, it } from "vitest";

import {
  type BranchCandidate,
  DEFAULT_CONVERGENCE_POLICY,
  isBranchEligible,
  validateConvergencePolicy,
} from "../convergence.js";
import {
  classifyLateCommit,
  prunableRetainedEpochs,
} from "../retained-history.js";

const UNLIMITED = {
  ...DEFAULT_CONVERGENCE_POLICY,
  maxRewindCommits: Number.POSITIVE_INFINITY,
};

const branch = (forkEpoch: number, tipEpoch: number): BranchCandidate => ({
  id: "b",
  forkEpoch,
  tipEpoch,
  tipDigest: new Uint8Array(32),
  appWitnesses: [],
});

describe("convergence policy with an infinite rollback horizon", () => {
  it("validates: an unlimited horizon never trips the witness-override invariant", () => {
    expect(() => validateConvergencePolicy(UNLIMITED)).not.toThrow();
  });

  it("keeps a fork eligible no matter how far back it diverged", () => {
    // Diverged 1000 epochs ago — far outside the default horizon of 5.
    const ancient = branch(0, 0);
    expect(isBranchEligible(1000, ancient, DEFAULT_CONVERGENCE_POLICY)).toBe(
      false,
    );
    expect(isBranchEligible(1000, ancient, UNLIMITED)).toBe(true);
  });

  it("never classifies a late commit as ineligible by age", () => {
    const ctx = {
      sourceEpoch: 1,
      anchorEpoch: 0,
      currentTipEpoch: 100,
      parentArrived: true,
      retainedParentStateAvailable: true,
    };
    expect(classifyLateCommit({ ...ctx, maxRewindCommits: 5 }).kind).toBe(
      "ineligible",
    );
    expect(
      classifyLateCommit({ ...ctx, maxRewindCommits: Number.POSITIVE_INFINITY })
        .kind,
    ).toBe("replay");
  });

  it("prunes nothing under an unlimited horizon", () => {
    const epochs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(prunableRetainedEpochs(epochs, 10, 5)).not.toHaveLength(0);
    expect(
      prunableRetainedEpochs(epochs, 10, Number.POSITIVE_INFINITY),
    ).toHaveLength(0);
  });
});
