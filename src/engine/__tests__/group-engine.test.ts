import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type AccountIdentityProofRequest,
  makeAccountIdentityProofExtension,
  mlsSignatureScheme,
  signAccountIdentityProof,
} from "../../core/account-identity-proof.js";
import { createChatRumor } from "../../client/group/application-message.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
  serializeApplicationRumor,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { RetainedHistoryStore } from "../retained-store.js";
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

async function createTestGroupState(
  adminPubkey: string,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const credential = createCredential(adminPubkey);
  const kp = await generateKeyPackage({ credential, ciphersuiteImpl });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuiteImpl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: [] },
  );
  return { clientState, kp };
}

describe("MarmotGroupEngine lifecycle (group-state.md)", () => {
  it("starts Stable, confirmPublished advances epoch, publishFailed resets to Stable", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://relay.test"],
    });

    const engine = new MarmotGroupEngine({
      state: clientState,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    expect(engine.lifecycle).toBe("Stable");

    const failed = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    expect(failed.kind).toBe("groupEvolution");
    if (failed.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    expect(engine.lifecycle).toBe("PendingPublish");
    engine.publishFailed(failed.pending);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch,
    );

    const ok = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    expect(ok.kind).toBe("groupEvolution");
    if (ok.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    expect(engine.lifecycle).toBe("PendingPublish");
    engine.confirmPublished(ok.pending);
    expect(engine.lifecycle).toBe("Stable");
    expect(engine.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch + 1n,
    );
  });
});

describe("MarmotGroupEngine ingest – own-echo dedup", () => {
  it("classifies an own application-message echo as self-echo via content dedup, without retrying", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://relay.test"],
    });

    // Wrap the peeler to count decrypt passes over the ingest batch.
    const base = testPeeler(impl);
    let peelCalls = 0;
    const peeler: GroupPeeler<NostrEvent> = {
      peelGroupMessages(envelopes, state) {
        peelCalls++;
        return base.peelGroupMessages(envelopes, state);
      },
      wrapGroupMessage: (message, state) =>
        base.wrapGroupMessage(message, state),
      idOf: (envelope) => base.idOf(envelope),
    };

    const engine = new MarmotGroupEngine({
      state: clientState,
      ciphersuite: impl,
      peeler,
    });

    // A relay replays our own send back to us (e.g. on restart). The outer
    // kind-445 envelope still decrypts (the exporter key is per-epoch and a send
    // does not advance the epoch), so the message peels — but its content id was
    // recorded on send, so content dedup recognizes it as our own echo before any
    // MLS processing and skips it as self-echo, never queuing it for retry.
    const sent = await engine.send({
      kind: "applicationMessage",
      payload: new TextEncoder().encode("hello"),
    });
    if (sent.kind !== "applicationMessage")
      throw new Error("expected applicationMessage send result");

    peelCalls = 0; // count only the ingest pass below
    const results: { kind: string; reason?: string }[] = [];
    for await (const r of engine.ingest([sent.envelope]))
      results.push(r as { kind: string; reason?: string });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "skipped", reason: "self-echo" });
    // Recognized post-peel / pre-process ⇒ peeled once, never queued for retry.
    expect(peelCalls).toBe(1);
  });
});

describe("MarmotGroupEngine admin verification (MIP-03)", () => {
  it("rejects commit send from non-admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
    });

    const { welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: nonAdminKeyPackage.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });

    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: welcome!.welcome!,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    const thirdKeyPackage = await generateKeyPackage({
      credential: createCredential("e".repeat(64)),
      ciphersuiteImpl: impl,
    });

    const engine = new MarmotGroupEngine({
      state: nonAdminStateEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await expect(
      engine.send({
        kind: "commit",
        actorPubkey: nonAdminPubkey,
        extraProposals: [
          {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: thirdKeyPackage.publicPackage },
          },
        ],
      }),
    ).rejects.toThrow("Not a group admin");
  });

  it("allows a non-admin to commit a self-update-only commit (no proposals)", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Relays must be set so the group carries a transport.nostr.routing
    // component; wrapping the resulting commit into a kind-445 event needs it.
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: createdState } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
    );

    const nonAdminKeyPackage = await generateKeyPackage({
      credential: createCredential(nonAdminPubkey),
      ciphersuiteImpl: impl,
    });

    const { welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: nonAdminKeyPackage.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });

    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: welcome!.welcome!,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    const engine = new MarmotGroupEngine({
      state: nonAdminStateEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    // A proposal-less commit is a path-only self-update; the spec lets a
    // non-admin commit it (protocol-core/group-messaging.md).
    const result = await engine.send({
      kind: "commit",
      actorPubkey: nonAdminPubkey,
      extraProposals: [],
    });
    expect(result.kind).toBe("groupEvolution");
    expect(engine.lifecycle).toBe("PendingPublish");
  });

  it("rejects a commit that adds a leaf with a forged account identity proof", () => {
    const impl = { id: 1 } as CiphersuiteImpl;
    const secretKey = new Uint8Array(32).fill(3);
    secretKey[31] = 9;
    const accountId = schnorr.getPublicKey(secretKey);
    const mlsKey = new Uint8Array(32).fill(0xcd);
    const request: AccountIdentityProofRequest = {
      accountIdentity: accountId,
      mlsSignaturePublicKey: mlsKey,
      ciphersuite: impl.id,
      signatureScheme: mlsSignatureScheme(impl.id),
    };
    const signature = signAccountIdentityProof(request, secretKey);
    signature[0] ^= 0xff;

    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [] as never,
      adminPubkeys: [bytesToHex(accountId)],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    expect(
      callback({
        kind: "commit",
        senderLeafIndex: 0,
        proposals: [
          {
            proposal: {
              proposalType: defaultProposalTypes.add,
              add: {
                keyPackage: {
                  leafNode: {
                    credential: createCredential(bytesToHex(accountId)),
                    signaturePublicKey: mlsKey,
                    extensions: [
                      makeAccountIdentityProofExtension({ request, signature }),
                    ],
                  },
                },
              },
            },
            senderLeafIndex: 0,
          },
        ],
      } as never),
    ).toBe("reject");
  });
});

