/**
 * UPD-04 (D-09/D-10) admission tests: proves a standalone Update proposal is
 * re-checked for `0x8009` proof validity and account identity equality at
 * admission, before it is queued — mirroring
 * `standalone-add-admission.test.ts`'s five-case shape for the Update branch
 * of the same admission gate.
 *
 * Reuses the `fourPartyEpoch1Group`/`testPeeler`/`ingestAll`/`rejectionReasons`
 * construction from `standalone-add-admission.test.ts` (not exported there, so
 * copied here, exactly as that file itself copies them from
 * `commit-legality-seams.test.ts`).
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  type CiphersuiteImpl,
  contentTypes,
  createCommit,
  createProposal,
  createUpdateProposal,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  nodeTypes,
  type Proposal,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { stripLeafAccountIdentityProof } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { MemoryAuditSink } from "../../audit/index.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { CommitLegalityError, MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler, IngestResult } from "../types.js";

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

/** See `commit-legality-seams.test.ts` for the full doc comment. */
async function fourPartyEpoch1Group() {
  const adminAccount = testAccount(6);
  const admin2Account = testAccount(0);
  const admin3Account = testAccount(1);
  const memberAccount = testAccount(9);
  const adminPubkey = adminAccount.pubkey;
  const admin2Pubkey = admin2Account.pubkey;
  const admin3Pubkey = admin3Account.pubkey;
  const memberPubkey = memberAccount.pubkey;
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
    signer: adminAccount.signer,
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
    signer: admin2Account.signer,
    ciphersuiteImpl: impl,
  });
  const admin3Kp = await generateKeyPackage({
    credential: createCredential(admin3Pubkey),
    signer: admin3Account.signer,
    ciphersuiteImpl: impl,
  });
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
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

  return {
    impl,
    ctx,
    adminPubkey,
    admin2Pubkey,
    admin3Pubkey,
    memberPubkey,
    adminEpoch1,
    admin2Epoch1,
  };
}

async function ingestAll(
  engine: MarmotGroupEngine<NostrEvent>,
  envelope: NostrEvent,
): Promise<IngestResult<NostrEvent>[]> {
  const out: IngestResult<NostrEvent>[] = [];
  for await (const r of engine.ingest([envelope])) out.push(r);
  return out;
}

function rejectionReasons(sink: MemoryAuditSink): string[] {
  return sink.events.flatMap((event) =>
    event.kind.type === "rejection" ? [event.kind.reason] : [],
  );
}

