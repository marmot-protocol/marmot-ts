import { EventSigner } from "applesauce-core/event-factory";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  defaultProposalTypes,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  createAdminCommitPolicyCallback,
  MarmotGroup,
} from "../marmot-group.js";
import type { NostrNetworkInterface } from "../../nostr-interface.js";
import { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import type { GroupStateStoreBackend } from "../../../store/group-state-store.js";
import { GroupStateStore } from "../../../store/group-state-store.js";
import { MemoryBackend } from "../../../__tests__/helpers/memory-backend.js";

class MemoryGroupStateBackend implements GroupStateStoreBackend {
  private map = new Map<string, SerializedClientState>();

  async get(groupId: Uint8Array): Promise<SerializedClientState | null> {
    return this.map.get(Buffer.from(groupId).toString("hex")) ?? null;
  }

  async set(
    groupId: Uint8Array,
    stateBytes: SerializedClientState,
  ): Promise<void> {
    this.map.set(Buffer.from(groupId).toString("hex"), stateBytes);
  }

  async remove(groupId: Uint8Array): Promise<void> {
    this.map.delete(Buffer.from(groupId).toString("hex"));
  }

  async list(): Promise<Uint8Array[]> {
    return [...this.map.keys()].map((hex) => Buffer.from(hex, "hex"));
  }
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

describe("MarmotGroup admin verification (MIP-03)", () => {
  it("rejects commits from non-admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "b".repeat(64);
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
    const thirdPubkey = "c".repeat(64);
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
    const store = new GroupStateStore(new MemoryGroupStateBackend());
    await store.set(
      adminStateEpoch1.groupContext.groupId,
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
      stateStore: store,
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

  it("accepts non-admin self-update commits (no proposals) (MIP-02)", async () => {
    const adminPubkey = "a".repeat(64);
    const nonAdminPubkey = "b".repeat(64);
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
    const store = new GroupStateStore(new MemoryGroupStateBackend());
    await store.set(
      adminStateEpoch1.groupContext.groupId,
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
      stateStore: store,
      signer,
      ciphersuite: impl,
      network,
    });

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
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
    const memberPubkey = "b".repeat(64);
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
    const store = new GroupStateStore(new MemoryGroupStateBackend());
    await store.set(
      memberStateEpoch1.groupContext.groupId,
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
      stateStore: store,
      signer,
      ciphersuite: impl,
      network,
    });

    const initialEpoch = group.state.groupContext.epoch;

    const adminCallback = createAdminCommitPolicyCallback({
      ratchetTree: group.state.ratchetTree,
      adminPubkeys: [adminPubkey],
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
