/**
 * Tests for the two ported commit-legality validators (WIRE-03, CONV-01) and
 * their shared seam adapter. Fixtures are hand-built `GroupContextExtension[]`
 * arrays (via `makeAppComponentsExtension`/`componentEntry`/`appComponentsEntry`/
 * `adminPolicyEntry`) with no MLS state, except `validateCommitLegality`'s own
 * describe block, which needs minimal `ClientState`-shaped fixtures so
 * `getGroupMembers` can read `ratchetTree`.
 */
import {
  appDataUpdateProposalType,
  ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  GroupContextExtension,
  makeAppDataDictionaryExtension,
  nodeTypes,
  type CiphersuiteImpl,
  type LeafIndex,
  type Proposal,
  type ProposalAppDataUpdate,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import {
  dropAccountIdentityProofRequirement,
  forgeKeyPackage,
} from "../../../__tests__/helpers/account-identity-proof-fixtures.js";
import { marmotAuthService } from "../../auth-service.js";
import { createCredential } from "../../credential.js";
import { getPubkeyLeafNodeIndexes } from "../../group-members.js";
import { createSimpleGroup } from "../../group.js";
import { generateKeyPackage } from "../../key-package.js";
import { BinaryWriter } from "../../binary.js";
import { encodeComponentsList } from "../app-components-list.js";
import {
  validateKeyPackageAccountIdentityProof,
  validateLeafAccountIdentityProof,
} from "../account-identity-proof.js";
import {
  adminPolicyEntry,
  appComponentsEntry,
  buildAppDataDictionary,
  componentEntry,
  makeAppComponentsExtension,
} from "../dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  GROUP_MESSAGE_RETENTION_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../ids.js";
import {
  type AppDataUpdateOp,
  type CommitIntegrityViolation,
  type CommitLegalityOutcome,
  collectAppDataUpdateOps,
  validateAdminLeafCoupling,
  validateAppComponentIntegrity,
  validateAddProposalAccountIdentityProofs,
  validateCommitAccountIdentityProofs,
  validateCommitLegality,
} from "../integrity.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

/**
 * Asserts an outcome is `{ kind: "legal" }` (Phase 9 tri-state migration):
 * used wherever this suite previously asserted `violation === undefined`, so
 * a legal case asserts the positive shape rather than the absence of a
 * violation.
 */
function expectLegal(outcome: CommitLegalityOutcome): void {
  expect(outcome).toEqual({ kind: "legal" });
}

/**
 * Extracts the `CommitIntegrityViolation` from a `CommitLegalityOutcome`, for
 * every assertion in this file written against the pre-Phase-9
 * `CommitIntegrityViolation | undefined` shape. Returns `undefined` for
 * `legal`. THROWS for `undecidable` — this is the point of the helper:
 * without it, an accidental regression that turns a decidable commit
 * undecidable would silently read as "no violation" and every existing
 * assertion in this file would still pass. No migrated test in this file may
 * treat `undecidable` as legal.
 */
function violationOf(
  outcome: CommitLegalityOutcome,
): CommitIntegrityViolation | undefined {
  switch (outcome.kind) {
    case "legal":
      return undefined;
    case "violation":
      return outcome.violation;
    case "undecidable":
      throw new Error(
        `expected a decidable legality outcome (legal or violation), got undecidable: ${outcome.detail}`,
      );
  }
}

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
    "Integrity Test",
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

  return { impl, ctx, adminAccount, memberAccount, adminEpoch1: add.newState };
}

function ctxFor(impl: CiphersuiteImpl) {
  return { cipherSuite: impl, authService: marmotAuthService };
}

// Confirmed valid x-only secp256k1 pubkeys (on-curve), matching the constants
// already used elsewhere in this test suite (e.g. group-engine.test.ts).
const ADMIN_PUBKEY = "a".repeat(64);
const MEMBER_PUBKEY = "e".repeat(64);

function dict(...entries: ReturnType<typeof componentEntry>[]) {
  return [makeAppComponentsExtension(entries)] as GroupContextExtension[];
}

function updateOp(
  componentId: number,
  data: Uint8Array,
): ProposalAppDataUpdate {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "update", update: data },
  };
}

