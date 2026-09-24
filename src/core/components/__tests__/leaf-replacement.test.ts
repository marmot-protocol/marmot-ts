/**
 * Tests for {@link classifyChangedLeaf} (Phase 9, D-01/D-02/D-03): the pure
 * three-bucket changed-leaf classifier. These are pure unit tests over
 * hand-built `ChangedLeaf` and `ProposalWithSender` values — no MLS group
 * construction and no ciphersuite are needed, since the classifier reads only
 * proposal types, sender indexes, and signature bytes.
 */
import { defaultProposalTypes, type LeafNode, type Proposal } from "ts-mls";
import { describe, expect, it } from "vitest";

import type { ChangedLeaf } from "../tree-diff.js";
import {
  classifyChangedLeaf,
  type ChangedLeafClassificationInput,
} from "../leaf-replacement.js";

/** A minimal `LeafNode`-shaped fixture carrying only the fields this classifier reads. */
function fakeLeaf(signature: Uint8Array): LeafNode {
  return { signature } as unknown as LeafNode;
}

function changedLeaf(leafIndex: number, signature: Uint8Array): ChangedLeaf {
  return { leafIndex, leaf: fakeLeaf(signature) };
}

function addProposal(signature: Uint8Array): Proposal {
  return {
    proposalType: defaultProposalTypes.add,
    add: { keyPackage: { leafNode: fakeLeaf(signature) } },
  } as unknown as Proposal;
}

function updateProposal(): Proposal {
  return {
    proposalType: defaultProposalTypes.update,
    update: { leafNode: fakeLeaf(new Uint8Array([0])) },
  } as unknown as Proposal;
}

const SIG_A = new Uint8Array([1, 2, 3]);
const SIG_B = new Uint8Array([4, 5, 6]);

describe("classifyChangedLeaf", () => {
  it("Test 1: matches an Add proposal by signature bytes even when the changed leaf's index is a slot freed by a Remove in the same commit", () => {
    const changed = changedLeaf(3, SIG_A);
    const input: ChangedLeafClassificationInput = {
      proposals: [{ proposal: addProposal(SIG_A), senderLeafIndex: undefined }],
      committerLeafIndex: undefined,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({ kind: "add" });
  });

  it("Test 2: matches an Update proposal whose senderLeafIndex equals the changed leaf's index", () => {
    const changed = changedLeaf(2, SIG_B);
    const input: ChangedLeafClassificationInput = {
      proposals: [{ proposal: updateProposal(), senderLeafIndex: 2 }],
      committerLeafIndex: undefined,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({
      kind: "update-proposal",
      senderLeafIndex: 2,
    });
  });

  it("Test 3: matches committerLeafIndex when nothing else matches", () => {
    const changed = changedLeaf(0, SIG_A);
    const input: ChangedLeafClassificationInput = {
      proposals: [],
      committerLeafIndex: 0,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({
      kind: "committer-update-path",
    });
  });

  it("Test 4: with committerLeafIndex defined and proposals supplied, a changed leaf matching nothing is unattributable", () => {
    const changed = changedLeaf(5, SIG_A);
    const input: ChangedLeafClassificationInput = {
      proposals: [{ proposal: updateProposal(), senderLeafIndex: 2 }],
      committerLeafIndex: 0,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({
      kind: "unattributable",
    });
  });

  it("Test 5: with input undefined, any changed leaf is undecidable", () => {
    const changed = changedLeaf(0, SIG_A);
    expect(classifyChangedLeaf(changed, undefined)).toEqual({
      kind: "undecidable",
    });
  });

  it("Test 6: with input supplied but committerLeafIndex undefined, a changed leaf matching no proposal is undecidable", () => {
    const changed = changedLeaf(5, SIG_A);
    const input: ChangedLeafClassificationInput = {
      proposals: [{ proposal: updateProposal(), senderLeafIndex: 2 }],
      committerLeafIndex: undefined,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({
      kind: "undecidable",
    });
  });

  it("Test 7: an Add match wins even when the changed leaf's index also equals committerLeafIndex (Add checked first)", () => {
    const changed = changedLeaf(0, SIG_A);
    const input: ChangedLeafClassificationInput = {
      proposals: [{ proposal: addProposal(SIG_A), senderLeafIndex: undefined }],
      committerLeafIndex: 0,
    };
    expect(classifyChangedLeaf(changed, input)).toEqual({ kind: "add" });
  });
});
