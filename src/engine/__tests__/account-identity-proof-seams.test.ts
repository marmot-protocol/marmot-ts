/**
 * GRP-02 (D-04) targeted seam-parity matrix: proves the three D-04 invalid
 * inputs are refused with the IDENTICAL projected structured violation
 * (`reason: "account-identity-proof"` plus `proofReason`, and `leafIndex`
 * where the refusal is post-apply) on every legality seam -- send, inbound
 * ingest, fork-recovery/pool replay, and tree-fed convergence -- each with its
 * own fixed disposition (throw / `rejected` / drop-edge / abandon-switch).
 *
 * Modeled on `commit-legality-seams.test.ts` and `send-commit-legality.test.ts`
 * (WIRE-03/CONV-01 seam parity); this file is the GRP-02 acceptance gate and
 * the phase's primary defense against the mdk#707 seam-asymmetry defect
 * class. "Rejected somewhere" is not enough -- every seam must report the
 * same verdict.
 *
 * @see .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-04-PLAN.md
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createCommit,
  defaultProposalTypes,
  encode,
  mlsMessageEncoder,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  dropAccountIdentityProofRequirement,
  forgeKeyPackage,
} from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import {
  buildAdmin1PerspectiveChain,
  edgeFromReplay,
  seamGroup,
  snapshot,
  testPeeler,
} from "../../__tests__/helpers/engine-seam-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import {
  AccountIdentityProofError,
  validateKeyPackageAccountIdentityProof,
} from "../../core/components/account-identity-proof.js";
import { commitDigest } from "../../core/convergence.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
import { resolveCandidateParent } from "../fork-recovery.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
import type { IngestResult } from "../types.js";

/** The projected shape every seam's verdict is reduced to before comparison. */
type Verdict = {
  reason?: string;
  proofReason?: string;
  leafIndex?: number;
};

/**
 * Projects a raw violation/result object down to `{ reason, proofReason,
 * leafIndex }`, dropping `detail` -- pre-apply and post-apply wording
 * legitimately differs, but the protocol-visible verdict must not.
 */
function project(
  v:
    | { reason?: string; proofReason?: string; leafIndex?: number }
    | undefined
    | null,
): Verdict {
  return {
    reason: v?.reason,
    proofReason: v?.proofReason,
    leafIndex: v?.leafIndex,
  };
}

/**
 * Builds the same `IncomingMessageCallback` the engine itself would build for
 * `parent` -- the admin callback `resolveCandidateParent` is fed, keyed off
 * `parent`'s own ratchet tree and admin set.
 */
function adminCallbackFor(
  parent: Parameters<typeof snapshot>[0],
  impl: { id: number },
) {
  const view = getMarmotGroupView(parent);
  if (!view)
    throw new Error("expected a Marmot group view on the parent state");
  return createAdminCommitPolicyCallback({
    ratchetTree: parent.ratchetTree,
    adminPubkeys: view.adminPubkeys,
    ciphersuiteId: impl.id,
    onUnverifiableCommit: "retry",
  });
}

async function ingestAll(
  engine: MarmotGroupEngine<NostrEvent>,
  envelope: NostrEvent,
): Promise<IngestResult<NostrEvent>[]> {
  const out: IngestResult<NostrEvent>[] = [];
  for await (const r of engine.ingest([envelope])) out.push(r);
  return out;
}

describe("GRP-02 seam parity: commit that drops the 0x8009 requirement (D-04)", () => {
  const expected: Verdict = {
    reason: "account-identity-proof",
    proofReason: "missing-requirement",
    leafIndex: undefined,
  };

  it("send: refuses with CommitLegalityError, epoch unchanged", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await seamGroup();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const beforeEpoch = Number(engine.state.groupContext.epoch);

    let caught: CommitLegalityError | undefined;
    try {
      await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [dropAccountIdentityProofRequirement(engine.state)],
      });
    } catch (err) {
      caught = err as CommitLegalityError;
    }

    expect(caught?.name).toBe("CommitLegalityError");
    expect(project(caught?.violation)).toEqual(expected);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("inbound: yields exactly one rejected result, epoch unchanged", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } = await seamGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [dropAccountIdentityProofRequirement(admin2Epoch1)],
    });
    const envelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = await ingestAll(engine, envelope);
    const rejected = results.filter((r) => r.kind === "rejected");

    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual(expected);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("replay: drops the candidate edge, tip unchanged", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await seamGroup();
    const rootSnapshot = snapshot(adminEpoch1);
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [dropAccountIdentityProofRequirement(admin2Epoch1)],
    });
    const violatingDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, violating.commit)),
    );
    const violatingEnvelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    const own = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (own.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(own.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const results = await ingestAll(engine, violatingEnvelope);
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);

    const recordedDigests = engine.history
      .tags()
      .map((tag) => engine.history.node(tag)?.edge?.commitDigest)
      .filter((d): d is Uint8Array => d !== undefined)
      .map((d) => bytesToHex(d));
    expect(recordedDigests).not.toContain(violatingDigest);

    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: rootSnapshot,
      message: violating.commit,
      callback: adminCallbackFor(rootSnapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual(expected);
  });

  it("tree-fed: abandons the switch, tip unchanged", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await seamGroup();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const sib1Commit = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sib2Commit = await createCommit({
      context: ctx,
      state: sib1Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        dropAccountIdentityProofRequirement(sib1Commit.newState),
      ],
    });

    const [sib1State, sib2State] = await buildAdmin1PerspectiveChain(
      ctx,
      snapshot(adminEpoch1),
      [sib1Commit.commit, sib2Commit.commit],
    );
    const sib1Tag = bytesToHex(sib1State!.confirmationTag);
    engine.history.recordEdge(
      edgeFromReplay(rootTag, sib1Commit.commit, sib1State!),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib1Tag, sib2Commit.commit, sib2State!),
    );
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
    expect(engine.lifecycle).toBe("Stable");

    const sib1Snapshot = snapshot(sib1State!);
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: sib1Snapshot,
      message: sib2Commit.commit,
      callback: adminCallbackFor(sib1Snapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual(expected);
  });
});

