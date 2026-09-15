/**
 * D-11: a group whose canonical GroupContext no longer classifies as the
 * current account-identity-proof profile (legacy, mixed, or missing the
 * `0x8009` requirement) refuses ALL traffic — every outbound send intent
 * kind, and every inbound envelope including application messages — before
 * any audit `send_entry` emit, peel, or decrypt. This supersedes Phase 7
 * D-10 ("load untouched"): commit legality already rejects every commit for
 * such a group (08-01 D-01a), but application messages and proposals would
 * otherwise still flow.
 *
 * @see refs/marmot/app-components/account-identity-proof-v2.md "Migration from v1"
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  type CiphersuiteImpl,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { dropAccountIdentityProofRequirement } from "../../__tests__/helpers/account-identity-proof-fixtures.js";
import { MemoryAuditSink } from "../../audit/index.js";
import { marmotAuthService } from "../../core/auth-service.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import {
  MarmotGroupEngine,
  UnsupportedGroupProfileError,
} from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

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
 * A two-party group at epoch 1 (admin + member), then a second commit that
 * drops the `0x8009` requirement (D-11's "missing-requirement" case) — the
 * same forged fixture 08-01/08-03 share for the "neither" profile.
 */
async function unsupportedProfileGroup() {
  const adminAccount = testAccount(6);
  const memberAccount = testAccount(9);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const ctx = { cipherSuite: impl, authService: marmotAuthService };
  const adminPubkey = adminAccount.pubkey;

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: adminEpoch0 } = await createSimpleGroup(
    adminKp,
    impl,
    "Unsupported Profile Test",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
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

  const dropRequirement = dropAccountIdentityProofRequirement(adminEpoch1);
  const dropped = await createCommit({
    context: ctx,
    state: adminEpoch1,
    wireAsPublicMessage: false,
    extraProposals: [dropRequirement],
    ratchetTreeExtension: true,
  });
  const neitherState = dropped.newState;

  return { impl, ctx, adminAccount, adminPubkey, neitherState };
}

async function supportedGroup() {
  const adminAccount = testAccount(6);
  const impl = await getCiphersuiteImpl(SUITE, defaultCryptoProvider);
  const adminPubkey = adminAccount.pubkey;

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    signer: adminAccount.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "Supported Profile Test",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );

  return { impl, adminAccount, adminPubkey, state: clientState };
}

function sendEntryCount(sink: MemoryAuditSink): number {
  return sink.events.filter((event) => event.kind.type === "send_entry").length;
}

