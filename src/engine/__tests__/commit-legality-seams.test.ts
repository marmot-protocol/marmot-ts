/**
 * Seam-parity tests for the WIRE-03 (component integrity) and CONV-01
 * (admin/leaf coupling) commit-legality gates wired in this plan:
 *  - the inbound commit branch (`ingest.ts`)
 *  - the candidate-edge builder (`fork-recovery.ts` `#buildBranches`/`explore()`)
 *
 * Both call the single shared adapter `validateCommitLegality`
 * (`src/core/components/integrity.ts`), so this file constructs a genuinely
 * violating — but otherwise MLS-legal and admin-authorized — commit and
 * proves both seams reject/drop it identically (the mdk#707 bug class: "a
 * guard that exists on one seam only is a documented bug").
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  type LeafIndex,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { MemoryAuditSink } from "../../audit/index.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../core/components/ids.js";
import { commitDigest } from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
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

/**
 * A 4-party group at epoch 1: admin1 (creator, engine under test), admin2 and
 * admin3 (both admins, added in the same commit admin1 authored), and a
 * non-admin member (added in that same commit). admin2/admin3 let this file
 * author admin-authorized-but-illegal commits from a genuine third party —
 * never the engine's own leaf, so none of these tests exercise the CONV-04
 * own-commit-replay path (that is a deliberately orthogonal property; see
 * `convergence-parity.test.ts`). Only the replay/parity test below advances
 * the engine's OWN commit, mirroring CONV-04's own-commit test shape exactly
 * so the violating commit lands in the fork pool as a past-epoch candidate.
 */
async function fourPartyEpoch1Group() {
  const adminPubkey = "a".repeat(64);
  const admin2Pubkey = "2".repeat(64);
  const admin3Pubkey = "3".repeat(64);
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
    {
      adminPubkeys: [admin2Pubkey, admin3Pubkey],
      relays: ["wss://relay.test"],
    },
  );

  const admin2Kp = await generateKeyPackage({
    credential: createCredential(admin2Pubkey),
    ciphersuiteImpl: impl,
  });
  const admin3Kp = await generateKeyPackage({
    credential: createCredential(admin3Pubkey),
    ciphersuiteImpl: impl,
  });
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
        add: { keyPackage: admin2Kp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: admin3Kp.publicPackage },
      },
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });

  const adminEpoch1 = add.newState;
  const admin2Epoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: admin2Kp.publicPackage,
    privateKeys: admin2Kp.privatePackage,
    ratchetTree: undefined,
  });
  const admin3Epoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: admin3Kp.publicPackage,
    privateKeys: admin3Kp.privatePackage,
    ratchetTree: undefined,
  });
  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: add.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  return {
    impl,
    ctx,
    adminPubkey,
    admin2Pubkey,
    admin3Pubkey,
    memberPubkey,
    adminEpoch1,
    admin2Epoch1,
    admin3Epoch1,
    memberEpoch1,
  };
}

/**
 * Builds a commit that removes the `admin-policy.v1` (`0x8003`) entry — a
 * required app component (per `requiredComponentIds`, derived from the
 * components seeded at group creation) — via an `AppDataUpdate` "remove"
 * proposal. `validateAppComponentIntegrity`'s Rule 2 (03-01) rejects this as
 * `component-integrity`: a required component may never be dropped, even
 * through the legitimate `AppDataUpdate` channel (only rewriting one is ever
 * allowed). A raw `group_context_extensions` proposal rewrite of the
 * dictionary is not usable here — ts-mls's own `validateAppDataUpdateProposals`
 * already refuses any `GroupContextExtensions` proposal that touches
 * `app_data_dictionary` at all once `required_capabilities` lists
 * `AppDataUpdate` (which every Marmot group does), so this is the only wire
 * shape that reaches the WIRE-03/CONV-01 gate rather than being rejected
 * earlier by ts-mls itself. The committer (`state`) must be an admin so the
 * MIP-03 admin gate (`createAdminCommitPolicyCallback`) accepts the commit
 * and lets it reach the WIRE-03/CONV-01 legality gate at all.
 */
async function buildComponentIntegrityViolation(
  ctx: {
    cipherSuite: CiphersuiteImpl;
    authService: typeof unsafeTestingAuthenticationService;
  },
  state: ClientState,
) {
  // An AppDataUpdate "remove" targeting a REQUIRED component id is the
  // sanctioned wire channel (ts-mls applies it generically, with no concept
  // of "required"/protected ids of its own — that concept is Marmot-layer,
  // enforced only by validateAppComponentIntegrity's Rule 2). It is still a
  // WIRE-03 violation: Rule 2 never permits a required component to be
  // dropped, even via a legitimate AppDataUpdate proposal (only rewriting is
  // ever allowed for a required id). This mirrors the mdk#707 bug class this
  // phase closes.
  return createCommit({
    context: ctx,
    state,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: appDataUpdateProposalType,
        appDataUpdate: {
          componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
          operation: "remove",
        },
      },
    ],
  });
}

const kinds = async (
  engine: MarmotGroupEngine<NostrEvent>,
  env: NostrEvent,
) => {
  const out: { kind: string; reason?: string }[] = [];
  for await (const r of engine.ingest([env]))
    out.push(r as { kind: string; reason?: string });
  return out;
};

function rejectionReasons(sink: MemoryAuditSink): string[] {
  return sink.events.flatMap((event) =>
    event.kind.type === "rejection" ? [event.kind.reason] : [],
  );
}

