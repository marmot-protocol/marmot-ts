/**
 * Tests for {@link classifyChangedLeaf} (Phase 9, D-01/D-02/D-03): the pure
 * three-bucket changed-leaf classifier. These are pure unit tests over
 * hand-built `ChangedLeaf` and `ProposalWithSender` values — no MLS group
 * construction and no ciphersuite are needed, since the classifier reads only
 * proposal types, sender indexes, and signature bytes.
 */
import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  nodeTypes,
  type LeafNode,
  type Proposal,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  forgeKeyPackage,
  spliceLeafAtIndex,
  stripLeafAccountIdentityProof,
} from "../../../__tests__/helpers/account-identity-proof-fixtures.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import {
  AccountIdentityProofError,
  validateLeafAccountIdentityProof,
} from "../account-identity-proof.js";
import { marmotAuthService } from "../../auth-service.js";
import { createCredential } from "../../credential.js";
import { getPubkeyLeafNodeIndexes } from "../../group-members.js";
import { createSimpleGroup } from "../../group.js";
import { generateKeyPackage } from "../../key-package.js";
import type { ChangedLeaf } from "../tree-diff.js";
import { diffChangedLeaves } from "../tree-diff.js";
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

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

/**
 * A 2-party group at epoch 1: admin (creator, leaf 0) + member (leaf 1).
 * Copied from `../__tests__/tree-diff.test.ts` (not exported) — same
 * duplication precedent `standalone-add-admission.test.ts` documents for its
 * own copy of `fourPartyEpoch1Group`.
 */
async function twoPartyEpoch1Group() {
  const adminAccount = testAccount(6);
  const memberAccount = testAccount(9);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const ctx = { cipherSuite: impl, authService: marmotAuthService };

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminAccount.pubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Leaf Replacement Fixtures Test",
    { adminPubkeys: [adminAccount.pubkey] },
  );

  const memberKp = await generateKeyPackage({
    credential: createCredential(memberAccount.pubkey),
    signer: memberAccount.signer,
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context: ctx,
    state: adminEpoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  const adminEpoch1 = add.newState;
  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  return { impl, adminAccount, memberAccount, adminEpoch1, memberEpoch1 };
}

describe("replacement-leaf fixtures (sanity)", () => {
  it('forgeKeyPackage({ proof: "stale" }): a genuinely stale proof (validly signed over a different MLS signature key) fails validateLeafAccountIdentityProof with invalid-proof', async () => {
    const { impl } = await twoPartyEpoch1Group();
    const account = testAccount(4);
    const { publicPackage } = await forgeKeyPackage({
      account,
      ciphersuiteImpl: impl,
      proof: "stale",
    });

    // Sanity: the leaf's own signature key is a well-formed key, distinct
    // per forge call (random keygen) — this is the key the stale proof is
    // NOT bound to. The bound key itself is unrecoverable from the 104-byte
    // envelope by design (D-08): it carries no MLS signature key field, so
    // "stale" and "corrupt" are cryptographically indistinguishable and both
    // correctly surface as invalid-proof, asserted below.
    expect(publicPackage.leafNode.signaturePublicKey.length).toBeGreaterThan(0);

    let caughtReason: string | undefined;
    try {
      validateLeafAccountIdentityProof(publicPackage.leafNode, impl.id);
    } catch (err) {
      if (err instanceof AccountIdentityProofError) caughtReason = err.reason;
    }
    expect(caughtReason).toBe("invalid-proof");
  });

  it("spliceLeafAtIndex: returns a new state without mutating the input, and diffChangedLeaves reports the spliced leaf as changed", async () => {
    const { adminEpoch1, memberEpoch1, adminAccount, memberAccount } =
      await twoPartyEpoch1Group();
    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      adminAccount.pubkey,
    );
    const [memberLeafIndex] = getPubkeyLeafNodeIndexes(
      memberEpoch1,
      memberAccount.pubkey,
    );
    expect(adminLeafIndex).toBeDefined();
    expect(memberLeafIndex).toBeDefined();

    const originalAdminNode = adminEpoch1.ratchetTree[adminLeafIndex! * 2];
    const memberNode = memberEpoch1.ratchetTree[memberLeafIndex! * 2];
    expect(originalAdminNode?.nodeType).toBe(nodeTypes.leaf);
    expect(memberNode?.nodeType).toBe(nodeTypes.leaf);
    if (
      originalAdminNode?.nodeType !== nodeTypes.leaf ||
      memberNode?.nodeType !== nodeTypes.leaf
    )
      throw new Error("expected leaf nodes at both indexes");

    const splicedState = spliceLeafAtIndex(
      adminEpoch1,
      adminLeafIndex!,
      memberNode.leaf,
    );

    expect(splicedState).not.toBe(adminEpoch1);
    // The input state's node at that index is unchanged (no mutation).
    expect(adminEpoch1.ratchetTree[adminLeafIndex! * 2]).toBe(
      originalAdminNode,
    );

    const changed = diffChangedLeaves(
      adminEpoch1.ratchetTree,
      splicedState.ratchetTree,
    );
    const splicedChanged = changed.find(
      (c: ChangedLeaf) => c.leafIndex === adminLeafIndex,
    );
    expect(splicedChanged).toBeDefined();
    expect(splicedChanged!.leaf.signature).not.toEqual(
      originalAdminNode.leaf.signature,
    );
  });

  it("stripLeafAccountIdentityProof: removes the app_data_dictionary extension and validateLeafAccountIdentityProof throws missing-support or missing-data", async () => {
    const { impl, adminEpoch1, adminAccount } = await twoPartyEpoch1Group();
    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      adminAccount.pubkey,
    );
    const node = adminEpoch1.ratchetTree[adminLeafIndex! * 2];
    expect(node?.nodeType).toBe(nodeTypes.leaf);
    if (node?.nodeType !== nodeTypes.leaf)
      throw new Error("expected a leaf node at the admin's index");

    const stripped = stripLeafAccountIdentityProof(node.leaf);
    expect(stripped).not.toBe(node.leaf);
    expect(stripped.extensions.length).toBeLessThan(
      node.leaf.extensions.length,
    );

    let caughtReason: string | undefined;
    try {
      validateLeafAccountIdentityProof(stripped, impl.id);
    } catch (err) {
      if (err instanceof AccountIdentityProofError) caughtReason = err.reason;
    }
    expect(["missing-support", "missing-data"]).toContain(caughtReason);
  });
});
