/**
 * Native Vitest tests for CONV-04 (D-15 verify-first, D-16 properties).
 *
 * Phase 3 explicitly forbids building a scenario-vector driver or authoring
 * new vector fixtures for this requirement (D-15) — that harness belongs to
 * Phase 4 / CONF-01. This file instead asserts the two properties D-16 names
 * directly against the live engine:
 *
 *  1. a device's own published+confirmed commit is NOT rolled back in favor
 *     of a same-epoch sibling that loses the deterministic branch-scoring
 *     comparison, and IS materialized as an ordinary convergence candidate
 *     (a real rewind, not a skip) when a sibling wins that comparison;
 *  2. dual-ordering: two engine instances built from the same pre-fork state
 *     and fed the same competing commits in opposite delivery order select
 *     the same canonical branch.
 *
 * VERIFY-FIRST VERDICT (recorded in full in 03-03-SUMMARY.md "CONV-04
 * verdict"): Assumption A1 — "marmot-ts needs no MDK-style own-commit
 * protection because `processMessage` is a pure function with no OpenMLS-style
 * reprocessing restriction" — DOES NOT HOLD for property 1. Reading confirmed
 * the *recording* path is single and authorship-blind (own commits via
 * `MarmotGroupEngine.confirmPublished` -> `#recordCommitNode`; inbound commits
 * via `IngestContext.recordCommit` -> the same `#recordCommitNode`), and
 * property 2 (dual-ordering) does hold — but the *replay* path
 * (`ForkRecovery#buildBranches`, called whenever a same-epoch sibling forces a
 * candidate rebuild) calls `processMessage(root, ownCommitMessage, callback)`
 * to reconstruct our own branch, and ts-mls throws
 * `InternalError("No overlap between provided private keys and update path")`
 * — because a commit's `UpdatePath` never encrypts a path secret to the
 * committer's own leaf (RFC 9420 — the committer already knows those secrets
 * plaintext), so a receiver whose leaf IS the committer's leaf can never find
 * a decryptable ciphertext for it. `ForkRecovery#buildBranches`'s `explore()`
 * catches that throw and silently drops the candidate (`catch { continue }`),
 * so **our own branch can never be rebuilt once any same-epoch sibling
 * arrives — the sibling always wins, regardless of the deterministic ordering
 * rule.** This is precisely the constraint MDK's `PrevalidatedOwnCommits`
 * exists to work around in OpenMLS; ts-mls turns out to share it. Per this
 * plan's Task 3 gate, building any roll-forward/stamping mechanism to fix this
 * needs a maintainer decision, not an improvisation — so no production code in
 * `src/engine/` or `src/core/` changed as part of this plan. The first test
 * below is therefore an intentionally, honestly FAILING assertion: it states
 * the spec-required property, and the failure is the verify-first finding
 * itself, not an authoring mistake.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import {
  type CommitOrderingKey,
  commitDigest,
  compareCommitOrderingKeys,
} from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

function testPeeler(ciphersuite: CiphersuiteImpl): GroupPeeler<NostrEvent> {
  return {
    async peelGroupMessages(envelopes, state) {
      const { read, unreadable } = await decryptGroupMessages(
        envelopes,
        state,
        ciphersuite,
      );
      return {
        read: read.map(({ event, message }) => ({ envelope: event, message })),
        unreadable,
      };
    },
    wrapGroupMessage(message, state) {
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
}

/** The `CommitOrderingKey` (`convergence.md` "Same-epoch races") for a commit
 * built from a state at `sourceEpoch` — the same key `sortPeeledCommits` and
 * a same-epoch branch's `tipDigest` tie-break both derive from. */
function orderingKeyOf(
  message: MlsMessage,
  sourceEpoch: number,
): CommitOrderingKey {
  return {
    sourceEpoch,
    commitDigest: commitDigest(encode(mlsMessageEncoder, message)),
  };
}

/**
 * A 3-member group at epoch 1 (admin + two members, both added in the same
 * commit): admin is a genuine third party to both competing commits the
 * dual-ordering test builds (one per member), so the *observing* engine never
 * has to replay a commit it authored itself — that self-authored-replay case
 * is exactly what the own-commit tests exercise, and conflating the two would
 * confound this property with that one.
 */
