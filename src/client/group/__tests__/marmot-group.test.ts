import { EventSigner } from "applesauce-core/factories";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { SerializedClientState } from "../../../core/client-state.js";
import {
  type AccountIdentityProofRequest,
  makeAccountIdentityProofExtension,
  mlsSignatureScheme,
  signAccountIdentityProof,
} from "../../../core/account-identity-proof.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra";
import type { NostrNetworkInterface } from "../../nostr-interface.js";
import {
  createAdminCommitPolicyCallback,
  MarmotGroup,
} from "../marmot-group.js";

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

describe("MarmotGroup lifecycle (group-state.md)", () => {
  it("starts Stable, returns to Stable after commit, and resets to Stable on publish failure", async () => {
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

    let failPublish = true;
    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used");
      },
      subscription: () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
      publish: async () => ({
        "wss://relay.test": failPublish
          ? { from: "wss://relay.test", ok: false, message: "nope" }
          : { from: "wss://relay.test", ok: true },
      }),
    };
    const signer = {
      getPublicKey: async () => adminPubkey,
    } as EventSigner;

    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer,
      ciphersuite: impl,
      network,
    });

    expect(group.lifecycle).toBe("Stable");
    expect(group.info.mls.groupIdHex).toBe(bytesToHex(group.id));
    expect(group.info.mls.epoch).toBe(clientState.groupContext.epoch);
    expect(group.info.mls.cipherSuite).toBe(clientState.groupContext.cipherSuite);
    expect(group.info.app.view?.name).toBe("Test Group");
    expect(group.info.app.components.map((component) => component.name)).toEqual(
      [
        "app_components",
        "marmot.group.profile.v1",
        "marmot.group.admin-policy.v1",
        "marmot.transport.nostr.routing.v1",
      ],
    );
    expect(group.info.nostr.groupIdHex).toHaveLength(64);
    expect(group.info.nostr.relays).toEqual(["wss://relay.test"]);
    expect(group.info.members.pubkeys).toEqual([adminPubkey]);

    // Publish fails (no ack) → PendingPublish is abandoned back to Stable.
    await expect(
      group.runtime.publishEffects(
        await group.session.send({
          kind: "commit",
          actorPubkey: adminPubkey,
          extraProposals: [],
        }),
      ),
    ).rejects.toThrow();
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(clientState.groupContext.epoch);

    // Publish succeeds → Merging → apply → Stable, epoch advanced.
    failPublish = false;
    await group.runtime.publishEffects(
      await group.session.send({
        kind: "commit",
        actorPubkey: adminPubkey,
        extraProposals: [],
      }),
    );
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch + 1n,
    );
  });

  it("publishes session effects through the group runtime", async () => {
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
    const network: NostrNetworkInterface = {
      request: async () => [],
      subscription: () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
      publish: async () => ({
        "wss://relay.test": { from: "wss://relay.test", ok: true },
      }),
    };
    const signer = { getPublicKey: async () => adminPubkey } as EventSigner;
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer,
      ciphersuite: impl,
      network,
    });

    const effects = await group.session.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    expect(effects.publish).toHaveLength(1);
    expect(effects.publish[0].kind).toBe("groupEvolution");

    const results = await group.runtime.publishEffects(effects);

    expect(results).toHaveLength(1);
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(
      clientState.groupContext.epoch + 1n,
    );
  });
});

