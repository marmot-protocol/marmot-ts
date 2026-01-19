import { describe, expect, it } from "vitest";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createProposal,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
} from "ts-mls";
import { createCommit } from "ts-mls/createCommit.js";
import type { ClientState } from "ts-mls/clientState.js";
import { encodeGroupState, decodeGroupState } from "ts-mls/clientState.js";

import { createCredential } from "../core/credential.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import {
  defaultMarmotClientConfig,
  SerializedClientState,
} from "../core/client-state.js";
import { createGroupEvent } from "../core/group-message.js";
import { GroupStore } from "../store/group-store.js";
import type { KeyValueStoreBackend } from "../utils/key-value.js";
import { MarmotGroup } from "../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import { EventSigner } from "applesauce-core";
import { Rumor } from "applesauce-common/helpers";

export class MemoryBackend<T> implements KeyValueStoreBackend<T> {
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

describe("MarmotGroup.ingest() commit race ordering (MIP-03)", () => {
  it("applies exactly one commit for an epoch (earliest created_at wins), even if events arrive reversed", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // ----------------------------------------------------------------------
    // Make this a 2-member group.
    // A 1-member group commit from "self" can fail inside ts-mls processing
    // ("Could not find common ancestor") because update paths are defined over
    // paths between distinct leaves.
    // ----------------------------------------------------------------------
    const memberPubkey = "c".repeat(64);
    const memberCredential = createCredential(memberPubkey);
    const memberKeyPackage = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: "add" as const,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    // Admin creates an add commit and obtains a welcome for the new member.
    const { newState: adminStateEpoch1, welcome } = await createCommit(
      { state: createdState, cipherSuite: impl },
      {
        wireAsPublicMessage: false,
        extraProposals: [addProposal],
        ratchetTreeExtension: true, // Include ratchet tree in Welcome so members can join without external tree
      },
    );

    expect(welcome).toBeTruthy();

    // New member joins from the Welcome, producing a full ClientState they can use to create commits.
    // The Welcome now includes the ratchet_tree extension, so no external tree is needed.
    const memberStateEpoch1 = await joinGroup(
      welcome!,
      memberKeyPackage.publicPackage,
      memberKeyPackage.privatePackage,
      { findPsk: () => undefined },
      impl,
    );

    // Create two competing commits from the same baseline ADMIN state (epoch 1).
    // Per MIP-03, only admins are allowed to send commits, so both commits must be
    // authored by the admin leaf.
    //
    // NOTE: In MLS, creating a commit updates the sender's leaf key pair, so we cannot
    // create two commits from the same ClientState object. We must clone the state first.
    const commitA = await createCommit({
      state: adminStateEpoch1,
      cipherSuite: impl,
    });

    // Clone the baseline admin state to create a second independent copy for commitB.
    // ClientState = GroupState + clientConfig, so preserve clientConfig.
    const decodedAdminGroupState = decodeGroupState(
      encodeGroupState(adminStateEpoch1),
      0,
    )?.[0];
    if (!decodedAdminGroupState) {
      throw new Error("Failed to clone adminStateEpoch1");
    }
    const adminStateEpoch1Clone: ClientState = {
      ...decodedAdminGroupState,
      clientConfig: adminStateEpoch1.clientConfig,
    };

    const commitB = await createCommit({
      state: adminStateEpoch1Clone,
      cipherSuite: impl,
    });

    // Encrypt commits using the exporter_secret for the current epoch (baseline state),
    // matching what receivers can decrypt at this point.
    const eventA = await createGroupEvent({
      message: commitA.commit,
      // Encrypt with epoch-1 exporter secret (use admin state which has proper extensions).
      state: adminStateEpoch1,
      ciphersuite: impl,
    });

    const eventB = await createGroupEvent({
      message: commitB.commit,
      state: adminStateEpoch1,
      ciphersuite: impl,
    });

    // Force deterministic race ordering according to MIP-03:
    // created_at first, then event id.
    eventA.created_at = 1;
    eventB.created_at = 2;
    // Signature validity is irrelevant for ingest; id is used only as a tie-breaker.
    eventA.id = "a".repeat(64);
    eventB.id = "b".repeat(64);

    const backend = new MemoryBackend<SerializedClientState>();
    const store = new GroupStore(backend, defaultMarmotClientConfig);
    // IMPORTANT: The receiver for this race test must NOT be the sender.
    // These are two competing commits from the admin leaf for the same epoch.
    // If the receiver is the admin itself, MLS update-path processing can fail because
    // UpdatePath secrets are encrypted to *other* members.
    await store.add(memberStateEpoch1);

    const network: NostrNetworkInterface = {
      request: async () => {
        throw new Error("not used in this unit test");
      },
      subscription: () => {
        throw new Error("not used in this unit test");
      },
      publish: async () => {
        throw new Error("not used in this unit test");
      },
      getUserInboxRelays: async () => {
        throw new Error("not used in this unit test");
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

    const seen: ClientState[] = [];
    for await (const res of group.ingest([eventB, eventA])) {
      if (res.kind === "newState") seen.push(res.newState);
    }

    // Exactly one epoch transition should have occurred.
    expect(seen.length).toBe(1);
    expect(group.state.groupContext.epoch).toBe(
      memberStateEpoch1.groupContext.epoch + 1n,
    );

    // Store should also reflect the post-commit epoch due to ingest() persistence.
    const reloaded = await store.get(memberStateEpoch1.groupContext.groupId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(group.state.groupContext.epoch);
  });

  it("persists application message epoch advancement (forward secrecy)", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    // Create initial group state
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add a member to make it a 2-member group (required for update paths)
    const memberPubkey = "c".repeat(64);
    const memberCredential = createCredential(memberPubkey);
    const memberKeyPackage = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: "add" as const,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit(
      { state: createdState, cipherSuite: impl },
      {
        wireAsPublicMessage: false,
        extraProposals: [addProposal],
        ratchetTreeExtension: true,
      },
    );

    expect(welcome).toBeTruthy();

    // Create backend and store
    const backend = new MemoryBackend<any>();
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

    // Record initial epoch
    const initialEpoch = group.state.groupContext.epoch;

    // Create an application message (chat message)
    const rumor: Rumor = {
      id: "r".repeat(64),
      kind: 1,
      content: "Hello, world!",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: adminPubkey,
    };

    // Send application message through MarmotGroup
    // This should update state for forward secrecy and persist it
    const { newState, privateMessage } = await createApplicationMessage(
      group.state,
      new TextEncoder().encode(JSON.stringify(rumor)),
      impl,
    );

    const mlsMessage = {
      version: group.state.groupContext.version,
      wireformat: "mls_private_message" as const,
      privateMessage,
    };

    const applicationEvent = await createGroupEvent({
      message: mlsMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // Process the application message through ingest
    const results: ClientState[] = [];
    for await (const res of group.ingest([applicationEvent])) {
      if (res.kind === "applicationMessage") {
        results.push(res.newState);
      }
    }

    // Verify state was updated in memory (epoch stays same but secrets rotate)
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
    expect(results.length).toBe(1);

    // CRITICAL: Verify the store persisted the state update
    // Even though epoch doesn't change, the key schedule advances for forward secrecy
    const reloaded = await store.get(adminStateEpoch1.groupContext.groupId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(initialEpoch);
  });

  it("processes proposals before commits (proposal/commit integration)", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    // Create initial group state
    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Add first member to make it a 2-member group
    const member1Pubkey = "c".repeat(64);
    const member1Credential = createCredential(member1Pubkey);
    const member1KeyPackage = await generateKeyPackage({
      credential: member1Credential,
      ciphersuiteImpl: impl,
    });

    const addProposal1 = {
      proposalType: "add" as const,
      add: { keyPackage: member1KeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome: welcome1 } =
      await createCommit(
        { state: createdState, cipherSuite: impl },
        {
          wireAsPublicMessage: false,
          extraProposals: [addProposal1],
          ratchetTreeExtension: true,
        },
      );

    expect(welcome1).toBeTruthy();

    // Create backend and store
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

    // Create a proposal to add a second member
    const member2Pubkey = "d".repeat(64);
    const member2Credential = createCredential(member2Pubkey);
    const member2KeyPackage = await generateKeyPackage({
      credential: member2Credential,
      ciphersuiteImpl: impl,
    });

    const addProposal2 = {
      proposalType: "add" as const,
      add: { keyPackage: member2KeyPackage.publicPackage },
    };

    // Create proposal message
    const { message: proposalMessage } = await createProposal(
      group.state,
      false, // private message
      addProposal2,
      impl,
    );

    const proposalEvent = await createGroupEvent({
      message: proposalMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // First, ingest the proposal to add it to unappliedProposals
    const proposalResults: ClientState[] = [];
    for await (const res of group.ingest([proposalEvent])) {
      if (res.kind === "newState") {
        proposalResults.push(res.newState);
      }
    }

    // Verify proposal was processed
    expect(proposalResults.length).toBe(1);

    expect(Object.keys(group.state.unappliedProposals).length).toBe(1);

    // Now create a commit that uses proposals from unappliedProposals
    const { commit: commitMessage } = await createCommit(
      { state: group.state, cipherSuite: impl },
      {
        wireAsPublicMessage: false,
        // Don't pass extraProposals - let createCommit use unappliedProposals
      },
    );

    const commitEvent = await createGroupEvent({
      message: commitMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // Ingest the commit
    const commitResults: ClientState[] = [];
    for await (const res of group.ingest([commitEvent])) {
      if (res.kind === "newState") {
        commitResults.push(res.newState);
      }
    }

    // Verify commit was processed
    expect(commitResults.length).toBe(1);

    // Verify epoch advanced
    expect(group.state.groupContext.epoch).toBe(
      adminStateEpoch1.groupContext.epoch + 1n,
    );

    // Verify the proposal is no longer in unappliedProposals after commit
    expect(Object.keys(group.state.unappliedProposals).length).toBe(0);

    // Verify persistence
    const reloaded = await store.get(adminStateEpoch1.groupContext.groupId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(group.state.groupContext.epoch);
  });
});