async function threeMemberEpoch1Group() {
  const adminPubkey = "a".repeat(64);
  const member1Pubkey = "d".repeat(64);
  const member2Pubkey = "e".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );
  const member1Kp = await generateKeyPackage({
    credential: createCredential(member1Pubkey),
    ciphersuiteImpl: impl,
  });
  const member2Kp = await generateKeyPackage({
    credential: createCredential(member2Pubkey),
    ciphersuiteImpl: impl,
  });
  const add = await createCommit({
    context: ctx,
    state: adminEpoch0,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: member1Kp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: member2Kp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const adminEpoch1 = add.newState;
  const member1Epoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: member1Kp.publicPackage,
    privateKeys: member1Kp.privatePackage,
    ratchetTree: undefined,
  });
  const member2Epoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: member2Kp.publicPackage,
    privateKeys: member2Kp.privatePackage,
    ratchetTree: undefined,
  });
  return { impl, ctx, adminEpoch1, member1Epoch1, member2Epoch1 };
}

/**
 * A 2-member group at epoch 1 (admin + member, member just joined): the
 * shared pre-fork parent state the own-commit tests need, so the "sibling"
 * commit is genuinely built by a different member from an independent
 * `ClientState` copy, not merely a second call against the same object.
 */
async function twoMemberEpoch1Group() {
  const adminPubkey = "a".repeat(64);
  const memberPubkey = "d".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
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
  return { impl, ctx, adminPubkey, memberPubkey, adminEpoch1, memberEpoch1 };
}

/** Builds a self-update commit from `state` (does not mutate `state` in
 * place — `createCommit` only reads it, per `ts-mls/src/createCommit.ts`),
 * so this can be called repeatedly to search for a desired digest ordering. */
async function selfUpdateCommit(
  ctx: {
    cipherSuite: CiphersuiteImpl;
    authService: typeof unsafeTestingAuthenticationService;
  },
  state: Parameters<typeof createCommit>[0]["state"],
) {
  return createCommit({
    context: ctx,
    state,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [],
  });
}

const MAX_DIGEST_SEARCH_ATTEMPTS = 25;

