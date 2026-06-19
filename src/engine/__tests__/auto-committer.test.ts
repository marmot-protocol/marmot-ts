/**
 * Tests the deterministic SelfRemove auto-committer election
 * (protocol-core/member-departure.md, darkmatter auto_committer.rs).
 */
import { describe, expect, it } from "vitest";

import { decideAutoCommit } from "../auto-committer.js";

const base = {
  memberLeafIndices: [0, 1, 2, 3],
  anyLeaverIsActiveAdmin: false,
};

describe("decideAutoCommit", () => {
  it("elects the lowest-index eligible member (excluding the leaver)", () => {
    // Leaver is leaf 2; lowest remaining eligible is leaf 0.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [2], ownLeafIndex: 0 }),
    ).toBe("commit");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [2], ownLeafIndex: 1 }),
    ).toBe("observe");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [2], ownLeafIndex: 3 }),
    ).toBe("observe");
  });

  it("skips the leaver when it holds the lowest index (next-lowest commits)", () => {
    // Leaver is leaf 0; eligible = {1,2,3}, so leaf 1 commits.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [0], ownLeafIndex: 1 }),
    ).toBe("commit");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [0], ownLeafIndex: 0 }),
    ).toBe("observe");
  });

  it("never lets a leaver commit the batch", () => {
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [1], ownLeafIndex: 1 }),
    ).toBe("observe");
  });

  it("excludes all leavers from eligibility (concurrent leaves)", () => {
    // Leavers 0 and 1; eligible = {2,3}, so leaf 2 commits both.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [0, 1], ownLeafIndex: 2 }),
    ).toBe("commit");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [0, 1], ownLeafIndex: 3 }),
    ).toBe("observe");
    // A leaver (0 or 1) still never commits, even if it would be lowest-eligible.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [0, 1], ownLeafIndex: 0 }),
    ).toBe("observe");
  });

  it("refuses to auto-commit a batch with an active-admin leaver (fail-closed)", () => {
    expect(
      decideAutoCommit({
        ...base,
        leaverLeafIndices: [2],
        ownLeafIndex: 0,
        anyLeaverIsActiveAdmin: true,
      }),
    ).toBe("observe");
  });

  it("observes when there are no leavers or no eligible committer", () => {
    expect(
      decideAutoCommit({ ...base, leaverLeafIndices: [], ownLeafIndex: 0 }),
    ).toBe("observe");
    expect(
      decideAutoCommit({
        memberLeafIndices: [1],
        leaverLeafIndices: [1],
        ownLeafIndex: 1,
        anyLeaverIsActiveAdmin: false,
      }),
    ).toBe("observe");
  });

  it("ignores blank-leaf gaps in indices (uses the true minimum)", () => {
    // Members at non-contiguous leaves; leaver 5, eligible {1,4}, leaf 1 commits.
    expect(
      decideAutoCommit({
        memberLeafIndices: [1, 4, 5],
        leaverLeafIndices: [5],
        ownLeafIndex: 1,
        anyLeaverIsActiveAdmin: false,
      }),
    ).toBe("commit");
    expect(
      decideAutoCommit({
        memberLeafIndices: [1, 4, 5],
        leaverLeafIndices: [5],
        ownLeafIndex: 4,
        anyLeaverIsActiveAdmin: false,
      }),
    ).toBe("observe");
  });
});
