/**
 * Tests for {@link diffChangedLeaves} (D-02): a pure structural diff over two
 * ratchet trees, used by `validateCommitAccountIdentityProofs`
 * (`../integrity.js`, plan 08-01 Task 2) to find every non-blank leaf a
 * commit must re-validate the `0x8009` proof of.
 *
 * Built with real MLS groups (core `createSimpleGroup`/`generateKeyPackage`
 * plus raw ts-mls `createCommit`/`joinGroup`), following the
 * `fourPartyEpoch1Group` pattern in
 * `src/engine/__tests__/commit-legality-seams.test.ts`.
 */
import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  nodeTypes,
  type CiphersuiteImpl,
  type LeafIndex,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { marmotAuthService } from "../../auth-service.js";
import { createCredential } from "../../credential.js";
import { getPubkeyLeafNodeIndexes } from "../../group-members.js";
import { createSimpleGroup } from "../../group.js";
import { generateKeyPackage } from "../../key-package.js";
import { diffChangedLeaves } from "../tree-diff.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

/** A 2-party group at epoch 1: admin (creator, leaf 0) + member (leaf 1). */
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
    "Tree Diff Test",
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

  return { impl, ctx, adminAccount, memberAccount, adminEpoch1, memberEpoch1 };
}

function ctxFor(impl: CiphersuiteImpl) {
  return { cipherSuite: impl, authService: marmotAuthService };
}

describe("diffChangedLeaves", () => {
  it("a proposal-less self-update by leaf 0 yields exactly one ChangedLeaf (leafIndex 0); leaf 1 is untouched, signature identical", async () => {
    const { impl, adminEpoch1, memberEpoch1, adminAccount, memberAccount } =
      await twoPartyEpoch1Group();
    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      adminAccount.pubkey,
    );
    const [memberLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      memberAccount.pubkey,
    );
    expect(adminLeafIndex).toBe(0);

    const selfUpdate = await createCommit({
      context: ctxFor(impl),
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const changed = diffChangedLeaves(
      adminEpoch1.ratchetTree,
      selfUpdate.newState.ratchetTree,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.leafIndex).toBe(adminLeafIndex);

    // Assumption A1: leaf 1 (member, untouched by this self-update) keeps a
    // byte-identical signature across the commit.
    const memberNodeIndex = memberLeafIndex! * 2;
    const parentMemberNode = adminEpoch1.ratchetTree[memberNodeIndex];
    const resultingMemberNode =
      selfUpdate.newState.ratchetTree[memberNodeIndex];
    expect(parentMemberNode?.nodeType).toBe(nodeTypes.leaf);
    expect(resultingMemberNode?.nodeType).toBe(nodeTypes.leaf);
    if (
      parentMemberNode?.nodeType === nodeTypes.leaf &&
      resultingMemberNode?.nodeType === nodeTypes.leaf
    ) {
      expect(resultingMemberNode.leaf.signature).toEqual(
        parentMemberNode.leaf.signature,
      );
    }
    void memberEpoch1;
  });

  it("a commit adding a new member yields exactly the new member's MLS leaf index", async () => {
    // An Add-only commit's proposal list is entirely Add (excluded from
    // ts-mls's `needsUpdatePath` trigger set, `clientState.ts`), so per RFC
    // 9420 the committer does not generate an update path and its own leaf
    // is untouched — only the new member's freshly-signed leaf changes. The
    // committer's own leaf DOES change (and IS caught) for a commit that
    // does generate an update path, covered by the self-update test above.
    const { impl, adminEpoch1 } = await twoPartyEpoch1Group();

    const extraAccount = testAccount(1);
    const extraKp = await generateKeyPackage({
      credential: createCredential(extraAccount.pubkey),
      signer: extraAccount.signer,
      ciphersuiteImpl: impl,
    });
    const addCommit = await createCommit({
      context: ctxFor(impl),
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: extraKp.publicPackage },
        },
      ],
    });

    const [newMemberLeafIndex] = getPubkeyLeafNodeIndexes(
      addCommit.newState,
      extraAccount.pubkey,
    );
    expect(newMemberLeafIndex).toBeDefined();

    const changed = diffChangedLeaves(
      adminEpoch1.ratchetTree,
      addCommit.newState.ratchetTree,
    );
    expect(changed.map((c) => c.leafIndex)).toEqual([newMemberLeafIndex]);
  });

  it("a commit removing leaf 1 never reports leaf 1 (blanked leaves skipped, D-02)", async () => {
    const { impl, adminEpoch1, memberAccount } = await twoPartyEpoch1Group();
    const [memberLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      memberAccount.pubkey,
    );
    expect(memberLeafIndex).toBeDefined();

    const removeCommit = await createCommit({
      context: ctxFor(impl),
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: memberLeafIndex as LeafIndex },
        },
      ],
    });

    const changed = diffChangedLeaves(
      adminEpoch1.ratchetTree,
      removeCommit.newState.ratchetTree,
    );
    expect(changed.some((c) => c.leafIndex === memberLeafIndex)).toBe(false);
    // Sanity: the removed leaf's node is really blank in the resulting tree.
    expect(
      removeCommit.newState.ratchetTree[memberLeafIndex! * 2],
    ).toBeUndefined();
  });

  it("identical parent and resulting trees yield an empty array; trees of different lengths do not throw", async () => {
    const { adminEpoch1 } = await twoPartyEpoch1Group();
    expect(
      diffChangedLeaves(adminEpoch1.ratchetTree, adminEpoch1.ratchetTree),
    ).toEqual([]);
    expect(() => diffChangedLeaves([], adminEpoch1.ratchetTree)).not.toThrow();
  });
});