describe("CONV-04 convergence parity (D-16) — own-commit protection + dual-ordering", () => {
  // KNOWN FAILING (verify-first finding, see file header + 03-03-SUMMARY.md):
  // ForkRecovery#buildBranches cannot replay our own already-applied commit
  // from the retained root (ts-mls throws reprocessing a self-authored
  // UpdatePath), so this branch never gets rebuilt and the sibling wins
  // unconditionally — even though the ordering premise below (asserted
  // explicitly, before the outcome) proves our commit's digest should win.
  it("keeps a device's own published+confirmed commit as the live tip when a losing same-epoch sibling arrives", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    const ownConfirmationTag = bytesToHex(engine.state.confirmationTag);
    const ownKey = orderingKeyOf(sent.pending.commitMessage!, 1);

    // Search for a sibling commit whose ordering key LOSES against our own
    // (i.e. our commit's digest orders strictly before the sibling's — lower
    // `tipDigest` wins the same-epoch tie-break per `compareBranchScores`).
    // `createCommit` re-randomizes the path secrets on every call, so this
    // converges in a handful of attempts.
    let sibling = await selfUpdateCommit(ctx, memberEpoch1);
    let siblingKey = orderingKeyOf(sibling.commit, 1);
    let attempts = 0;
    while (
      compareCommitOrderingKeys(ownKey, siblingKey) >= 0 &&
      attempts < MAX_DIGEST_SEARCH_ATTEMPTS
    ) {
      sibling = await selfUpdateCommit(ctx, memberEpoch1);
      siblingKey = orderingKeyOf(sibling.commit, 1);
      attempts++;
    }
    // Explicit ordering premise, asserted before the outcome: our commit MUST
    // order before the sibling's, so it deterministically wins the tie-break
    // by construction, not by accident of which one happened to be applied.
    expect(compareCommitOrderingKeys(ownKey, siblingKey)).toBeLessThan(0);

    const envelope = await peeler.wrapGroupMessage(
      sibling.commit,
      memberEpoch1,
    );
    const results: { kind: string; reason?: string }[] = [];
    for await (const r of engine.ingest([envelope]))
      results.push(r as { kind: string; reason?: string });

    // The losing sibling never becomes canonical.
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(results.some((r) => r.kind === "skipped")).toBe(true);
    // Our own commit is still the live tip: same epoch, same confirmation tag.
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownConfirmationTag);
  });

  // NOTE: this test's assertions hold, but NOT for the reason the name
  // suggests — see the failing test above and the file header. Our own
  // branch is never actually rebuilt as a competing candidate (it throws and
  // is dropped inside `ForkRecovery#buildBranches`), so the sibling is
  // adopted unconditionally, independent of the digest search below. This
  // test alone is therefore necessary but not sufficient evidence for
  // materializability; read together with the failing test above, the pair
  // proves the sibling always wins, which is the actual (divergent) finding.
  it("materializes its own confirmed commit as a convergence candidate when a winning same-epoch sibling arrives", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    const ownKey = orderingKeyOf(sent.pending.commitMessage!, 1);

    // Search for a sibling commit whose ordering key WINS against our own
    // (the sibling's digest orders strictly before ours).
    let sibling = await selfUpdateCommit(ctx, memberEpoch1);
    let siblingKey = orderingKeyOf(sibling.commit, 1);
    let attempts = 0;
    while (
      compareCommitOrderingKeys(ownKey, siblingKey) <= 0 &&
      attempts < MAX_DIGEST_SEARCH_ATTEMPTS
    ) {
      sibling = await selfUpdateCommit(ctx, memberEpoch1);
      siblingKey = orderingKeyOf(sibling.commit, 1);
      attempts++;
    }
    expect(compareCommitOrderingKeys(ownKey, siblingKey)).toBeGreaterThan(0);

    const envelope = await peeler.wrapGroupMessage(
      sibling.commit,
      memberEpoch1,
    );
    const results: { kind: string; reason?: string }[] = [];
    for await (const r of engine.ingest([envelope]))
      results.push(r as { kind: string; reason?: string });

    // This is the plumbing half of criterion 5: our own already-confirmed
    // commit must be replayable as an ordinary branch candidate, so that when
    // a peer's commit wins the race the engine produces a real rewind rather
    // than skipping for lack of a replayable own-commit branch. MDK's
    // `PrevalidatedOwnCommits` exists to guarantee exactly this property in
    // OpenMLS (which cannot reprocess a locally-authored commit); ts-mls's
    // pure `processMessage` needs no such shim. Spec `convergence.md`
    // "Branch selection" lists no "prefer own commit" rule, so adopting the
    // winning sibling here is correct, spec-conformant behavior — not a bug.
    expect(
      results.some((r) => r.kind === "processed" || r.kind === "removed"),
    ).toBe(true);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(sibling.newState.confirmationTag),
    );
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("selects the same branch when two engines receive the same competing commits in opposite delivery order", async () => {
    const { impl, ctx, adminEpoch1, member1Epoch1, member2Epoch1 } =
      await threeMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const serializedRoot = serializeClientState(adminEpoch1);

    // Two independently-built competing commits, one per member, from
    // separate `ClientState` copies — never a shared, mutable object between
    // the two "sides" of the race (ts-mls zeroes consumed secrets in place on
    // the receiving side). Both observing engines below are built as `admin`
    // (a genuine third party to both commits), so this test exercises the
    // ordinary cross-member replay path only, deliberately not the
    // self-authored-replay path the own-commit tests above isolate.
    const commitA = await selfUpdateCommit(ctx, member1Epoch1);
    const commitB = await selfUpdateCommit(ctx, member2Epoch1);
    expect(bytesToHex(commitA.newState.confirmationTag)).not.toBe(
      bytesToHex(commitB.newState.confirmationTag),
    );

    const envA = await peeler.wrapGroupMessage(commitA.commit, member1Epoch1);
    const envB = await peeler.wrapGroupMessage(commitB.commit, member2Epoch1);

    const engineA = new MarmotGroupEngine({
      state: deserializeClientState(serializedRoot),
      ciphersuite: impl,
      peeler,
    });
    const engineB = new MarmotGroupEngine({
      state: deserializeClientState(serializedRoot),
      ciphersuite: impl,
      peeler,
    });

    // Opposite array order across the two engines; `sortPeeledCommits`
    // (ingest.ts) canonicalizes the order before fork-pool classification, so
    // both engines apply the same commit first and route the other into the
    // fork pool identically, regardless of the order they were handed.
    for await (const _ of engineA.ingest([envA, envB])) void _;
    for await (const _ of engineB.ingest([envB, envA])) void _;

    expect(bytesToHex(engineA.state.confirmationTag)).toBe(
      bytesToHex(engineB.state.confirmationTag),
    );
    expect(Number(engineA.state.groupContext.epoch)).toBe(
      Number(engineB.state.groupContext.epoch),
    );
    expect(Number(engineA.state.groupContext.epoch)).toBe(2);
  });
});