describe("unsupported-profile gates (D-11)", () => {
  it("classifies profileSupport as unsupported/missing-requirement for a 'neither' state, and supported for a current-profile state", async () => {
    const { impl, neitherState } = await unsupportedProfileGroup();
    const unsupportedEngine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });
    expect(unsupportedEngine.profileSupport).toEqual({
      kind: "unsupported",
      proofReason: "missing-requirement",
    });

    const { impl: supportedImpl, state } = await supportedGroup();
    const supportedEngine = new MarmotGroupEngine({
      state,
      ciphersuite: supportedImpl,
      peeler: testPeeler(supportedImpl),
    });
    expect(supportedEngine.profileSupport).toEqual({ kind: "supported" });
  });

  it("refuses an applicationMessage send with UnsupportedGroupProfileError and records no send_entry audit event", async () => {
    const { impl, adminPubkey, neitherState } = await unsupportedProfileGroup();
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
      audit,
      auditContext: { engineId: "test-engine" },
    });
    const beforeTag = engine.state.confirmationTag;
    const beforeEpoch = Number(engine.state.groupContext.epoch);

    await expect(
      engine.send({
        kind: "applicationMessage",
        payload: new TextEncoder().encode("hi"),
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedGroupProfileError",
      reason: "unsupported-profile",
      proofReason: "missing-requirement",
    } satisfies Partial<UnsupportedGroupProfileError>);

    expect(sendEntryCount(audit)).toBe(0);
    expect(engine.state.confirmationTag).toEqual(beforeTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
    void adminPubkey;
  });

  it("refuses a proposal send with UnsupportedGroupProfileError and records no send_entry audit event", async () => {
    const { impl, neitherState } = await unsupportedProfileGroup();
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
      audit,
      auditContext: { engineId: "test-engine" },
    });

    await expect(
      engine.send({
        kind: "proposal",
        proposal: dropAccountIdentityProofRequirement(neitherState),
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedGroupProfileError",
      reason: "unsupported-profile",
      proofReason: "missing-requirement",
    } satisfies Partial<UnsupportedGroupProfileError>);
    expect(sendEntryCount(audit)).toBe(0);
  });

  it("refuses a commit send with UnsupportedGroupProfileError and records no send_entry audit event", async () => {
    const { impl, adminPubkey, neitherState } = await unsupportedProfileGroup();
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
      audit,
      auditContext: { engineId: "test-engine" },
    });

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedGroupProfileError",
      reason: "unsupported-profile",
      proofReason: "missing-requirement",
    } satisfies Partial<UnsupportedGroupProfileError>);
    expect(sendEntryCount(audit)).toBe(0);
  });

  it("refuses a selfUpdate send with UnsupportedGroupProfileError and records no send_entry audit event", async () => {
    const { impl, neitherState } = await unsupportedProfileGroup();
    const audit = new MemoryAuditSink();
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
      audit,
      auditContext: { engineId: "test-engine" },
    });

    await expect(engine.send({ kind: "selfUpdate" })).rejects.toMatchObject({
      name: "UnsupportedGroupProfileError",
      reason: "unsupported-profile",
      proofReason: "missing-requirement",
    } satisfies Partial<UnsupportedGroupProfileError>);
    expect(sendEntryCount(audit)).toBe(0);
  });

  it("skips an inbound application-message envelope pre-peel as unsupported-profile, with no message field and unchanged state", async () => {
    const { impl, adminAccount, neitherState } =
      await unsupportedProfileGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler,
    });

    // Build the envelope against a serialized/deserialized COPY of the same
    // state, so mutating its secretTree while producing the message never
    // touches the engine's own live state object.
    const senderState = deserializeClientState(
      serializeClientState(neitherState),
    );
    const { message } = await createApplicationMessage({
      context: { cipherSuite: impl, authService: marmotAuthService },
      state: senderState,
      message: new TextEncoder().encode("hello"),
    });
    const envelope = await peeler.wrapGroupMessage(message, senderState);

    const beforeTag = engine.state.confirmationTag;
    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = [];
    for await (const r of engine.ingest([envelope])) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "skipped",
      envelope,
      reason: "unsupported-profile",
      disposition: { kind: "stale", category: "unsupported_required_feature" },
    });
    expect((results[0] as { message?: unknown }).message).toBeUndefined();
    expect(engine.state.confirmationTag).toEqual(beforeTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
    void adminAccount;
  });

  it("skips an inbound commit envelope pre-peel as unsupported-profile, with no message field and unchanged state", async () => {
    const { impl, ctx, neitherState } = await unsupportedProfileGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: neitherState,
      ciphersuite: impl,
      peeler,
    });

    const benign = await createCommit({
      context: ctx,
      state: neitherState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const envelope = await peeler.wrapGroupMessage(benign.commit, neitherState);

    const beforeTag = engine.state.confirmationTag;
    const beforeEpoch = Number(engine.state.groupContext.epoch);
    const results = [];
    for await (const r of engine.ingest([envelope])) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "skipped",
      envelope,
      reason: "unsupported-profile",
      disposition: { kind: "stale", category: "unsupported_required_feature" },
    });
    expect((results[0] as { message?: unknown }).message).toBeUndefined();
    expect(engine.state.confirmationTag).toEqual(beforeTag);
    expect(Number(engine.state.groupContext.epoch)).toBe(beforeEpoch);
  });

  it("control: a supported-profile engine still sends an application message and ingests normally", async () => {
    const { impl, state } = await supportedGroup();
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state,
      ciphersuite: impl,
      peeler,
    });

    const result = await engine.send({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hi"),
    });
    expect(result.kind).toBe("applicationMessage");
  });
});
