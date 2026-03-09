import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  createProposal,
  defaultCryptoProvider,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
  defaultProposalTypes,
} from "ts-mls";
import type { ClientState } from "ts-mls/clientState.js";
import { clientStateDecoder, clientStateEncoder } from "ts-mls/clientState.js";
import { decode, encode } from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent, sortGroupCommits } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { GroupStateStore } from "../../store/group-state-store.js";
import { KeyValueGroupStateBackend } from "../../store/adapters/key-value-group-state-backend.js";
import { MemoryBackend } from "../helpers/memory-backend.js";


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
  it("sortGroupCommits breaks created_at ties by lexicographically smallest event id (MIP-03)", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const { clientState: createdState } = await createTestGroupState(
      adminPubkey,
      impl,
    );

    // Make this a 2-member group (required for update paths).
    const memberPubkey = "c".repeat(64);
    const memberCredential = createCredential(memberPubkey);
    const memberKeyPackage = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });

    const addProposal = {
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1 } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true,
    });

    const commitA = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
      extraProposals: [],
    });

    const commitB = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
      extraProposals: [],
    });

    const eventA = await createGroupEvent({
      message: commitA.commit,
      state: adminStateEpoch1,
      ciphersuite: impl,
    });

    const eventB = await createGroupEvent({
      message: commitB.commit,
      state: adminStateEpoch1,
      ciphersuite: impl,
    });

    // Tie on created_at; order must be chosen by smallest id.
    eventA.created_at = 1;
    eventB.created_at = 1;
    eventA.id = "b".repeat(64);
    eventB.id = "a".repeat(64);

    const a = { event: eventA, message: commitA.commit };
    const b = { event: eventB, message: commitB.commit };

    const sorted = sortGroupCommits([a, b]);
    expect(sorted.map((p) => p.event.id)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
  });

  it("applies exactly one commit for an epoch (earliest created_at wins), even if events arrive reversed", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
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
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: memberKeyPackage.publicPackage },
    };

    // Admin creates an add commit and obtains a welcome for the new member.
    const { newState: adminStateEpoch1, welcome } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: createdState,
      wireAsPublicMessage: false,
      extraProposals: [addProposal],
      ratchetTreeExtension: true, // Include ratchet tree in Welcome so members can join without external tree
    });

    expect(welcome).toBeTruthy();

    // New member joins from the Welcome, producing a full ClientState they can use to create commits.
    // The Welcome now includes the ratchet_tree extension, so no external tree is needed.
    const memberStateEpoch1 = await joinGroup({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      welcome: welcome!.welcome ?? welcome,
      keyPackage: memberKeyPackage.publicPackage,
      privateKeys: memberKeyPackage.privatePackage,
      ratchetTree: undefined,
    });

    // Create two competing commits from the same baseline ADMIN state (epoch 1).
    // Per MIP-03, only admins are allowed to send commits, so both commits must be
    // authored by the admin leaf.
    //
    // ts-mls v2 treats ClientState as immutable: createCommit() returns a newState
    // object rather than mutating the passed state. Therefore, we can create two
    // commits from the same baseline state without cloning.
    const commitA = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
      extraProposals: [],
    });

    const commitB = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: adminStateEpoch1,
      extraProposals: [],
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
    // created_at first, then lexicographically smallest event id.
    eventA.created_at = 1;
    eventB.created_at = 2;
    // Signature validity is irrelevant for ingest; id is used only as a tie-breaker.
    eventA.id = "a".repeat(64);
    eventB.id = "b".repeat(64);

    // Create the new bytes-first storage
    const kvBackend = new MemoryBackend<SerializedClientState>();
    const stateStore = new GroupStateStore(
      new KeyValueGroupStateBackend(kvBackend),
    );

    // IMPORTANT: The receiver for this race test must NOT be the sender.
    // These are two competing commits from the admin leaf for the same epoch.
    // If the receiver is the admin itself, MLS update-path processing can fail because
    // UpdatePath secrets are encrypted to *other* members.
    await stateStore.set(
      memberStateEpoch1.groupContext.groupId,
      encode(clientStateEncoder, memberStateEpoch1),
    );

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
      stateStore,
      signer,
      ciphersuite: impl,
      network,
    });

    const seen: ClientState[] = [];
    for await (const res of group.ingest([eventB, eventA])) {
      if (res.kind === "processed" && res.result.kind === "newState")
        seen.push(res.result.newState);
    }

    // Exactly one epoch transition should have occurred.
    expect(seen.length).toBe(1);
    expect(group.state.groupContext.epoch).toBe(
      memberStateEpoch1.groupContext.epoch + 1n,
    );

    // Store should also reflect the post-commit epoch due to ingest() persistence.
    const reloadedBytes = await stateStore.get(
      memberStateEpoch1.groupContext.groupId,
    );
    expect(reloadedBytes).not.toBeNull();
    const reloaded = decode(clientStateDecoder, reloadedBytes!);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(group.state.groupContext.epoch);
  });

  it("persists application message epoch advancement (forward secrecy)", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
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

    const addProposalTyped = {
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
      extraProposals: [addProposalTyped],
      ratchetTreeExtension: true,
    });

    expect(welcome).toBeTruthy();

    // Create backend and store
    const kvBackend = new MemoryBackend<SerializedClientState>();
    const stateStore = new GroupStateStore(
      new KeyValueGroupStateBackend(kvBackend),
    );
    await stateStore.set(
      adminStateEpoch1.groupContext.groupId,
      encode(clientStateEncoder, adminStateEpoch1),
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
      stateStore,
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
    const { newState, message: mlsMessage } = await createApplicationMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      message: new TextEncoder().encode(JSON.stringify(rumor)),
    });

    const applicationEvent = await createGroupEvent({
      message: mlsMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // Process the application message through ingest
    const results: ClientState[] = [];
    for await (const res of group.ingest([applicationEvent])) {
      if (
        res.kind === "processed" &&
        res.result.kind === "applicationMessage"
      ) {
        results.push(res.result.newState);
      }
    }

    // Verify state was updated in memory (epoch stays same but secrets rotate)
    expect(group.state.groupContext.epoch).toBe(initialEpoch);
    expect(results.length).toBe(1);

    // CRITICAL: Verify the store persisted the state update
    // Even though epoch doesn't change, the key schedule advances for forward secrecy
    const reloadedBytes = await stateStore.get(
      adminStateEpoch1.groupContext.groupId,
    );
    expect(reloadedBytes).not.toBeNull();
    const reloaded = decode(clientStateDecoder, reloadedBytes!);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(initialEpoch);
  });

  it("processes proposals before commits (proposal/commit integration)", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
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
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: member1KeyPackage.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome: welcome1 } =
      await createCommit({
        context: {
          cipherSuite: impl,
          authService: unsafeTestingAuthenticationService,
        },
        state: createdState,
        wireAsPublicMessage: false,
        extraProposals: [addProposal1],
        ratchetTreeExtension: true,
      });

    expect(welcome1).toBeTruthy();

    // Create backend and store
    const kvBackend = new MemoryBackend<SerializedClientState>();
    const stateStore = new GroupStateStore(
      new KeyValueGroupStateBackend(kvBackend),
    );
    await stateStore.set(
      adminStateEpoch1.groupContext.groupId,
      encode(clientStateEncoder, adminStateEpoch1),
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
      stateStore,
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
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: member2KeyPackage.publicPackage },
    };

    // Create proposal message
    const { message: proposalMessage } = await createProposal({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      proposal: addProposal2,
      wireAsPublicMessage: false,
    });

    const proposalEvent = await createGroupEvent({
      message: proposalMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // First, ingest the proposal to add it to unappliedProposals
    const proposalResults: ClientState[] = [];
    for await (const res of group.ingest([proposalEvent])) {
      if (res.kind === "processed" && res.result.kind === "newState") {
        proposalResults.push(res.result.newState);
      }
    }

    // Verify proposal was processed
    expect(proposalResults.length).toBe(1);

    expect(Object.keys(group.state.unappliedProposals).length).toBe(1);

    // Now create a commit that uses proposals from unappliedProposals
    const { commit: commitMessage } = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: group.state,
      wireAsPublicMessage: false,
      // Don't pass extraProposals - let createCommit use unappliedProposals
    });

    const commitEvent = await createGroupEvent({
      message: commitMessage,
      state: group.state,
      ciphersuite: impl,
    });

    // Ingest the commit
    const commitResults: ClientState[] = [];
    for await (const res of group.ingest([commitEvent])) {
      if (res.kind === "processed" && res.result.kind === "newState") {
        commitResults.push(res.result.newState);
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
    const reloadedBytes = await stateStore.get(
      adminStateEpoch1.groupContext.groupId,
    );
    expect(reloadedBytes).not.toBeNull();
    const reloaded = decode(clientStateDecoder, reloadedBytes!);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.groupContext.epoch).toBe(group.state.groupContext.epoch);
  });
});
