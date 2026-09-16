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
  type ClientState,
  createCommit,
  defaultProposalTypes,
  encode,
  mlsMessageEncoder,
  nodeTypes,
  type Proposal,
  processMessage,
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
  validateLeafAccountIdentityProof,
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
 * The tag, among `tags`, whose tree edge carries the lower commit digest — the
 * structural tiebreak `selectCanonicalBranch` applies between equal-depth,
 * witness-free tree candidates. Rows whose illegal link has a legal prefix at
 * the same depth as a rival branch (WR-02) are decided by it.
 */
function lowerTipDigestTag(
  engine: MarmotGroupEngine<NostrEvent>,
  ...tags: string[]
): string {
  const digestOf = (tag: string) =>
    bytesToHex(
      engine.history.node(tag)?.edge?.commitDigest ?? new Uint8Array(),
    );
  return [...tags].sort((a, b) =>
    digestOf(a) < digestOf(b) ? -1 : digestOf(a) > digestOf(b) ? 1 : 0,
  )[0]!;
}

/** How many fresh fixtures to try before giving up on a digest ordering. */
const ORDERING_ATTEMPTS = 32;

/**
 * Two competing tips: the engine's own one-deep branch, and `sib1 -> sib2`
 * where `sib2` is made illegal by `sib2Proposals`. `sib1` is therefore the
 * illegal branch's legal prefix, and ties the own branch at depth 1.
 */
async function twoTipFixture(
  sib2Proposals: (parent: ClientState) => Proposal[],
) {
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
    extraProposals: sib2Proposals(sib1Commit.newState),
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

  return {
    impl,
    engine,
    ownTag,
    sib1Tag,
    sib1State: sib1State!,
    sib2State: sib2State!,
    sib2Commit,
  };
}

/**
 * WR-07: {@link twoTipFixture}, rebuilt until `sib1`'s edge digest sorts BELOW
 * the own tip's.
 *
 * The structural tiebreak between two equal-depth, witness-free candidates is
 * the lower tip digest, and the fixture's digests derive from freshly
 * generated key material — so which tip wins varies per run. Asserting the
 * tiebreak outcome recomputed from those same digests made the WR-02 rows
 * pass on every run where `ownTag` happened to sort lower, because that
 * expectation coincides exactly with the PRE-fix behaviour (stay on our own
 * tip). Forcing the ordering makes the expected winner `sib1`, which the
 * pre-fix engine never adopts, so the row fails deterministically without the
 * legal-prefix candidate.
 */
async function twoTipFixtureWithLowerSibling(
  sib2Proposals: (parent: ClientState) => Proposal[],
) {
  for (let attempt = 0; attempt < ORDERING_ATTEMPTS; attempt++) {
    const fixture = await twoTipFixture(sib2Proposals);
    if (
      lowerTipDigestTag(fixture.engine, fixture.ownTag, fixture.sib1Tag) ===
      fixture.sib1Tag
    )
      return fixture;
  }
  throw new Error(
    `no fixture in ${ORDERING_ATTEMPTS} attempts put the sibling tip digest below the own tip digest`,
  );
}

/**
 * Three tips: the one-deep own branch, legal branch L (`sib1 -> legal2`), and
 * illegal branch I (`sib1 -> alt2 -> illegal3`). I is deepest so it scores
 * highest, but only its legal prefix `alt2` is adoptable — and that ties L's
 * tip `legal2` at depth 2.
 */
