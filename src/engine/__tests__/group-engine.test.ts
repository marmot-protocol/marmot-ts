import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
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
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { createAdminCommitPolicyCallback } from "../admin-policy.js";
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

describe("MarmotGroupEngine admin verification (MIP-03)", () => {
  it("rejects commit send from non-admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "b".repeat(64);
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
      credential: createCredential("c".repeat(64)),
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