describe("GRP-02 seam parity: Add whose leaf has no proof (D-04, D-08)", () => {
  // Built once: a shared reference ciphersuite implementation and the
  // forged, proof-less KeyPackage every seam below tries to Add. The
  // expected proofReason is computed from the validator itself (not
  // hardcoded) so this describe block tracks the validator's own source of
  // truth rather than assuming which check fires first.
  let forged: Awaited<ReturnType<typeof forgeKeyPackage>>;
  let expected: Verdict;

  beforeAll(async () => {
    const { impl: referenceImpl } = await seamGroup();
    forged = await forgeKeyPackage({
      account: testAccount(3),
      ciphersuiteImpl: referenceImpl,
      proof: "missing",
    });
    let expectedProofReason: string | undefined;
    try {
      validateKeyPackageAccountIdentityProof(
        forged.publicPackage,
        referenceImpl.id,
      );
    } catch (err) {
      if (err instanceof AccountIdentityProofError)
        expectedProofReason = err.reason;
    }
    expect(expectedProofReason).toBeDefined();
    expected = {
      reason: "account-identity-proof",
      proofReason: expectedProofReason,
      leafIndex: undefined,
    };
  });

  const addProposal = () => ({
    proposalType: defaultProposalTypes.add,
    add: { keyPackage: forged.publicPackage },
  });

  it("send: refuses with CommitLegalityError", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await seamGroup();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    let caught: CommitLegalityError | undefined;
    try {
      await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [addProposal()],
      });
    } catch (err) {
      caught = err as CommitLegalityError;
    }
    expect(caught?.name).toBe("CommitLegalityError");
    expect(project(caught?.violation)).toEqual(expected);
  });

  it("inbound: yields exactly one rejected result", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } = await seamGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [addProposal()],
    });
    const envelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );
    const results = await ingestAll(engine, envelope);
    const rejected = results.filter((r) => r.kind === "rejected");
    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual(expected);
  });

  it("replay: drops the candidate edge, tip unchanged", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await seamGroup();
    const rootSnapshot = snapshot(adminEpoch1);
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [addProposal()],
    });
    const violatingEnvelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );
    const own = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (own.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(own.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const results = await ingestAll(engine, violatingEnvelope);
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);

    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: rootSnapshot,
      message: violating.commit,
      callback: adminCallbackFor(rootSnapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual(expected);
  });

  it("tree-fed: abandons the switch, tip unchanged", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await seamGroup();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const rootTag = bytesToHex(adminEpoch1.confirmationTag);

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const sib1Commit = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sib2Commit = await createCommit({
      context: ctx,
      state: sib1Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [addProposal()],
    });

    const [sib1State, sib2State] = await buildAdmin1PerspectiveChain(
      ctx,
      snapshot(adminEpoch1),
      [sib1Commit.commit, sib2Commit.commit],
    );
    const sib1Tag = bytesToHex(sib1State!.confirmationTag);
    engine.history.recordEdge(
      edgeFromReplay(rootTag, sib1Commit.commit, sib1State!),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib1Tag, sib2Commit.commit, sib2State!),
    );
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
    expect(engine.lifecycle).toBe("Stable");

    const sib1Snapshot = snapshot(sib1State!);
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: sib1Snapshot,
      message: sib2Commit.commit,
      callback: adminCallbackFor(sib1Snapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual(expected);
  });
});