describe("standalone Update admission (UPD-04, D-09/D-10)", () => {
  it("UPD-04: the engine refuses a raw Update proposal intent whose leaf carries no 0x8009 support or data, throwing before createProposal", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const [adminLeafIndex] = getPubkeyLeafNodeIndexes(adminEpoch1, adminPubkey);
    expect(adminLeafIndex).toBeDefined();
    const adminNode = adminEpoch1.ratchetTree[adminLeafIndex! * 2];
    if (adminNode?.nodeType !== nodeTypes.leaf)
      throw new Error("expected a leaf node at the admin's index");

    const strippedLeaf = stripLeafAccountIdentityProof(adminNode.leaf);
    const rawUpdate: Proposal = {
      proposalType: defaultProposalTypes.update,
      update: { leafNode: strippedLeaf },
    };

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    let caught: unknown;
    try {
      await engine.send({ kind: "proposal", proposal: rawUpdate });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommitLegalityError);
    const violation = (caught as CommitLegalityError).violation;
    expect(violation.reason).toBe("account-identity-proof");
    expect(violation.proofReason).toBe("missing-support");
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("UPD-04: the engine refuses a raw Update proposal intent whose leaf credential identity is not the local client's, with proofReason member-identity-changed", async () => {
    const { impl, adminPubkey, admin2Pubkey, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const [admin2LeafIndex] = getPubkeyLeafNodeIndexes(
      adminEpoch1,
      admin2Pubkey,
    );
    expect(admin2LeafIndex).toBeDefined();
    const admin2Node = adminEpoch1.ratchetTree[admin2LeafIndex! * 2];
    if (admin2Node?.nodeType !== nodeTypes.leaf)
      throw new Error("expected a leaf node at admin2's index");

    // The local client is `adminEpoch1`'s own leaf (adminPubkey); the local
    // propose gate always names the local client as sender. This proposal
    // instead carries admin2's genuine, validly-proofed leaf -- a fabricated
    // identity swap through a locally-built raw proposal intent.
    const rawUpdate: Proposal = {
      proposalType: defaultProposalTypes.update,
      update: { leafNode: admin2Node.leaf },
    };

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    let caught: unknown;
    try {
      await engine.send({ kind: "proposal", proposal: rawUpdate });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommitLegalityError);
    const violation = (caught as CommitLegalityError).violation;
    expect(violation.reason).toBe("account-identity-proof");
    expect(violation.proofReason).toBe("member-identity-changed");
    expect(violation.leafIndex).toBeUndefined();
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
    void adminPubkey;
  });

  it("UPD-04: an inbound standalone Update carrying an invalid leaf is rejected and never queued, surfacing reason: account-identity-proof", async () => {
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

    // Empirical finding (this task's required determination): ts-mls's wire
    // codec's `leafNodeUpdateDecoder` only recognizes an Update proposal's
    // inner LeafNode when its OWN `leafNodeSource` is "update" -- reusing a
    // member's KeyPackage-sourced leaf verbatim (fine for the LOCAL-gate
    // tests above, which never reach the wire) decodes on the receiving side
    // as an unrecognized custom proposal, never reaching this admission gate
    // at all. Build a genuine "update"-sourced leaf via `createUpdateProposal`
    // first, then strip its proof -- this keeps the wire *shape* valid while
    // making the Marmot-layer *content* invalid. Separately confirmed: ts-mls
    // does NOT validate an Update proposal's inner leaf SIGNATURE at
    // proposal-receive time either (only when a later commit applies it via
    // `applyTreeMutations`), so the stripped leaf -- now signed over content
    // it no longer carries -- still reaches the callback for this gate to
    // catch, rather than being refused earlier by ts-mls itself.
    const genuine = await createUpdateProposal({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
    });
    if (
      genuine.message.publicMessage?.content.contentType !==
      contentTypes.proposal
    )
      throw new Error("expected a proposal-framed message");
    const genuineProposal = genuine.message.publicMessage.content.proposal;
    if (
      genuineProposal.proposalType !== defaultProposalTypes.update ||
      !("update" in genuineProposal)
    )
      throw new Error("expected an Update proposal");
    const strippedLeaf = stripLeafAccountIdentityProof(
      genuineProposal.update.leafNode,
    );
    const rawUpdate: Proposal = {
      proposalType: defaultProposalTypes.update,
      update: { leafNode: strippedLeaf },
    };
    const { message } = await createProposal({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      proposal: rawUpdate,
    });
    const envelope = await peeler.wrapGroupMessage(message, admin2Epoch1);

    const results = await ingestAll(engine, envelope);

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "account-identity-proof",
        proofReason: "missing-support",
      }),
    );
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
    expect(rejectionReasons(audit)).toContain("account_identity_proof");
  });

  it("UPD-04: an honest inbound standalone Update from a current member is still staged (no false positive)", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const { message } = await createUpdateProposal({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
    });
    const envelope = await peeler.wrapGroupMessage(message, admin2Epoch1);

    const results = await ingestAll(engine, envelope);

    expect(results.some((r) => r.kind === "processed")).toBe(true);
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(1);
  });

  it("UPD-04: an honest local send({ kind: 'selfUpdate' }) still succeeds and still advances to a staged pending commit", async () => {
    const { impl, adminEpoch1 } = await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const result = await engine.send({ kind: "selfUpdate" });
    expect(result.kind).toBe("selfUpdate");
    expect(engine.lifecycle).toBe("PendingPublish");
  });
});