describe("MarmotGroupEngine retained-history pruning (retained-history.md)", () => {
  it("pins a staged commit's source epoch against horizon pruning, then prunes once published-failed", async () => {
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

    // 2-member group: admin (the engine) + a non-admin member. The engine lives
    // at epoch 1 (member added); the member self-updates to drive inbound
    // commits that advance the canonical tip.
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
    let memberState = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });

    // Horizon of 1 + an injected retained store we can inspect.
    const policy = { ...DEFAULT_CONVERGENCE_POLICY, maxRewindCommits: 1 };
    const retained = new RetainedHistoryStore(adminEpoch1, policy);
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler,
      retained,
      convergencePolicy: policy,
    });

    // Stage a local self-update commit: enters PendingPublish, pinning epoch 1.
    const staged = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (staged.kind !== "groupEvolution")
      throw new Error("expected a groupEvolution send result");
    expect(engine.lifecycle).toBe("PendingPublish");

    // Helper: the member emits a self-update commit (allowed for non-admins) and
    // wraps it for ingest; the engine applies it, advancing the canonical tip.
    const memberSelfUpdate = async () => {
      const commit = await createCommit({
        context: ctx,
        state: memberState,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
      const envelope = await peeler.wrapGroupMessage(
        commit.commit,
        memberState,
      );
      memberState = commit.newState;
      for await (const _ of engine.ingest([envelope])) void _;
    };

    // Two inbound commits advance the tip 1 -> 2 -> 3. With horizon 1 the tip at
    // epoch 3 would normally drop epoch 1, but the staged commit pins it.
    await memberSelfUpdate();
    await memberSelfUpdate();
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
    expect(retained.hasState(1)).toBe(true);

    // Abandon the staged commit: the pin is released. A further inbound commit
    // advances the tip to 4 and epoch 1, now unpinned, is pruned past the horizon.
    engine.publishFailed(staged.pending);
    expect(engine.lifecycle).toBe("Stable");
    await memberSelfUpdate();
    expect(Number(engine.state.groupContext.epoch)).toBe(4);
    expect(retained.hasState(1)).toBe(false);
  });
});

describe("MarmotGroupEngine content-derived dedup (inbound-processing.md)", () => {
  // Build a 2-member group: admin (the engine under test) at epoch 1 with a
  // non-admin member whose state we drive directly to forge re-wrapped duplicates.
  async function twoMemberGroup() {
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
    const memberState = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });
    const peeler = testPeeler(impl);
    const engine = new MarmotGroupEngine({
      state: add.newState,
      ciphersuite: impl,
      peeler,
    });
    return { impl, ctx, peeler, engine, memberState, memberPubkey };
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

  it("skips a commit re-wrapped in a fresh envelope as duplicate", async () => {
    const { ctx, peeler, engine, memberState } = await twoMemberGroup();

    // One member self-update commit, wrapped into two distinct transport
    // envelopes (fresh nonce ⇒ different event ids, identical MLS bytes) — as if
    // delivered by two relays.
    const commit = await createCommit({
      context: ctx,
      state: memberState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const env1 = await peeler.wrapGroupMessage(commit.commit, memberState);
    const env2 = await peeler.wrapGroupMessage(commit.commit, memberState);
    expect(env1.id).not.toBe(env2.id);

    expect((await kinds(engine, env1)).map((r) => r.kind)).toEqual([
      "processed",
    ]);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    const r2 = await kinds(engine, env2);
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ kind: "skipped", reason: "duplicate" });
  });

  it("delivers a re-wrapped application message once, skipping the duplicate", async () => {
    const { ctx, peeler, engine, memberState, memberPubkey } =
      await twoMemberGroup();

    // The same application message from two relays must be delivered once, not
    // twice — the gap content dedup closes (event-id self-echo only covers own
    // sends; epoch checks only dedup commits). The payload is a valid Marmot app
    // rumor bound to the member's pubkey so it passes the M3 authorship check.
    const rumor = createChatRumor({ pubkey: memberPubkey, content: "gm" });
    const app = await createApplicationMessage({
      context: ctx,
      state: memberState,
      message: serializeApplicationRumor(rumor),
    });
    const env1 = await peeler.wrapGroupMessage(app.message, memberState);
    const env2 = await peeler.wrapGroupMessage(app.message, memberState);
    expect(env1.id).not.toBe(env2.id);

    expect((await kinds(engine, env1)).map((r) => r.kind)).toEqual([
      "processed",
    ]);

    const r2 = await kinds(engine, env2);
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ kind: "skipped", reason: "duplicate" });
  });
});