function removeOp(componentId: number): ProposalAppDataUpdate {
  return {
    proposalType: appDataUpdateProposalType,
    appDataUpdate: { componentId, operation: "remove" },
  };
}

describe("validateAppComponentIntegrity", () => {
  it("returns a violation when current has a dictionary and resulting extensions carry none", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: [],
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when a required component (GROUP_ADMIN_POLICY_COMPONENT_ID) is present before and absent after", () => {
    const current = dict(
      componentEntry(GROUP_ADMIN_POLICY_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [GROUP_ADMIN_POLICY_COMPONENT_ID],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when APP_COMPONENTS_COMPONENT_ID is dropped even though it is not listed in requiredIds", () => {
    const current = dict(appComponentsEntry([GROUP_PROFILE_COMPONENT_ID]));
    const resulting = dict();
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when an entry's bytes change and appDataUpdateOps is empty (GroupContextExtensions-only rewrite)", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when an AppDataUpdate op exists for the id but with different resulting bytes", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([3]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined when the dictionary is byte-identical before and after", () => {
    const extensions = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const violation = validateAppComponentIntegrity({
      currentExtensions: extensions,
      resultingExtensions: extensions,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns undefined when a change is backed by an AppDataUpdate op byte-equal to the resulting bytes", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([2]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns undefined when an entry is removed and backed by a Remove op, and the id is not in the protected set", () => {
    const current = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: undefined },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a violation when a protected entry is removed even though a Remove op for it is present (rule 2 runs before rule 3)", () => {
    const current = dict(
      componentEntry(GROUP_ADMIN_POLICY_COMPONENT_ID, new Uint8Array([1])),
    );
    const resulting = dict();
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_ADMIN_POLICY_COMPONENT_ID, data: undefined },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [GROUP_ADMIN_POLICY_COMPONENT_ID],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined when a brand-new component id appears and is backed by an update op", () => {
    const current: GroupContextExtension[] = [];
    const resulting = dict(
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([9])),
    );
    const ops: AppDataUpdateOp[] = [
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([9]) },
    ];
    const violation = validateAppComponentIntegrity({
      currentExtensions: current,
      resultingExtensions: resulting,
      appDataUpdateOps: ops,
      requiredIds: [],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a violation for an AppDataUpdate op (update) targeting leaf-only 0x8009 (account-identity-proof-v2.md Lifecycle)", () => {
    const violation = validateAppComponentIntegrity({
      currentExtensions: [],
      resultingExtensions: [],
      appDataUpdateOps: [
        {
          componentId: ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          data: new Uint8Array(104),
        },
      ],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
    expect(violation?.detail).toContain("0x8009");
  });

  it("returns a violation for an AppDataUpdate op (remove) targeting leaf-only 0x8009", () => {
    const violation = validateAppComponentIntegrity({
      currentExtensions: [],
      resultingExtensions: [],
      appDataUpdateOps: [
        { componentId: ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, data: undefined },
      ],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns a violation when the resulting extensions carry a 0x8009 entry with no backing op (leaf-only, mirrors MDK CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS)", () => {
    // makeAppComponentsExtension now refuses a 0x8009 data entry (dictionary.ts
    // guard, this same plan), so this fixture is built directly with ts-mls's
    // own builder to bypass it and exercise the integrity-layer guard.
    const resulting = [
      makeAppDataDictionaryExtension(
        buildAppDataDictionary([
          componentEntry(
            ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
            new Uint8Array(104),
          ),
        ]),
      ),
    ] as GroupContextExtension[];
    const violation = validateAppComponentIntegrity({
      currentExtensions: [],
      resultingExtensions: resulting,
      appDataUpdateOps: [],
      requiredIds: [],
    });
    expect(violation?.reason).toBe("component-integrity");
    expect(violation?.detail).toContain("leaf-only");
  });
});

describe("collectAppDataUpdateOps", () => {
  it("maps an update proposal to {componentId, data} and a remove proposal to {componentId, data: undefined}", () => {
    const proposals: Proposal[] = [
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      removeOp(GROUP_ADMIN_POLICY_COMPONENT_ID),
    ];
    expect(collectAppDataUpdateOps(proposals)).toEqual([
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([1]) },
      { componentId: GROUP_ADMIN_POLICY_COMPONENT_ID, data: undefined },
    ]);
  });

  it("ignores non-AppDataUpdate proposals and preserves order for two ops on the same component id", () => {
    const proposals: Proposal[] = [
      { proposalType: defaultProposalTypes.remove, remove: { removed: 2 } },
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      updateOp(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
    ];
    expect(collectAppDataUpdateOps(proposals)).toEqual([
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([1]) },
      { componentId: GROUP_PROFILE_COMPONENT_ID, data: new Uint8Array([2]) },
    ]);
  });
});

describe("validateAdminLeafCoupling", () => {
  it("returns a violation when the resulting admin-policy lists a key whose account is absent from resultingMemberAccounts", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [MEMBER_PUBKEY],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
  });

  it("returns undefined when every resulting admin key has an account in resultingMemberAccounts", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [ADMIN_PUBKEY, MEMBER_PUBKEY],
    });
    expect(violation).toBeUndefined();
  });

  it("carried-forward: resulting carries NO admin-policy entry, current does, and one current admin is absent from resultingMemberAccounts", () => {
    const current = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    const resulting: GroupContextExtension[] = [];
    const violation = validateAdminLeafCoupling({
      currentExtensions: current,
      resultingExtensions: resulting,
      resultingMemberAccounts: [MEMBER_PUBKEY],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
  });

  it("returns undefined when neither current nor resulting extensions carry an admin-policy entry", () => {
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: [],
      resultingMemberAccounts: [],
    });
    expect(violation).toBeUndefined();
  });

  it("an admin account with two leaves where only one is removed still passes (D-08 account-level survival)", () => {
    const resulting = dict(adminPolicyEntry([ADMIN_PUBKEY]));
    // resultingMemberAccounts is account-level: ADMIN_PUBKEY still appears once
    // because it survives via its other leaf, even though one of its two
    // leaves was removed by this commit.
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [ADMIN_PUBKEY],
    });
    expect(violation).toBeUndefined();
  });

  it("returns a violation (not a thrown exception) when the resulting admin-policy component does not decode", () => {
    // 3 raw bytes is not a multiple of 32 -> decodeAdminPolicyV1 throws.
    const malformed = componentEntry(
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      new BinaryWriter().opaque(new Uint8Array([1, 2, 3])).build(),
    );
    const resulting = dict(malformed);
    const violation = validateAdminLeafCoupling({
      currentExtensions: [],
      resultingExtensions: resulting,
      resultingMemberAccounts: [],
    });
    expect(violation?.reason).toBe("admin-leaf-coupling");
    expect(violation?.detail).toBe(
      "resulting admin-policy component did not decode",
    );
  });

  it("attributes a malformed carried-forward admin policy to the current epoch", () => {
    const malformed = componentEntry(
      GROUP_ADMIN_POLICY_COMPONENT_ID,
      new BinaryWriter().opaque(new Uint8Array([1, 2, 3])).build(),
    );
    const violation = validateAdminLeafCoupling({
      currentExtensions: dict(malformed),
      resultingExtensions: [],
      resultingMemberAccounts: [],
    });
    expect(violation).toEqual({
      reason: "admin-leaf-coupling",
      detail: "carried-forward admin-policy component did not decode",
    });
  });
});

