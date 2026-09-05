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
 * reprocessing restriction" — DID NOT HOLD AS STATED for property 1, on first
 * run of these tests. Reading confirmed the *recording* path is single and
 * authorship-blind (own commits via `MarmotGroupEngine.confirmPublished` ->
 * `#recordCommitNode`; inbound commits via `IngestContext.recordCommit` ->
 * the same `#recordCommitNode`), and property 2 (dual-ordering) held outright
 * — but the *replay* path (`ForkRecovery#buildBranches`, exercised whenever a
 * same-epoch sibling forces a candidate rebuild) called
 * `processMessage(root, ownCommitMessage, callback)` to reconstruct our own
 * branch, and ts-mls threw
 * `InternalError("No overlap between provided private keys and update path")`
 * — a commit's `UpdatePath` never encrypts a path secret to the committer's
 * own leaf (RFC 9420 — the committer already knows those secrets plaintext),
 * so a receiver whose leaf IS the committer's leaf can never find a
 * decryptable ciphertext for it. `explore()` caught that throw and silently
 * dropped the candidate, so our own branch could never be rebuilt once any
 * same-epoch sibling arrived — the sibling won unconditionally, independent
 * of the deterministic ordering rule. This is precisely the constraint MDK's
 * `PrevalidatedOwnCommits` exists to work around in OpenMLS; ts-mls turned
 * out to share it for this one replay path (the tree-fed reconvergence path,
 * `tree-convergence.ts`'s `buildTreeBranchSet`, is unaffected — it sources
 * candidates from already-recorded structural metadata, never replays).
 *
 * The complete fix follows the structural role of MDK's
 * `crates/traits/src/message.rs::OwnCommitConvergenceStamp` and
 * `StoredMessagePayload::OwnCommitWire`: `RetainedHistoryStore.record()` keeps
 * the exact parent and resulting state for every applied link, including the
 * parent's consumed proposal-reference evidence. `ForkRecovery#resolveFork`
 * materializes those parent-bound links without calling `processMessage` for
 * a locally-authored commit, while ordinary peer/unknown commits still replay.
 *
 * CR-01 follow-up: that map was originally keyed by commit digest ALONE, so
 * the short-circuit could also fire at a same-epoch node on a COMPETING branch
 * and graft our canonical chain onto it. It now carries the parent tag the
 * commit was recorded against and is taken only at that exact node; the fourth
 * test below is the regression guard, and needs a competing branch two nodes
 * deep, which the three original scenarios never build.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  acceptAll,
  bytesToBase64,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type MlsMessage,
  mlsMessageEncoder,
  processMessage,
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
import { ForkRecovery, type RetainedView } from "../fork-recovery.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { GroupHistoryTree } from "../history-tree.js";
import { RetainedHistoryStore } from "../retained-store.js";
import type { GroupPeeler } from "../types.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

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
  it("persists confirmation-time own evidence and abandons it on publish failure", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await twoMemberEpoch1Group();
    const store = new InMemoryKeyValueStore<Uint8Array>();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    engine.history.bindStore(store);

    const failed = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (failed.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    expect(failed.pending.ownCommitStamp).toMatchObject({
      committer: adminPubkey,
      priority: "ordinary",
      consumedProposalRefs: [],
    });
    engine.publishFailed(failed.pending);
    await engine.history.flush();
    expect(engine.history.size).toBe(1);

    const confirmed = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (confirmed.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(confirmed.pending);
    await engine.history.flush();

    const gid = bytesToHex(adminEpoch1.groupContext.groupId);
    const loaded = await GroupHistoryTree.load(store, gid);
    expect(loaded).toBeDefined();
    const tipTag = bytesToHex(confirmed.pending.newState.confirmationTag);
    expect(await loaded!.ownCommitStampOf(tipTag)).toEqual(
      confirmed.pending.ownCommitStamp,
    );
    expect(await loaded!.commitBytesOf(tipTag)).toEqual(
      encode(mlsMessageEncoder, confirmed.pending.commitMessage!),
    );
  });

  it("preserves a two-link own branch whose tip consumes an exact-parent proposal reference", async () => {
    const { impl, adminEpoch1, memberEpoch1 } = await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    const store = new InMemoryKeyValueStore<Uint8Array>();
    engine.history.bindStore(store);

    const first = await engine.send({ kind: "selfUpdate" });
    engine.confirmPublished(first.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    const joiningKp = await generateKeyPackage({
      credential: createCredential("e".repeat(64)),
      ciphersuiteImpl: impl,
    });
    const proposal = await engine.send({
      kind: "proposal",
      proposal: {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: joiningKp.publicPackage },
      },
    });
    engine.confirmPublished(proposal.pending);
    const [proposalRef] = Object.keys(engine.state.unappliedProposals);
    expect(proposalRef).toBeDefined();

    const second = await engine.send({ kind: "selfUpdate" });
    expect(second.pending.ownCommitStamp?.priority).toBe("privileged");
    expect(
      second.pending.ownCommitStamp?.consumedProposalRefs.map(bytesToBase64),
    ).toEqual([proposalRef]);
    engine.confirmPublished(second.pending);
    const ownTipTag = bytesToHex(engine.state.confirmationTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
    await engine.history.flush();

    const loadedTree = await GroupHistoryTree.load(
      store,
      bytesToHex(engine.state.groupContext.groupId),
    );
    if (!loadedTree) throw new Error("expected persisted history tree");
    const path = loadedTree.path(ownTipTag);
    if (!path) throw new Error("expected persisted canonical path");
    const states = await Promise.all(
      path.map((tag) => loadedTree.stateAt(tag)),
    );
    if (states.some((state) => state === undefined))
      throw new Error("expected every persisted state");
    const retained = new RetainedHistoryStore(states[0]!);
    for (let i = 1; i < path.length; i++) {
      const commit = await loadedTree.commitMessageOf(path[i]);
      if (!commit) throw new Error("expected persisted commit");
      retained.record(
        states[i - 1]!,
        commit,
        states[i]!,
        [],
        await loadedTree.ownCommitStampOf(path[i]),
      );
    }
    const restarted = new MarmotGroupEngine({
      state: deserializeClientState(serializeClientState(engine.state)),
      ciphersuite: impl,
      peeler,
      retained,
      historyTree: loadedTree,
    });

    // MDK parity: `openmls_projection.rs::{own_commit_stamp,
    // stamp_processed_own_commit_record,already_applied_commit_prefix}` keeps
    // the exact parent-bound consumed proposal evidence needed to materialize
    // both locally confirmed links without replaying them to their author.
    const sibling = await selfUpdateCommit(
      {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      memberEpoch1,
    );
    const siblingEnvelope = await peeler.wrapGroupMessage(
      sibling.commit,
      memberEpoch1,
    );
    for await (const _ of restarted.ingest([siblingEnvelope])) void _;

    expect(Number(restarted.state.groupContext.epoch)).toBe(3);
    expect(bytesToHex(restarted.state.confirmationTag)).toBe(ownTipTag);
  });

  // This is the property that first FAILED (see file header): before the
  // `knownNextStates` fix in `fork-recovery.ts`, `ForkRecovery#buildBranches`
  // could not replay our own already-applied commit from the retained root,
  // so this branch never got rebuilt and the sibling won unconditionally —
  // even though the ordering premise below (asserted explicitly, before the
  // outcome) proves our commit's digest should win. It passes now that
  // `resolveFork` supplies the already-known resulting state for `ours`.
  it("keeps a device's own published+confirmed commit as the live tip when a losing same-epoch sibling arrives", async () => {
    // Derived from MDK
    // `cgka-engine/src/openmls_projection.rs::already_applied_commit_prefix`:
    // an already-confirmed own link remains a normal selection candidate.
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const stageOwnCommit = async () => {
      const result = await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      });
      if (result.kind !== "groupEvolution")
        throw new Error("expected groupEvolution");
      return result;
    };

    // Search for a pairing where our own commit's ordering key LOSES to
    // nothing — i.e. our digest orders strictly before the sibling's, so it
    // deterministically wins the same-epoch tie-break per `compareBranchScores`.
    //
    // BOTH sides are re-drawn per attempt (the staged own commit is rolled
    // back with `publishFailed`, which is a no-op on state under
    // publish-before-apply). Re-drawing only the sibling against a FIXED own
    // commit is not an independent trial: it asks "is our digest the minimum
    // of the whole candidate set", which fails with probability
    // 1/(attempts+1) — ~4% here, and that is exactly how often this test used
    // to fail. Re-drawing both makes each attempt independent, so the search
    // fails with probability 2^-25.
    let sent = await stageOwnCommit();
    let sibling = await selfUpdateCommit(ctx, memberEpoch1);
    for (
      let attempts = 0;
      attempts < MAX_DIGEST_SEARCH_ATTEMPTS &&
      compareCommitOrderingKeys(
        orderingKeyOf(sent.pending.commitMessage!, 1),
        orderingKeyOf(sibling.commit, 1),
      ) >= 0;
      attempts++
    ) {
      engine.publishFailed(sent.pending);
      sent = await stageOwnCommit();
      sibling = await selfUpdateCommit(ctx, memberEpoch1);
    }
    const ownKey = orderingKeyOf(sent.pending.commitMessage!, 1);
    const siblingKey = orderingKeyOf(sibling.commit, 1);
    // Explicit ordering premise, asserted before the outcome: our commit MUST
    // order before the sibling's, so it deterministically wins the tie-break
    // by construction, not by accident of which one happened to be applied.
    expect(compareCommitOrderingKeys(ownKey, siblingKey)).toBeLessThan(0);

    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    const ownConfirmationTag = bytesToHex(engine.state.confirmationTag);

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

  // NOTE: before the `knownNextStates` fix, this test's assertions held for
  // the WRONG reason — our own branch could never actually be rebuilt as a
  // competing candidate (it threw and was dropped inside
  // `ForkRecovery#buildBranches`), so the sibling was adopted unconditionally,
  // independent of the digest search below, and this test alone could not
  // distinguish "sibling wins on the merits" from "our branch never competed
  // at all". Read together with the test above (which used to fail), the
  // pair is what proved the divergence. Now that our own branch is a genuine
  // candidate, this test's pass is meaningful on its own terms too.
  it("materializes its own confirmed commit as a convergence candidate when a winning same-epoch sibling arrives", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const stageOwnCommit = async () => {
      const result = await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      });
      if (result.kind !== "groupEvolution")
        throw new Error("expected groupEvolution");
      return result;
    };

    // Search for a pairing where the sibling's ordering key WINS against our
    // own. Both sides are re-drawn per attempt for the same reason as the
    // test above (independent trials, 2^-25 instead of ~4% failure).
    let sent = await stageOwnCommit();
    let sibling = await selfUpdateCommit(ctx, memberEpoch1);
    for (
      let attempts = 0;
      attempts < MAX_DIGEST_SEARCH_ATTEMPTS &&
      compareCommitOrderingKeys(
        orderingKeyOf(sent.pending.commitMessage!, 1),
        orderingKeyOf(sibling.commit, 1),
      ) <= 0;
      attempts++
    ) {
      engine.publishFailed(sent.pending);
      sent = await stageOwnCommit();
      sibling = await selfUpdateCommit(ctx, memberEpoch1);
    }
    const ownKey = orderingKeyOf(sent.pending.commitMessage!, 1);
    const siblingKey = orderingKeyOf(sibling.commit, 1);
    expect(compareCommitOrderingKeys(ownKey, siblingKey)).toBeGreaterThan(0);

    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

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

  /**
   * CR-01 regression. The CONV-04 short-circuit must stay, but it must be
   * qualified by the PARENT the commit was recorded against.
   *
   * `candidatesAt(state)` admits any pooled message whose framed epoch equals
   * the DFS node's epoch and never checks parentage, and `ours` is prepended to
   * the pool (`[...ours, ...pool]`). So with a digest-only `knownNextStates`
   * key, a DFS node on a COMPETING branch that happens to sit at epoch F+1
   * finds our own canonical commit@F+1 among its candidates, takes the
   * short-circuit, and adopts our canonical epoch-F+2 state as its own child —
   * a `ChainLink`/`EdgeSnapshot` for a parent→child transition that never
   * happened. That grafts our chain's depth and tip digest onto the losing
   * branch (depth is `selectCanonicalBranch`'s primary key) and, on a win,
   * feeds `RetainedHistoryStore.record` a parent that never produced that
   * child.
   *
   * Reaching it needs a competing branch ≥2 nodes above the fork root, which
   * the depth-1 scenarios above never build. This drives `ForkRecovery`
   * directly so the emitted `edges` — the artifact that carries the bogus
   * parentage — can be asserted on.
   */
  it("does not graft our own canonical commit onto a competing same-epoch fork node (CR-01)", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const peeler = testPeeler(impl);

    // Our own canonical chain, two commits deep: epoch 1 -> 2 -> 3. These are
    // the admin's own `createCommit` results, exactly what
    // `RetainedHistoryStore` holds after `confirmPublished` -> `#recordCommitNode`.
    const ourC1 = await selfUpdateCommit(ctx, adminEpoch1);
    const ourC2 = await selfUpdateCommit(ctx, ourC1.newState);
    const rootState = adminEpoch1;
    const s2 = ourC1.newState;
    const s3 = ourC2.newState;

    // A peer's competing commit at the SAME fork epoch (1), authored from an
    // independent ClientState so it is genuinely replayable from our side.
    const sibling = await selfUpdateCommit(ctx, memberEpoch1);

    // The competing node the DFS reaches by replaying `sibling` from the fork
    // root — this is the node at epoch 2 that must NOT adopt ourC2's child.
    const forkBReplay = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
        externalPsks: {},
      },
      state: deserializeClientState(serializeClientState(rootState)),
      message: sibling.commit,
    });
    if (forkBReplay.kind !== "newState")
      throw new Error("expected the sibling commit to replay to a newState");
    const forkBTag = bytesToHex(forkBReplay.newState.confirmationTag);
    expect(Number(forkBReplay.newState.groupContext.epoch)).toBe(2);
    expect(forkBTag).not.toBe(bytesToHex(s2.confirmationTag));

    const statesByEpoch = new Map<number, ClientState>([
      [1, rootState],
      [2, s2],
      [3, s3],
    ]);
    const retained: RetainedView = {
      stateAt: (epoch) => statesByEpoch.get(epoch),
      appliedCommitsBetween: () => [ourC1.commit, ourC2.commit],
      appliedLinksBetween: () => [
        {
          parentState: rootState,
          message: ourC1.commit,
          resultingState: s2,
          ownCommitStamp: {
            committer: adminPubkey,
            priority: "ordinary",
            consumedProposalRefs: [],
          },
        },
        {
          parentState: s2,
          message: ourC2.commit,
          resultingState: s3,
          ownCommitStamp: {
            committer: adminPubkey,
            priority: "ordinary",
            consumedProposalRefs: [],
          },
        },
      ],
    };

    const recovery = new ForkRecovery(impl, peeler);
    const resolution = await recovery.resolveFork({
      forkEpoch: 1,
      pool: [sibling.commit],
      currentState: s3,
      retained,
      adminCallback: acceptAll,
    });

    expect(resolution.outcome).not.toBe("skip");
    const edges = resolution.outcome === "skip" ? [] : resolution.edges;

    const digestHex = (message: MlsMessage) =>
      bytesToHex(commitDigest(encode(mlsMessageEncoder, message)));
    const rootTag = bytesToHex(rootState.confirmationTag);

    // CONV-04 still holds: our own two commits are replayed off their real
    // parents via the short-circuit, so our branch is a genuine candidate.
    expect(
      edges.some(
        (e) =>
          e.parentTag === rootTag &&
          digestHex(ourC1.commit) === bytesToHex(e.commitDigest),
      ),
    ).toBe(true);
    expect(
      edges.some(
        (e) =>
          e.parentTag === bytesToHex(s2.confirmationTag) &&
          digestHex(ourC2.commit) === bytesToHex(e.commitDigest),
      ),
    ).toBe(true);

    // CR-01: no edge claims the competing fork node as ourC2's parent.
    expect(
      edges.filter(
        (e) =>
          e.parentTag === forkBTag &&
          digestHex(ourC2.commit) === bytesToHex(e.commitDigest),
      ),
    ).toEqual([]);
    // ...and nothing at all hangs off the competing node claiming our
    // canonical epoch-3 state as its child.
    expect(
      edges.filter(
        (e) =>
          e.parentTag === forkBTag &&
          e.childTag === bytesToHex(s3.confirmationTag),
      ),
    ).toEqual([]);
  });

  it("selects the same branch when two engines receive the same competing commits in opposite delivery order", async () => {
    // Derived from MDK `cgka-engine/src/fork_recovery.rs` canonical selection:
    // candidate arrival order cannot affect the selected confirmation tag.
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