async function threeTipFixture() {
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

  const sib1Commit = await createCommit({
    context: ctx,
    state: admin2Epoch1,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const legal2Commit = await createCommit({
    context: ctx,
    state: snapshot(sib1Commit.newState),
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const alt2Commit = await createCommit({
    context: ctx,
    state: snapshot(sib1Commit.newState),
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
  const illegal3Commit = await createCommit({
    context: ctx,
    state: alt2Commit.newState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [dropAccountIdentityProofRequirement(alt2Commit.newState)],
  });

  const [sib1State, legal2State] = await buildAdmin1PerspectiveChain(
    ctx,
    snapshot(adminEpoch1),
    [sib1Commit.commit, legal2Commit.commit],
  );
  const [, alt2State, illegal3State] = await buildAdmin1PerspectiveChain(
    ctx,
    snapshot(adminEpoch1),
    [sib1Commit.commit, alt2Commit.commit, illegal3Commit.commit],
  );
  const sib1Tag = bytesToHex(sib1State!.confirmationTag);
  const alt2Tag = bytesToHex(alt2State!.confirmationTag);
  const legal2Tag = bytesToHex(legal2State!.confirmationTag);
  engine.history.recordEdge(
    edgeFromReplay(rootTag, sib1Commit.commit, sib1State!),
  );
  engine.history.recordEdge(
    edgeFromReplay(sib1Tag, legal2Commit.commit, legal2State!),
  );
  engine.history.recordEdge(
    edgeFromReplay(sib1Tag, alt2Commit.commit, alt2State!),
  );
  engine.history.recordEdge(
    edgeFromReplay(alt2Tag, illegal3Commit.commit, illegal3State!),
  );

  return {
    engine,
    legal2Tag,
    alt2Tag,
    illegal3State: illegal3State!,
  };
}

/**
 * WR-07: {@link threeTipFixture}, rebuilt until branch I's legal prefix
 * (`alt2`) sorts below branch L's tip (`legal2`). The expected winner is then
 * `alt2`, which the pre-fix engine never scores at all — it would adopt
 * `legal2` as the only depth-2 candidate.
 */
async function threeTipFixtureWithLowerPrefix() {
  for (let attempt = 0; attempt < ORDERING_ATTEMPTS; attempt++) {
    const fixture = await threeTipFixture();
    if (
      lowerTipDigestTag(fixture.engine, fixture.legal2Tag, fixture.alt2Tag) ===
      fixture.alt2Tag
    )
      return fixture;
  }
  throw new Error(
    `no fixture in ${ORDERING_ATTEMPTS} attempts put the legal prefix digest below the rival tip digest`,
  );
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
    // WR-01: the replay seam yields the same labeled `rejected` result as
    // the inbound seam, not `skipped`/`past-epoch`.
    const rejected = results.filter((r) => r.kind === "rejected");
    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual(expected);
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
    const { impl, engine, ownTag, sib1Tag, sib1State, sib2State, sib2Commit } =
      await twoTipFixtureWithLowerSibling((parent) => [
        dropAccountIdentityProofRequirement(parent),
      ]);
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    // The illegal sib2 link is never adopted. Its legal prefix (sib1) stays a
    // scored candidate at the own branch's depth (WR-02, matching MDK).
    // WR-07: sib1's digest is forced below the own tip's, so adopting sib1 is
    // the ONLY outcome that satisfies this row — the pre-fix engine, which
    // never scores the prefix, stays on its own tip and fails here.
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(
      bytesToHex(sib2State.confirmationTag),
    );
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(ownTag);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(sib1Tag);
    expect(engine.lifecycle).toBe("Stable");

    const sib1Snapshot = snapshot(sib1State);
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

  it("own-commit shortcut: a known recorded child still runs the legality gate (WR-03)", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } = await seamGroup();
    const rootSnapshot = snapshot(adminEpoch1);

    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [dropAccountIdentityProofRequirement(admin2Epoch1)],
    });
    // A persisted (pre-upgrade) recorded child for this commit, reached with
    // no Marmot gates at all.
    const [recordedChild] = await buildAdmin1PerspectiveChain(
      ctx,
      snapshot(adminEpoch1),
      [violating.commit],
    );

    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: rootSnapshot,
      message: violating.commit,
      callback: adminCallbackFor(rootSnapshot, impl),
      known: {
        parentTag: bytesToHex(rootSnapshot.confirmationTag),
        state: recordedChild!,
      },
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual(expected);
  });

  it("pool sweep: rejects a live second sibling commit that only decrypts on a retained fork node, records no edge (CR-01)", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await seamGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // Two own commits, so the one-deep sibling branch loses pool replay and
    // is only retained in the history tree as a fork node.
    for (let i = 0; i < 2; i++) {
      const own = await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      });
      if (own.kind !== "groupEvolution")
        throw new Error("expected groupEvolution");
      engine.confirmPublished(own.pending);
    }
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const sib1Commit = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sib1Envelope = await peeler.wrapGroupMessage(
      sib1Commit.commit,
      admin2Epoch1,
    );
    const sib2Commit = await createCommit({
      context: ctx,
      state: sib1Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        dropAccountIdentityProofRequirement(sib1Commit.newState),
      ],
    });
    // Wrapped under the sibling branch's epoch-2 exporter secret: no
    // canonical or retained state can peel it, so it is pooled and only
    // `#sweepTree` (peeling against the sib1 fork node) can reach it.
    const sib2Envelope = await peeler.wrapGroupMessage(
      sib2Commit.commit,
      sib1Commit.newState,
    );
    const digestOf = (m: typeof sib1Commit.commit) =>
      bytesToHex(commitDigest(encode(mlsMessageEncoder, m)));
    const recordedDigests = () =>
      engine.history
        .tags()
        .map((tag) => engine.history.node(tag)?.edge?.commitDigest)
        .filter((d): d is Uint8Array => d !== undefined)
        .map((d) => bytesToHex(d));

    await ingestAll(engine, sib1Envelope);
    expect(recordedDigests()).toContain(digestOf(sib1Commit.commit));
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);

    const results = await ingestAll(engine, sib2Envelope);
    const rejected = results.filter((r) => r.kind === "rejected");

    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual(expected);
    expect(recordedDigests()).not.toContain(digestOf(sib2Commit.commit));
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
  });

  it("tree-fed: falls back to the next-best legal branch when the top-scoring candidate is illegal (CR-01)", async () => {
    // Legal branch L: sib1 -> legal2 (depth 2). Illegal branch I: sib1 ->
    // alt2 -> illegal3 (depth 3, deepest, so it scores highest). Both beat
    // the one-deep own branch; only I's legal prefix and L are adoptable.
    const { engine, legal2Tag, alt2Tag, illegal3State } =
      await threeTipFixtureWithLowerPrefix();
    expect(engine.history.tips().length).toBe(3);

    await engine.reconvergeFromHistory();

    // illegal3 is never adopted, and neither is the one-deep own branch.
    // Branch I's legal prefix (alt2) ties branch L's tip (legal2) at depth 2
    // (WR-02, matching MDK). WR-07: alt2's digest is forced below legal2's, so
    // adopting alt2 is the ONLY outcome that satisfies this row — the pre-fix
    // engine, which never scores the prefix, adopts legal2 and fails here.
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(
      bytesToHex(illegal3State.confirmationTag),
    );
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(legal2Tag);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(alt2Tag);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("tree-fed: keeps the legal prefix of a branch whose later link is illegal (WR-02)", async () => {
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

    // Branch X: sib1 -> sib2 (both legal) -> sib3 (illegal). MDK drops only
    // the invalid commit; the legal prefix ending at sib2 stays a scored
    // candidate, and at depth 2 it beats the one-deep own branch.
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
      extraProposals: [],
    });
    const sib3Commit = await createCommit({
      context: ctx,
      state: sib2Commit.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        dropAccountIdentityProofRequirement(sib2Commit.newState),
      ],
    });

    const [sib1State, sib2State, sib3State] = await buildAdmin1PerspectiveChain(
      ctx,
      snapshot(adminEpoch1),
      [sib1Commit.commit, sib2Commit.commit, sib3Commit.commit],
    );
    const sib1Tag = bytesToHex(sib1State!.confirmationTag);
    const sib2Tag = bytesToHex(sib2State!.confirmationTag);
    engine.history.recordEdge(
      edgeFromReplay(rootTag, sib1Commit.commit, sib1State!),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib1Tag, sib2Commit.commit, sib2State!),
    );
    engine.history.recordEdge(
      edgeFromReplay(sib2Tag, sib3Commit.commit, sib3State!),
    );
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(ownTag);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(sib2Tag);
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
    expect(engine.lifecycle).toBe("Stable");
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
    const rejected = results.filter((r) => r.kind === "rejected");
    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual(expected);
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
    const { impl, engine, ownTag, sib1Tag, sib1State, sib2State, sib2Commit } =
      await twoTipFixtureWithLowerSibling(() => [addProposal()]);
    expect(engine.history.tips().length).toBe(2);

    await engine.reconvergeFromHistory();

    // The illegal sib2 link is never adopted. Its legal prefix (sib1) stays a
    // scored candidate at the own branch's depth (WR-02, matching MDK).
    // WR-07: sib1's digest is forced below the own tip's, so adopting sib1 is
    // the ONLY outcome that satisfies this row — the pre-fix engine, which
    // never scores the prefix, stays on its own tip and fails here.
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(
      bytesToHex(sib2State.confirmationTag),
    );
    expect(bytesToHex(engine.state.confirmationTag)).not.toBe(ownTag);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(sib1Tag);
    expect(engine.lifecycle).toBe("Stable");

    const sib1Snapshot = snapshot(sib1State);
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