describe("validateCommitAccountIdentityProofs (D-01/D-02/D-03)", () => {
  it("returns undefined for an honest Add of a core-generated KeyPackage", async () => {
    const { impl, ctx, adminEpoch1 } = await twoPartyEpoch1Group();
    const extraAccount = testAccount(1);
    const extraKp = await generateKeyPackage({
      credential: createCredential(extraAccount.pubkey),
      signer: extraAccount.signer,
      ciphersuiteImpl: impl,
    });
    const addProposal: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: extraKp.publicPackage },
    };
    const addCommit = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [addProposal],
    });

    // Phase 9 (UPD-01): the added leaf is a changed leaf too, so the Add
    // bucket needs the commit's own proposal list to classify it — matched
    // by signature bytes, not by leaf index.
    expectLegal(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: addCommit.newState,
        classification: {
          proposals: [{ proposal: addProposal, senderLeafIndex: undefined }],
          committerLeafIndex: undefined,
        },
      }),
    );
  });

  it("is legal for an honest self-update (UPD-01: the prior-leaf identity comparison runs and finds the identity unchanged)", async () => {
    const { impl, ctx, adminAccount, adminEpoch1 } =
      await twoPartyEpoch1Group();
    const selfUpdate = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      adminAccount.pubkey,
    );
    expect(adminLeafIndex).toBeDefined();

    // This is no longer "no prior-leaf identity comparison is performed"
    // (the stale D-03 rationale) — the comparison now runs against the
    // committer's own prior leaf and finds the identity unchanged, which is
    // exactly what an honest self-update is.
    expectLegal(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: selfUpdate.newState,
        classification: {
          proposals: [],
          committerLeafIndex: adminLeafIndex,
        },
      }),
    );

    // D-03: with no classification at all, the same changed leaf cannot be
    // attributed to an Add, an Update sender, or the committer, so the
    // outcome is undecidable — never silently legal.
    expect(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: selfUpdate.newState,
      }),
    ).toEqual({ kind: "undecidable", detail: expect.any(String) });
    void impl;
  });

  it("returns account-identity-proof/missing-requirement (no leafIndex) for a commit that drops the 0x8009 requirement", async () => {
    const { impl, ctx, adminEpoch1 } = await twoPartyEpoch1Group();
    const dropRequirement = dropAccountIdentityProofRequirement(adminEpoch1);
    const commit = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [dropRequirement],
    });

    // Unaffected by UPD-01 classification: the profile-drift check runs
    // before the changed-leaf loop and rejects unconditionally.
    const violation = violationOf(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: commit.newState,
      }),
    );
    expect(violation?.reason).toBe("account-identity-proof");
    expect(violation?.proofReason).toBe("missing-requirement");
    expect(violation?.leafIndex).toBeUndefined();
    void impl;
  });

  it("returns account-identity-proof/invalid-proof with the added leaf's MLS index for a tampered-proof Add", async () => {
    const { impl, ctx, adminEpoch1 } = await twoPartyEpoch1Group();
    const badAccount = testAccount(1);
    const badKp = await forgeKeyPackage({
      account: badAccount,
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const commit = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: badKp.publicPackage },
        },
      ],
    });
    const [badLeafIndex] = getPubkeyLeafNodeIndexes(
      commit.newState,
      badAccount.pubkey,
    );
    expect(badLeafIndex).toBeDefined();

    // Unaffected by UPD-01 classification: proof validity is checked before
    // classification for every changed leaf, so this rejects on the invalid
    // proof regardless of which bucket the leaf would otherwise fall into.
    const violation = violationOf(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: commit.newState,
      }),
    );
    expect(violation?.reason).toBe("account-identity-proof");
    expect(violation?.proofReason).toBe("invalid-proof");
    expect(violation?.leafIndex).toBe(badLeafIndex);
    // Diagnostics-privacy: no pubkey hex in the detail string.
    expect(violation?.detail).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("returns the same proofReason validateLeafAccountIdentityProof itself throws for a missing-proof Add", async () => {
    const { impl, ctx, adminEpoch1 } = await twoPartyEpoch1Group();
    const badAccount = testAccount(1);
    const badKp = await forgeKeyPackage({
      account: badAccount,
      ciphersuiteImpl: impl,
      proof: "missing",
    });
    const commit = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: badKp.publicPackage },
        },
      ],
    });

    let expectedReason: string | undefined;
    try {
      validateLeafAccountIdentityProof(
        badKp.publicPackage.leafNode,
        commit.newState.groupContext.cipherSuite,
      );
    } catch (err) {
      expectedReason = (err as { reason?: string }).reason;
    }
    expect(expectedReason).toBeDefined();

    // Unaffected by UPD-01 classification: same reasoning as the
    // tampered-proof case above.
    const violation = violationOf(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: commit.newState,
      }),
    );
    expect(violation?.reason).toBe("account-identity-proof");
    expect(violation?.proofReason).toBe(expectedReason);
  });

  it("returns undefined for a removal-only commit (removed leaf is blanked, never validated)", async () => {
    const { impl, ctx, adminAccount, adminEpoch1, memberAccount } =
      await twoPartyEpoch1Group();
    const [memberLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      memberAccount.pubkey,
    );
    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      adminAccount.pubkey,
    );
    const removeCommit = await createCommit({
      context: ctx,
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

    // A Remove proposal forces an update path (forward secrecy), so the
    // committer's OWN leaf is also a changed leaf here (in addition to the
    // removed leaf, which diffChangedLeaves skips as blank) — UPD-01
    // classification needs the committer's leaf index to attribute it to the
    // committer-update-path bucket rather than reporting it undecidable.
    expectLegal(
      validateCommitAccountIdentityProofs({
        parentState: adminEpoch1,
        resultingState: removeCommit.newState,
        classification: { proposals: [], committerLeafIndex: adminLeafIndex },
      }),
    );
    void impl;
  });
});

