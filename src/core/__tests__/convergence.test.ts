/**
 * Tests for the deterministic convergence selection core, ported from darkmatter
 * `cgka-engine/src/convergence.rs`. These lock the branch-selection ordering and
 * same-epoch tiebreak that every implementation MUST compute identically.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  type AppWitness,
  type BranchCandidate,
  commitDigest,
  compareCommitOrderingKeys,
  DEFAULT_CONVERGENCE_POLICY,
  isBranchEligible,
  isWitnessEligible,
  selectCanonicalBranch,
  validateConvergencePolicy,
} from "../convergence.js";

const policy = DEFAULT_CONVERGENCE_POLICY;
const digest = (n: number) => {
  const b = new Uint8Array(32);
  b[31] = n;
  return b;
};

function branch(
  id: string,
  forkEpoch: number,
  tipEpoch: number,
  tip: Uint8Array,
  witnesses: AppWitness[] = [],
): BranchCandidate {
  return { id, forkEpoch, tipEpoch, tipDigest: tip, appWitnesses: witnesses };
}

const sender = (n: number) => new Uint8Array([n]);

describe("convergence policy", () => {
  it("default satisfies the witness-override bound", () => {
    expect(() => validateConvergencePolicy(policy)).not.toThrow();
    expect(policy).toEqual({
      policyVersion: 1,
      maxRewindCommits: 5,
      appPayloadPastEpochLimit: 5,
      settlementQuiescenceMs: 1000,
      witnessQuorumSendersPerEpoch: 2,
      witnessQuorumEpochs: 1,
      maxWitnessOverrideDepth: 1,
    });
  });

  it("rejects a policy whose override boost exceeds the rewind horizon", () => {
    expect(() =>
      validateConvergencePolicy({ ...policy, maxWitnessOverrideDepth: 6 }),
    ).toThrow(/max_witness_override_depth/);
  });

  it("carries the profile-1 retention + settlement constants", () => {
    expect(policy.policyVersion).toBe(1);
    expect(policy.appPayloadPastEpochLimit).toBe(5);
    expect(policy.settlementQuiescenceMs).toBe(1000);
  });
});

describe("app-payload witness eligibility (convergence.md + retained-history.md)", () => {
  const w = (epoch: number): AppWitness => ({ epoch, sender: sender(1) });

  it("excludes witnesses at or before the fork epoch", () => {
    expect(isWitnessEligible(w(3), 3, 4, policy)).toBe(false); // at fork
    expect(isWitnessEligible(w(2), 3, 4, policy)).toBe(false); // before fork
    expect(isWitnessEligible(w(4), 3, 4, policy)).toBe(true); // after fork
  });

  it("excludes witnesses outside the retained app-payload window of the tip", () => {
    // limit = 5; reference tip is the candidate tip epoch.
    expect(isWitnessEligible(w(4), 3, 10, policy)).toBe(false); // 10 - 4 = 6 > 5
    expect(isWitnessEligible(w(5), 3, 10, policy)).toBe(true); // 10 - 5 = 5 <= 5
  });
});

describe("branch eligibility (rollback horizon)", () => {
  it("admits branches within max_rewind_commits and rejects beyond", () => {
    expect(isBranchEligible(10, branch("a", 5, 11, digest(1)), policy)).toBe(
      true,
    );
    expect(isBranchEligible(10, branch("b", 4, 11, digest(1)), policy)).toBe(
      false,
    );
  });
});

describe("branch selection ordering", () => {
  it("prefers higher raw commit depth", () => {
    const shallow = branch("shallow", 8, 9, digest(1));
    const deep = branch("deep", 8, 11, digest(9));
    expect(selectCanonicalBranch(10, [shallow, deep], policy)?.id).toBe("deep");
  });

  it("breaks an otherwise-equal race by the lower tip digest", () => {
    const hi = branch("hi", 9, 10, digest(9));
    const lo = branch("lo", 9, 10, digest(1));
    expect(selectCanonicalBranch(10, [hi, lo], policy)?.id).toBe("lo");
    // Order-independent.
    expect(selectCanonicalBranch(10, [lo, hi], policy)?.id).toBe("lo");
  });

  it("lets a witness-quorum branch boost past an equal-depth rival, within cap", () => {
    // Both raw depth 1; the witnessed branch gets +1 effective depth.
    const witnessed = branch("witnessed", 9, 10, digest(9), [
      { epoch: 10, sender: sender(1) },
      { epoch: 10, sender: sender(2) },
    ]);
    const bare = branch("bare", 9, 10, digest(1));
    expect(selectCanonicalBranch(10, [witnessed, bare], policy)?.id).toBe(
      "witnessed",
    );
  });

  it("does not let the witness boost beat an arbitrarily deeper valid branch", () => {
    const witnessedShallow = branch("witnessed", 9, 10, digest(1), [
      { epoch: 10, sender: sender(1) },
      { epoch: 10, sender: sender(2) },
    ]);
    const deeper = branch("deeper", 6, 10, digest(9)); // raw depth 4 vs 1+1
    expect(
      selectCanonicalBranch(10, [witnessedShallow, deeper], policy)?.id,
    ).toBe("deeper");
  });

  it("does not grant the quorum depth boost to one sender spamming an epoch", () => {
    // One distinct sender (3 messages) → below quorum (2), so no +1 depth boost:
    // raw depth stays 1 and a depth-2 rival with no witnesses wins.
    const spam = branch("spam", 9, 10, digest(1), [
      { epoch: 10, sender: sender(1) },
      { epoch: 10, sender: sender(1) },
      { epoch: 10, sender: sender(1) },
    ]);
    const deeper = branch("deeper", 8, 10, digest(9)); // raw depth 2, no boost
    expect(selectCanonicalBranch(10, [spam, deeper], policy)?.id).toBe(
      "deeper",
    );
  });

  it("returns undefined when no candidate is eligible", () => {
    expect(
      selectCanonicalBranch(20, [branch("old", 1, 2, digest(1))], policy),
    ).toBeUndefined();
  });
});

describe("same-epoch race ordering", () => {
  it("commitDigest is SHA-256 of the MLS bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(commitDigest(bytes)).toEqual(sha256(bytes));
    expect(commitDigest(bytes)).toHaveLength(32);
  });

  it("orders by source epoch, then lower commit digest", () => {
    const a = { sourceEpoch: 5, commitDigest: digest(2) };
    const b = { sourceEpoch: 5, commitDigest: digest(9) };
    expect(compareCommitOrderingKeys(a, b)).toBeLessThan(0); // a (lower digest) first
    const earlier = { sourceEpoch: 4, commitDigest: digest(9) };
    expect(compareCommitOrderingKeys(earlier, a)).toBeLessThan(0); // lower epoch first
  });
});