describe("MarmotGroup admin verification (MIP-03)", () => {
  it("rejects commits from non-admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: nonAdminKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // Non-admin joins from the Welcome
    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: (welcome as any).welcome ?? (welcome as any),
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Non-admin attempts to create a commit (should be rejected by admin verification)
    // Create a commit that includes proposals (not a self-update), which MUST remain
    // admin-only under MIP-03.
    const thirdPubkey = "e".repeat(64);
    const thirdCredential = createCredential(thirdPubkey);
    const thirdKeyPackage = await generateKeyPackage({
      credential: thirdCredential,
      ciphersuiteImpl: impl,
    });
    const nonAdminAddProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: thirdKeyPackage.publicPackage },
    };

    const { commit: nonAdminCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: nonAdminStateEpoch1,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [nonAdminAddProposal],
    });

    // Set up MarmotGroup with admin state
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(adminStateEpoch1.groupContext.groupId),
      adminStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used");
      },
      subscription: () => {
        throw new Error("not used");
      },
      publish: async () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
    };

    const signer = {
      getPublicKey: async () => adminPubkey,
    } as EventSigner;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    // Use the same policy MarmotGroup.ingest() uses, but call ts-mls directly.
    // This keeps the test focused on the MIP-03 rule (admin-only commits), and
    // avoids unrelated NIP-44 decryption / retry behavior.
    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: nonAdminCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("reject");
    // Rejecting must not advance the group epoch.
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
  });

  it("rejects a commit that adds a leaf with a forged account identity proof", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // A leaf whose account-identity-proof signature does not verify for the
    // credential identity it claims (one tampered signature byte).
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
    signature[0] ^= 0xff; // forge

    const forgedLeaf = {
      credential: createCredential(bytesToHex(accountId)),
      signaturePublicKey: mlsKey,
      extensions: [makeAccountIdentityProofExtension({ request, signature })],
    };
    const incoming = {
      kind: "commit" as const,
      senderLeafIndex: 0,
      proposals: [
        {
          proposal: {
            proposalType: defaultProposalTypes.add,
            add: { keyPackage: { leafNode: forgedLeaf } },
          },
          senderLeafIndex: 0,
        },
      ],
    };

    // The committer is an admin (would otherwise be accepted); the forged proof
    // is rejected regardless, before the admin short-circuit.
    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [] as never,
      adminPubkeys: [bytesToHex(accountId)],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    expect(callback(incoming as never)).toBe("reject");
  });

  it("accepts non-admin self-update commits (no proposals) (MIP-02)", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: nonAdminKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    // Non-admin joins from the Welcome
    const nonAdminStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: welcome?.welcome!,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Non-admin creates a self-update commit (no proposals)
    const { commit: nonAdminSelfUpdateCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: nonAdminStateEpoch1,
      extraProposals: [],
      ratchetTreeExtension: true,
      wireAsPublicMessage: false,
    });

    // Set up MarmotGroup with admin state and verify the admin will ACCEPT this commit
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(adminStateEpoch1.groupContext.groupId),
      adminStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used");
      },
      subscription: () => {
        throw new Error("not used");
      },
      publish: async () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
    };

    const signer = {
      getPublicKey: async () => adminPubkey,
    } as EventSigner;

    const group = new MarmotGroup(adminStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: nonAdminSelfUpdateCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });

  it("accepts commits from admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const memberPubkey = "d".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Make this a 2-member group.
    // A 1-member group commit from "self" can fail inside ts-mls processing
    // ("Could not find common ancestor") because update paths are defined over
    // paths between distinct leaves.
    const memberCredential = createCredential(memberPubkey);
    const memberKeyPackage = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal as any],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // A receiver (non-admin member) joins from the Welcome and will ingest the admin's commit.
    // Processing your *own* commit against your own state is not a useful scenario here and
    // can fail inside ts-mls because the sender already advanced state locally.
    const memberStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: (welcome as any).welcome ?? (welcome as any),
      keyPackage: memberKeyPackage.publicPackage,
      privateKeys: memberKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Admin creates a commit (should be accepted)
    const { commit: adminCommit } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
    });

    // Set up MarmotGroup with the receiver state
    const store = new InMemoryKeyValueStore<SerializedClientState>();
    await store.setItem(
      bytesToHex(memberStateEpoch1.groupContext.groupId),
      memberStateEpoch1 as any,
    );

    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used");
      },
      subscription: () => {
        throw new Error("not used");
      },
      publish: async () => {
        throw new Error("not used");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used");
      },
    };

    const signer = {
      getPublicKey: async () => memberPubkey,
    } as EventSigner;

    const group = new MarmotGroup(memberStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
    });

    const initialEpoch = group.state.groupContext.epoch;

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    const result = await processMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: adminCommit as any,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });
});