describe("validateAddProposalAccountIdentityProofs (D-08/D-09)", () => {
  it("returns undefined for a valid Add, accepting a bare Proposal", async () => {
    const { impl, adminAccount } = await twoPartyEpoch1Group();
    const goodKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const proposal: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: goodKp.publicPackage },
    };
    expect(
      validateAddProposalAccountIdentityProofs([proposal], impl.id),
    ).toBeUndefined();
  });

  it("returns undefined for a valid Add, accepting a ProposalWithSender", async () => {
    const { impl, adminAccount } = await twoPartyEpoch1Group();
    const goodKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const proposalWithSender = {
      proposal: {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: goodKp.publicPackage },
      } as Proposal,
      senderLeafIndex: 0,
    };
    expect(
      validateAddProposalAccountIdentityProofs([proposalWithSender], impl.id),
    ).toBeUndefined();
  });

  it("ignores non-Add proposals", async () => {
    const { impl } = await twoPartyEpoch1Group();
    const removeProposal: Proposal = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: 0 as LeafIndex },
    };
    expect(
      validateAddProposalAccountIdentityProofs([removeProposal], impl.id),
    ).toBeUndefined();
  });

  it("returns a violation whose proofReason matches validateKeyPackageAccountIdentityProof's own throw, and omits leafIndex", async () => {
    const { impl } = await twoPartyEpoch1Group();
    const badAccount = testAccount(1);
    const badKp = await forgeKeyPackage({
      account: badAccount,
      ciphersuiteImpl: impl,
      proof: "tampered",
    });

    let expectedReason: string | undefined;
    try {
      validateKeyPackageAccountIdentityProof(badKp.publicPackage, impl.id);
    } catch (err) {
      expectedReason = (err as { reason?: string }).reason;
    }
    expect(expectedReason).toBeDefined();

    const proposal: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: badKp.publicPackage },
    };
    const violation = validateAddProposalAccountIdentityProofs(
      [proposal],
      impl.id,
    );
    expect(violation?.reason).toBe("account-identity-proof");
    expect(violation?.proofReason).toBe(expectedReason);
    expect(violation?.leafIndex).toBeUndefined();
  });
});