describe("commit-legality seams (WIRE-03/CONV-01) — inbound vs replay parity", () => {
  it("refuses auto-commit preparation after the group is removed", async () => {
    const { impl, adminEpoch1 } = await fourPartyEpoch1Group();
    const removedState = {
      ...adminEpoch1,
      groupActiveState: { kind: "removedFromGroup" as const },
    };
    const engine = new MarmotGroupEngine({
      state: removedState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: "a".repeat(64),
        extraProposals: [],
      }),
    ).rejects.toThrow(
      "Cannot send: this client has been removed from the group.",
    );
  });

  it("rejects an inbound commit that drops a required app component (component-integrity)", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
      audit,
      auditContext: { engineId: "test-engine" },
    });

    const violating = await buildComponentIntegrityViolation(ctx, admin2Epoch1);
    const envelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = await kinds(engine, envelope);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "rejected",
      reason: "component-integrity",
    });
    expect(rejectionReasons(audit)).toEqual(["component_integrity"]);
    // Canonical state never advanced past the violation.
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("rejects an inbound removal commit that de-leafs an admin without an admin-policy update (admin-leaf-coupling)", async () => {
    const { impl, ctx, admin2Epoch1, admin3Pubkey, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
      audit,
      auditContext: { engineId: "test-engine" },
    });

    const [admin3LeafIndex] = getPubkeyLeafNodeIndexes(
      admin2Epoch1,
      admin3Pubkey,
    );
    expect(admin3LeafIndex).toBeDefined();

    // admin2 (an admin) removes admin3 (also an admin) without touching
    // admin-policy — the carried-forward admin set still names admin3, who
    // now has no member leaf in the resulting epoch.
    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: admin3LeafIndex as LeafIndex },
        },
      ],
    });
    const envelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = await kinds(engine, envelope);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "rejected",
      reason: "admin-leaf-coupling",
    });
    expect(rejectionReasons(audit)).toEqual(["admin_leaf_coupling"]);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("still processes a benign commit and advances the epoch (no false positive)", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // admin2 (an admin) commits a proposal-less self-update — legal, and
    // touches neither the app_data_dictionary nor the admin set.
    const benign = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const envelope = await peeler.wrapGroupMessage(benign.commit, admin2Epoch1);

    const results = await kinds(engine, envelope);
    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe("processed");
    expect(results[1].kind).toBe("appliedNotifications");
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
  });

  it("labels the pre-existing admin-policy rejection with reason 'admin-policy'", async () => {
    const { impl, ctx, memberEpoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
      audit,
      auditContext: { engineId: "test-engine" },
    });

    // A non-admin committing an Add proposal is neither self-update-only nor
    // self-remove-only — the pre-existing MIP-03 admin gate rejects this
    // before the commit ever reaches the WIRE-03/CONV-01 legality gate.
    const extraKp = await generateKeyPackage({
      credential: createCredential("e".repeat(64)),
      ciphersuiteImpl: impl,
    });
    const unauthorized = await createCommit({
      context: ctx,
      state: memberEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: extraKp.publicPackage },
        },
      ],
    });
    const envelope = await peeler.wrapGroupMessage(
      unauthorized.commit,
      memberEpoch1,
    );

    const beforeTag = bytesToHex(engine.state.confirmationTag);
    const results = await kinds(engine, envelope);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "rejected",
      reason: "admin-policy",
    });
    expect(rejectionReasons(audit)).toEqual(["admin_policy"]);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(beforeTag);
  });

  it("throws a typed send error carrying the structured legality violation", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await fourPartyEpoch1Group();
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const send = engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
            operation: "remove",
          },
        },
      ],
    });

    await expect(send).rejects.toMatchObject({
      name: "CommitLegalityError",
      violation: { reason: "component-integrity" },
    } satisfies Partial<CommitLegalityError>);
  });

  it("drops the violating commit as a fork-recovery candidate edge — no branch adopted, no history-tree edge (replay parity)", async () => {
    const { impl, ctx, adminPubkey, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    // The SAME violating commit bytes the first test in this file ingests
    // directly — proves both seams reach the same verdict for identical
    // commit bytes (parity), not just the same rule implemented twice.
    const violating = await buildComponentIntegrityViolation(ctx, admin2Epoch1);
    const violatingDigest = bytesToHex(
      commitDigest(encode(mlsMessageEncoder, violating.commit)),
    );
    const violatingEnvelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    // Advance the engine past epoch 1 with its OWN commit first, so the
    // violating commit (source epoch 1) arrives as a past-epoch fork-pool
    // candidate instead of the direct next-epoch commit branch — the same
    // mechanism CONV-04's own-commit tests exercise
    // (`convergence-parity.test.ts`).
    const own = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (own.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(own.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);
    const ownTag = bytesToHex(engine.state.confirmationTag);

    const results = await kinds(engine, violatingEnvelope);

    // No branch was ever adopted: the violating commit never becomes
    // canonical, and our own already-confirmed commit is still the live tip.
    expect(results.some((r) => r.kind === "processed")).toBe(false);
    expect(results.some((r) => r.kind === "skipped")).toBe(true);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(ownTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    // No branch edge was ever created for the violating commit in the
    // engine's full-fork history tree — D-04/D-09: no grandfathering for
    // edges replayed out of persisted retained history.
    const recordedDigests = engine.history
      .tags()
      .map((tag) => engine.history.node(tag)?.edge?.commitDigest)
      .filter((d): d is Uint8Array => d !== undefined)
      .map((d) => bytesToHex(d));
    expect(recordedDigests).not.toContain(violatingDigest);
  });
});