describe("GRP-02 seam parity: update-path leaf with an invalid proof (D-04, D-02, D-03)", () => {
  it("fixture sanity: forgedLeafIndex is a number and the forged leaf's own proof is invalid-proof", async () => {
    const { impl, adminEpoch1, forgedLeafIndex } = await seamGroup({
      forgedMember: "tampered",
    });
    expect(typeof forgedLeafIndex).toBe("number");
    const node = adminEpoch1.ratchetTree[forgedLeafIndex! * 2];
    expect(node?.nodeType).toBe(nodeTypes.leaf);
    if (node?.nodeType !== nodeTypes.leaf)
      throw new Error("expected a leaf node at the forged member's index");
    let caughtReason: string | undefined;
    try {
      validateLeafAccountIdentityProof(node.leaf, impl.id);
    } catch (err) {
      if (err instanceof AccountIdentityProofError) caughtReason = err.reason;
    }
    expect(caughtReason).toBe("invalid-proof");
  });

  it("send: refuses with CommitLegalityError, epoch unchanged", async () => {
    const { impl, forgedEpoch1, forgedLeafIndex } = await seamGroup({
      forgedMember: "tampered",
    });
    const engine = new MarmotGroupEngine({
      state: forgedEpoch1!,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    const beforeEpoch = Number(engine.state.groupContext.epoch);

    let caught: CommitLegalityError | undefined;
    try {
      await engine.send({ kind: "selfUpdate" });
    } catch (err) {
      caught = err as CommitLegalityError;
    }

    expect(caught?.name).toBe("CommitLegalityError");
    expect(project(caught?.violation)).toEqual({
      reason: "account-identity-proof",
      proofReason: "invalid-proof",
      leafIndex: forgedLeafIndex,
    });
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("inbound: yields exactly one rejected result, epoch unchanged", async () => {
    const { impl, ctx, forgedEpoch1, adminEpoch1, forgedLeafIndex } =
      await seamGroup({ forgedMember: "tampered" });
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const forgedSelfUpdate = await createCommit({
      context: ctx,
      state: forgedEpoch1!,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const envelope = await peeler.wrapGroupMessage(
      forgedSelfUpdate.commit,
      forgedEpoch1!,
    );

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = await ingestAll(engine, envelope);
    const rejected = results.filter((r) => r.kind === "rejected");

    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual({
      reason: "account-identity-proof",
      proofReason: "invalid-proof",
      leafIndex: forgedLeafIndex,
    });
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("replay: drops the candidate edge, tip unchanged; admin1's own benign commit is unaffected by the unchanged forged leaf (D-01)", async () => {
    const {
      impl,
      ctx,
      adminPubkey,
      forgedEpoch1,
      adminEpoch1,
      forgedLeafIndex,
    } = await seamGroup({ forgedMember: "tampered" });
    const rootSnapshot = snapshot(adminEpoch1);
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // admin1's own empty commit re-signs only admin1's own leaf; the forged
    // member's leaf is untouched (byte-identical signature across the
    // commit), so per D-01 it is trusted and never re-validated -- this
    // commit must succeed even though the group already contains an invalid
    // forged leaf from the raw founding commit.
    const own = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (own.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(own.pending);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const forgedSelfUpdate = await createCommit({
      context: ctx,
      state: forgedEpoch1!,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const violatingDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, forgedSelfUpdate.commit)),
    );
    const envelope = await peeler.wrapGroupMessage(
      forgedSelfUpdate.commit,
      forgedEpoch1!,
    );

    const results = await ingestAll(engine, envelope);
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    const rejected = results.filter((r) => r.kind === "rejected");
    expect(rejected).toHaveLength(1);
    expect(project(rejected[0])).toEqual({
      reason: "account-identity-proof",
      proofReason: "invalid-proof",
      leafIndex: forgedLeafIndex,
    });
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
      message: forgedSelfUpdate.commit,
      callback: adminCallbackFor(rootSnapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual({
      reason: "account-identity-proof",
      proofReason: "invalid-proof",
      leafIndex: forgedLeafIndex,
    });
  });

  it("tree-fed: abandons the switch, tip unchanged", async () => {
    const {
      impl,
      ctx,
      adminPubkey,
      adminEpoch1,
      admin2Epoch1,
      forgedEpoch1,
      forgedLeafIndex,
    } = await seamGroup({ forgedMember: "tampered" });
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

    // sib1: the forged member's own proposal-less self-update -- the only
    // way to get an invalid proof onto an update-path leaf (Pitfall 2): it
    // carries the SAME forged proof forward, but re-signed (byte-different),
    // so D-02's tree-diff flags it as changed.
    const sib1Commit = await createCommit({
      context: ctx,
      state: forgedEpoch1!,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    // admin2 raw-processes sib1 with an accept-all callback (processMessage's
    // default when no callback is supplied) to reach the epoch sib2 commits
    // from -- admin2 is a genuinely different leaf than the forged member,
    // so this replay does not hit the RFC 9420 own-committer constraint.
    const admin2AfterSib1 = await processMessage({
      context: {
        cipherSuite: impl,
        authService: ctx.authService,
        externalPsks: {},
      },
      state: admin2Epoch1,
      message: sib1Commit.commit,
    });
    if (admin2AfterSib1.kind !== "newState")
      throw new Error("expected newState");

    const sib2Commit = await createCommit({
      context: ctx,
      state: admin2AfterSib1.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
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

    const rootSnapshot = snapshot(adminEpoch1);
    const resolution = await resolveCandidateParent({
      ciphersuite: impl,
      parent: rootSnapshot,
      message: sib1Commit.commit,
      callback: adminCallbackFor(rootSnapshot, impl),
    });
    expect(resolution.kind).toBe("rejected");
    expect(
      project(
        resolution.kind === "rejected" ? resolution.violation : undefined,
      ),
    ).toEqual({
      reason: "account-identity-proof",
      proofReason: "invalid-proof",
      leafIndex: forgedLeafIndex,
    });
  });

  it("control: a legal two-deep sibling branch on the same forged-member group does switch on tree-fed re-convergence", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, admin2Epoch1 } =
      await seamGroup({ forgedMember: "tampered" });
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

    // Same fixture group as the rows above (a forged member is present), but
    // this branch never touches the forged leaf -- proving the abandonment
    // in the rows above is caused by the proof gate, not by branch selection
    // or replay mismatch (Pitfall 3).
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
      extraProposals: [],
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

    await engine.reconvergeFromHistory();

    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(sib2State!.confirmationTag),
    );
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
  });
});
