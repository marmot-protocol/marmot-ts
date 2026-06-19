/**
 * Tests the deterministic SelfRemove auto-committer election
 * (protocol-core/member-departure.md, darkmatter auto_committer.rs).
 */
import { describe, expect, it } from "vitest";

import { decideAutoCommit } from "../auto-committer.js";

const base = {
  memberLeafIndices: [0, 1, 2, 3],
  leaverIsActiveAdmin: false,
};

describe("decideAutoCommit", () => {
  it("elects the lowest-index eligible member (excluding the leaver)", () => {
    // Leaver is leaf 2; lowest remaining eligible is leaf 0.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 2, ownLeafIndex: 0 }),
    ).toBe("commit");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 2, ownLeafIndex: 1 }),
    ).toBe("observe");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 2, ownLeafIndex: 3 }),
    ).toBe("observe");
  });

  it("skips the leaver when it holds the lowest index (next-lowest commits)", () => {
    // Leaver is leaf 0; eligible = {1,2,3}, so leaf 1 commits.
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 0, ownLeafIndex: 1 }),
    ).toBe("commit");
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 0, ownLeafIndex: 0 }),
    ).toBe("observe");
  });

  it("never lets the leaver commit their own self_remove", () => {
    expect(
      decideAutoCommit({ ...base, leaverLeafIndex: 1, ownLeafIndex: 1 }),
    ).toBe("observe");
  });

  it("refuses to auto-commit an active admin's self_remove (fail-closed)", () => {
    expect(
      decideAutoCommit({
        ...base,
        leaverLeafIndex: 2,
        ownLeafIndex: 0,
        leaverIsActiveAdmin: true,
      }),
    ).toBe("observe");
  });

  it("observes when no eligible committer remains", () => {
    expect(
      decideAutoCommit({
        memberLeafIndices: [1],
        leaverLeafIndex: 1,
        ownLeafIndex: 1,
        leaverIsActiveAdmin: false,
      }),
    ).toBe("observe");
  });

  it("ignores blank-leaf gaps in indices (uses the true minimum)", () => {
    // Members at non-contiguous leaves; leaver 5, eligible {1,4}, leaf 1 commits.
    expect(
      decideAutoCommit({
        memberLeafIndices: [1, 4, 5],
        leaverLeafIndex: 5,
        ownLeafIndex: 1,
        leaverIsActiveAdmin: false,
      }),
    ).toBe("commit");
    expect(
      decideAutoCommit({
        memberLeafIndices: [1, 4, 5],
        leaverLeafIndex: 5,
        ownLeafIndex: 4,
        leaverIsActiveAdmin: false,
      }),
    ).toBe("observe");
  });
});
