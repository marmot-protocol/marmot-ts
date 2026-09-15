/**
 * GRP-04 (D-08/D-09) admission tests: proves an invalid `0x8009` Add proposal
 * is refused on every admission path before it is proposed, queued, or
 * committed — local raw proposal intent, local raw commit Add, inbound
 * standalone Add, and (D-05) inbound commit carrying a forged Add, labeled
 * identically to every other Add-proof rejection seam.
 *
 * Reuses the `fourPartyEpoch1Group`/`testPeeler` construction from
 * `commit-legality-seams.test.ts` (not exported there, so copied here) and
 * `forgeKeyPackage` from the shared Phase 8 fixtures.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  createCommit,
  createProposal,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type Proposal,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { forgeKeyPackage } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { buildAdmin1PerspectiveChain } from "../../__tests__/helpers/engine-seam-fixtures.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { MemoryAuditSink } from "../../audit/index.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { GROUP_AVATAR_URL_COMPONENT_ID } from "../../core/components/ids.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
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

describe("standalone Add admission (GRP-04, D-08/D-09)", () => {
  it("GRP-04: engine refuses a raw Add proposal intent with a forged KeyPackage before proposing", async () => {
    const { impl, adminEpoch1 } = await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);

    const missing = await forgeKeyPackage({
      account: testAccount(11),
      ciphersuiteImpl: impl,
      proof: "missing",
    });
    const engineMissing = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    const beforeEpoch = Number(engineMissing.state.groupContext.epoch);
    await expect(
      engineMissing.send({
        kind: "proposal",
        proposal: {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: missing.publicPackage },
        },
      }),
    ).rejects.toMatchObject({ name: "AccountIdentityProofError" });
    expect(Object.keys(engineMissing.state.unappliedProposals)).toHaveLength(0);
    expect(Number(engineMissing.state.groupContext.epoch)).toBe(beforeEpoch);

    const tampered = await forgeKeyPackage({
      account: testAccount(12),
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const engineTampered = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });
    await expect(
      engineTampered.send({
        kind: "proposal",
        proposal: {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: tampered.publicPackage },
        },
      }),
    ).rejects.toMatchObject({
      name: "AccountIdentityProofError",
      reason: "invalid-proof",
    });
    expect(Object.keys(engineTampered.state.unappliedProposals)).toHaveLength(
      0,
    );
  });

  it("GRP-04: engine refuses a raw Add inside a commit before createCommit", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const forged = await forgeKeyPackage({
      account: testAccount(11),
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const rawAdd: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: forged.publicPackage },
    };

    const beforeEpoch = Number(engine.state.groupContext.epoch);
    let caught: unknown;
    try {
      await engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [rawAdd],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommitLegalityError);
    const violation = (caught as CommitLegalityError).violation;
    expect(violation.reason).toBe("account-identity-proof");
    expect(violation.leafIndex).toBeUndefined();
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
    expect(engine.lifecycle).toBe("Stable");
  });

  it("GRP-04: inbound standalone Add with a forged proof is rejected, not queued", async () => {
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

    const forged = await forgeKeyPackage({
      account: testAccount(11),
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const rawAdd: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: forged.publicPackage },
    };
    const { message } = await createProposal({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      proposal: rawAdd,
    });
    const envelope = await peeler.wrapGroupMessage(message, admin2Epoch1);

    const results = await ingestAll(engine, envelope);

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "account-identity-proof",
        proofReason: "invalid-proof",
      }),
    );
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
    expect(rejectionReasons(audit)).toContain("account_identity_proof");
  });

  it("GRP-04: inbound standalone Add with a valid KeyPackage is still staged (no false positive)", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
    });

    const invitee = testAccount(11);
    const validKp = await generateKeyPackage({
      credential: createCredential(invitee.pubkey),
      signer: invitee.signer,
      ciphersuiteImpl: impl,
    });
    const rawAdd: Proposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: validKp.publicPackage },
    };
    const { message } = await createProposal({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      proposal: rawAdd,
    });
    const envelope = await peeler.wrapGroupMessage(message, admin2Epoch1);

    const results = await ingestAll(engine, envelope);

    expect(results.some((r) => r.kind === "processed")).toBe(true);
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(1);
  });

  it("D-05: inbound commit carrying a forged Add is labeled account-identity-proof", async () => {
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

    const forged = await forgeKeyPackage({
      account: testAccount(11),
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    // admin2 is an admin, so this commit passes the pre-existing
    // group-messaging.md admin gate and is rejected by the account-identity
    // proof check instead -- proving the D-05 labeling fix, not the
    // pre-existing generic admin-policy path.
    const violating = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: forged.publicPackage },
        },
      ],
    });
    const envelope = await peeler.wrapGroupMessage(
      violating.commit,
      admin2Epoch1,
    );

    const results = await ingestAll(engine, envelope);

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "account-identity-proof",
        proofReason: "invalid-proof",
      }),
    );
    expect(rejectionReasons(audit)).toContain("account_identity_proof");
  });

  it("WR-04: inbound standalone Add with a forged proof is still rejected when the group-data view is unreadable", async () => {
    const { impl, ctx, admin2Epoch1, adminEpoch1 } =
      await fourPartyEpoch1Group();
    const peeler = testPeeler(impl);

    // admin2 writes malformed bytes into the optional avatar component with
    // no Marmot gates. The 0x8009 profile is untouched, but
    // getMarmotGroupView now fails to decode and returns null — the state
    // that used to make the engine fall back to an accept-all callback.
    const corrupt = await createCommit({
      context: ctx,
      state: admin2Epoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: GROUP_AVATAR_URL_COMPONENT_ID,
            operation: "update",
            update: new Uint8Array([0xff]),
          },
        },
      ],
    });
    const [adminEpoch2] = await buildAdmin1PerspectiveChain(ctx, adminEpoch1, [
      corrupt.commit,
    ]);
    expect(getMarmotGroupView(adminEpoch2!)).toBeNull();

    const engine = new MarmotGroupEngine({
      state: adminEpoch2!,
      ciphersuite: impl,
      peeler,
    });
    expect(engine.profileSupport).toEqual({ kind: "supported" });

    const forged = await forgeKeyPackage({
      account: testAccount(11),
      ciphersuiteImpl: impl,
      proof: "tampered",
    });
    const { message } = await createProposal({
      context: ctx,
      state: corrupt.newState,
      wireAsPublicMessage: true,
      proposal: {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: forged.publicPackage },
      },
    });
    const envelope = await peeler.wrapGroupMessage(message, corrupt.newState);

    const results = await ingestAll(engine, envelope);

    expect(results).toContainEqual(
      expect.objectContaining({
        kind: "rejected",
        reason: "account-identity-proof",
        proofReason: "invalid-proof",
      }),
    );
    expect(Object.keys(engine.state.unappliedProposals)).toHaveLength(0);
  });
});
