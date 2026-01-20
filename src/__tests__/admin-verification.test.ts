import { describe, expect, it } from "vitest";
import {
  CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  defaultProposalTypes,
} from "ts-mls";
import type { ClientState } from "ts-mls/clientState.js";
import type { MlsPrivateMessage, MlsPublicMessage } from "ts-mls/message.js";

import { createCredential } from "../core/credential.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import {
  defaultMarmotClientConfig,
  SerializedClientState,
} from "../core/client-state.js";
import { GroupStore } from "../store/group-store.js";
import type { KeyValueStoreBackend } from "../utils/key-value.js";
import {
  MarmotGroup,
  createAdminCommitPolicyCallback,
} from "../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import { EventSigner } from "applesauce-factory";
import { marmotAuthService } from "../core/auth-service.js";

class MemoryBackend<T> implements KeyValueStoreBackend<T> {
  private map = new Map<string, T>();

  async getItem(key: string): Promise<T | null> {
    return this.map.get(key) ?? null;
  }

  async setItem(key: string, value: T): Promise<T> {
    this.map.set(key, value);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
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
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );
    const context = {
      cipherSuite: impl,
      authService: marmotAuthService,
    };

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
      context,
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // Non-admin joins from the Welcome
    const nonAdminStateEpoch1 = await joinGroup({
      context,
      welcome: welcome!.welcome,
      keyPackage: nonAdminKeyPackage.publicPackage,
      privateKeys: nonAdminKeyPackage.privatePackage,
    });

    // Non-admin attempts to create a commit (should be rejected by admin verification)
    const { commit: nonAdminCommit } = await createCommit({
      context,
      state: nonAdminStateEpoch1,
    });

    // Set up MarmotGroup with admin state
    const backend = new MemoryBackend<SerializedClientState>();
    const store = new GroupStore(backend, defaultMarmotClientConfig);
    await store.add(adminStateEpoch1);

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
      onUnverifiableCommit: "reject",
    });

    const initialEpoch = group.state.groupContext.epoch;

    const result = await processMessage({
      context,
      state: group.state,
      message: nonAdminCommit as MlsPrivateMessage | MlsPublicMessage,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("reject");
    // Rejecting must not advance the group epoch.
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
  });

  it("accepts commits from admin members", async () => {
    const adminPubkey = "a".repeat(64);
    const memberPubkey = "b".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );
    const context = {
      cipherSuite: impl,
      authService: marmotAuthService,
    };

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
      context,
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // A receiver (non-admin member) joins from the Welcome and will ingest the admin's commit.
    // Processing your *own* commit against your own state is not a useful scenario here and
    // can fail inside ts-mls because the sender already advanced state locally.
    const memberStateEpoch1 = await joinGroup({
      context,
      welcome: welcome!.welcome,
      keyPackage: memberKeyPackage.publicPackage,
      privateKeys: memberKeyPackage.privatePackage,
    });

    // Admin creates a commit (should be accepted)
    const { commit: adminCommit } = await createCommit({
      context,
      state: adminStateEpoch1,
    });

    // Set up MarmotGroup with the receiver state
    const backend = new MemoryBackend<SerializedClientState>();
    const store = new GroupStore(backend, defaultMarmotClientConfig);
    await store.add(memberStateEpoch1);

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
      onUnverifiableCommit: "reject",
    });

    const result = await processMessage({
      context,
      state: group.state,
      message: adminCommit as MlsPrivateMessage | MlsPublicMessage,
      callback: adminCallback,
    });

    expect(result.kind).toBe("newState");
    if (result.kind !== "newState") throw new Error("expected newState");
    expect(result.actionTaken).toBe("accept");
    expect(result.newState.groupContext.epoch).toBe(initialEpoch + 1n);
  });
});