describe("validateCommitLegality", () => {
  function fakeClientState(
    extensions: GroupContextExtension[],
    memberPubkeys: string[],
  ): ClientState {
    const ratchetTree = memberPubkeys.map((pk) => ({
      nodeType: nodeTypes.leaf,
      leaf: { credential: createCredential(pk) },
    }));
    return {
      groupContext: { extensions },
      ratchetTree,
    } as unknown as ClientState;
  }

  it("derives requiredIds from the PARENT state, not the resulting one (Pitfall 2 regression guard)", () => {
    // Parent: app_components only requires GROUP_PROFILE_COMPONENT_ID (plus
    // the current-profile 0x8009 requirement, so this fixture stays inside
    // the D-01a profile check added in this plan); the retention component
    // has state but is not (yet) required.
    const parentState = fakeClientState(
      dict(
        appComponentsEntry([
          GROUP_PROFILE_COMPONENT_ID,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        ]),
        componentEntry(
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
          new Uint8Array([1]),
        ),
      ),
      [ADMIN_PUBKEY],
    );

    // Resulting: this SAME commit adds retention to the required list AND
    // drops its own component entry (backed by an explicit Remove op). If
    // requiredIds were (wrongly) derived from the resulting state, retention
    // would already be "required" and rule 2 would reject this drop.
    const resultingState = fakeClientState(
      dict(
        appComponentsEntry([
          GROUP_PROFILE_COMPONENT_ID,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
        ]),
      ),
      [ADMIN_PUBKEY],
    );

    const proposals: Proposal[] = [
      updateOp(
        APP_COMPONENTS_COMPONENT_ID,
        encodeComponentsList([
          GROUP_PROFILE_COMPONENT_ID,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
          GROUP_MESSAGE_RETENTION_COMPONENT_ID,
        ]),
      ),
      removeOp(GROUP_MESSAGE_RETENTION_COMPONENT_ID),
    ];

    expectLegal(
      validateCommitLegality({
        parentState,
        resultingState,
        proposals,
      }),
    );
  });

  it("returns the integrity violation before the coupling violation when a commit violates both", () => {
    const parentState = fakeClientState(
      dict(
        adminPolicyEntry([ADMIN_PUBKEY]),
        componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
      ),
      [ADMIN_PUBKEY, MEMBER_PUBKEY],
    );

    // Resulting: profile bytes rewritten with no backing AppDataUpdate op
    // (component-integrity violation) AND the admin's leaf is gone
    // (admin-leaf-coupling violation) -- both in the same commit.
    const resultingState = fakeClientState(
      dict(
        adminPolicyEntry([ADMIN_PUBKEY]),
        componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([2])),
      ),
      [MEMBER_PUBKEY],
    );

    const violation = violationOf(
      validateCommitLegality({
        parentState,
        resultingState,
        proposals: [],
      }),
    );
    expect(violation?.reason).toBe("component-integrity");
  });

  it("returns undefined for a benign commit that changes nothing in the dictionary and removes no member", () => {
    const extensions = dict(
      appComponentsEntry([ACCOUNT_IDENTITY_PROOF_COMPONENT_ID]),
      adminPolicyEntry([ADMIN_PUBKEY]),
      componentEntry(GROUP_PROFILE_COMPONENT_ID, new Uint8Array([1])),
    );
    const parentState = fakeClientState(extensions, [
      ADMIN_PUBKEY,
      MEMBER_PUBKEY,
    ]);
    const resultingState = fakeClientState(extensions, [
      ADMIN_PUBKEY,
      MEMBER_PUBKEY,
    ]);

    expectLegal(
      validateCommitLegality({
        parentState,
        resultingState,
        proposals: [],
      }),
    );
  });

  it("returns a typed violation instead of throwing when the PARENT app_components bytes do not decode", () => {
    // A prior commit can legally land arbitrary bytes on 0x0001 (rule 3 backs
    // the change with that commit's own op; rule 2 only checks presence). From
    // the next commit onward every seam decodes those bytes — a duplicate id
    // makes `decodeComponentsList` throw. The adapter is documented
    // non-throwing (D-01/D-02): the convergence/replay seams would otherwise
    // see the throw escape the ingest generator and skip persistence.
    const duplicateIds = new BinaryWriter()
      .vector([
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
      ])
      .build();

    const parentState = fakeClientState(
      dict(componentEntry(APP_COMPONENTS_COMPONENT_ID, duplicateIds)),
      [ADMIN_PUBKEY],
    );
    const resultingState = fakeClientState(
      dict(componentEntry(APP_COMPONENTS_COMPONENT_ID, duplicateIds)),
      [ADMIN_PUBKEY],
    );

    let violation: CommitIntegrityViolation | undefined;
    expect(() => {
      violation = violationOf(
        validateCommitLegality({
          parentState,
          resultingState,
          proposals: [],
        }),
      );
    }).not.toThrow();
    expect(violation!).toEqual({
      reason: "component-integrity",
      detail: "current app_components component did not decode",
    });
  });

  it("D-07: 0x8009 data in the resulting GroupContext still reports component-integrity (Phase 7 expectations hold)", () => {
    // makeAppComponentsExtension refuses a 0x8009 data entry via its own
    // builder guard, so this fixture is built directly with ts-mls's builder
    // to bypass it and exercise the integrity-layer guard through the full
    // validateCommitLegality adapter (not just validateAppComponentIntegrity
    // in isolation).
    const parentState = fakeClientState(
      dict(appComponentsEntry([GROUP_PROFILE_COMPONENT_ID])),
      [ADMIN_PUBKEY],
    );
    const resultingExtensions = [
      makeAppDataDictionaryExtension(
        buildAppDataDictionary([
          appComponentsEntry([GROUP_PROFILE_COMPONENT_ID]),
          componentEntry(
            ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
            new Uint8Array(104),
          ),
        ]),
      ),
    ] as GroupContextExtension[];
    const resultingState = fakeClientState(resultingExtensions, [ADMIN_PUBKEY]);

    const violation = violationOf(
      validateCommitLegality({
        parentState,
        resultingState,
        proposals: [
          updateOp(
            APP_COMPONENTS_COMPONENT_ID,
            encodeComponentsList([GROUP_PROFILE_COMPONENT_ID]),
          ),
        ],
      }),
    );
    expect(violation?.reason).toBe("component-integrity");
  });

  it("D-07: reports account-identity-proof (not admin-leaf-coupling) when a commit both adds a tampered-proof member and de-leafs an admin", async () => {
    const adminAccount = testAccount(6);
    const admin2Account = testAccount(0);
    const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
    const ctx = ctxFor(impl);

    const adminKp = await generateKeyPackage({
      credential: createCredential(adminAccount.pubkey),
      signer: adminAccount.signer,
      ciphersuiteImpl: impl,
    });
    const { clientState: adminEpoch0 } = await createSimpleGroup(
      adminKp,
      impl,
      "D-07 Ordering Test",
      { adminPubkeys: [adminAccount.pubkey, admin2Account.pubkey] },
    );
    const admin2Kp = await generateKeyPackage({
      credential: createCredential(admin2Account.pubkey),
      signer: admin2Account.signer,
      ciphersuiteImpl: impl,
    });
    const addAdmin2 = await createCommit({
      context: ctx,
      state: adminEpoch0,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: admin2Kp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const adminEpoch1 = addAdmin2.newState;
    const [admin2LeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      admin2Account.pubkey,
    );
    expect(admin2LeafIndex).toBeDefined();

    const badAccount = testAccount(1);
    const badKp = await forgeKeyPackage({
      account: badAccount,
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const violatingProposals: Proposal[] = [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: badKp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.remove,
        remove: { removed: admin2LeafIndex as LeafIndex },
      },
    ];
    const violatingCommit = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: violatingProposals,
    });

    const violation = violationOf(
      validateCommitLegality({
        parentState: adminEpoch1,
        resultingState: violatingCommit.newState,
        proposals: violatingProposals,
        committerLeafIndex: 0,
      }),
    );
    expect(violation?.reason).toBe("account-identity-proof");
  });

  it("returns a violation instead of throwing when the RESULTING app_components bytes do not decode", () => {
    const duplicateIds = new BinaryWriter()
      .vector([
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
        new BinaryWriter().uint16(GROUP_PROFILE_COMPONENT_ID).build(),
      ])
      .build();

    const parentState = fakeClientState(
      dict(
        appComponentsEntry([
          GROUP_PROFILE_COMPONENT_ID,
          ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
        ]),
      ),
      [ADMIN_PUBKEY],
    );
    const resultingState = fakeClientState(
      dict(componentEntry(APP_COMPONENTS_COMPONENT_ID, duplicateIds)),
      [ADMIN_PUBKEY],
    );

    let violation: CommitIntegrityViolation | undefined;
    expect(() => {
      violation = violationOf(
        validateCommitLegality({
          parentState,
          resultingState,
          proposals: [updateOp(APP_COMPONENTS_COMPONENT_ID, duplicateIds)],
        }),
      );
    }).not.toThrow();
    expect(violation!).toEqual({
      reason: "account-identity-proof",
      detail:
        "resulting GroupContext is outside the current account identity proof profile (invalid-dictionary)",
      proofReason: "invalid-dictionary",
    });
  });
});
