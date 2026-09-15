import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  CiphersuiteImpl,
  appDataUpdateProposalType,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  getAppDataDictionary,
  joinGroup,
  makeAppDataDictionaryExtension,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  deserializeClientState,
  serializeClientState,
  SerializedClientState,
} from "../../../core/client-state.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  AccountIdentityProofError,
  buildAppDataDictionary,
  componentEntry,
  makeLeafAppComponentsExtension,
  produceAccountIdentityProof,
  validateKeyPackageAccountIdentityProof,
} from "../../../core/components/index.js";
import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import {
  decodeComponentsList,
  encodeComponentsList,
} from "../../../core/components/app-components-list.js";
import {
  APP_COMPONENTS_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
  GROUP_PROFILE_COMPONENT_ID,
} from "../../../core/components/ids.js";
import { encodeGroupProfileV1 } from "../../../core/components/group-profile.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra";
import type { NostrNetworkInterface } from "../../nostr-interface.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import {
  createAdminCommitPolicyCallback,
  MarmotGroup,
} from "../marmot-group.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

async function createTestGroupState(
  account: PrivateKeyAccount<any>,
  ciphersuiteImpl: CiphersuiteImpl,
) {
  const adminPubkey = account.pubkey;
  const credential = createCredential(adminPubkey);
  const kp = await generateKeyPackage({
    credential,
    ciphersuiteImpl,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(
    kp,
    ciphersuiteImpl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
  );
  return { clientState, kp };
}

describe("MarmotGroup lifecycle (group-state.md)", () => {
  it("automatically regenerates disband after real convergence selects a deeper active branch", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const cloneState = () =>
      deserializeClientState(serializeClientState(clientState));
    let nowMs = 100;
    let scheduled: (() => void) | undefined;
    const scheduler = {
      setTimer(_ms: number, callback: () => void) {
        scheduled = callback;
        return callback;
      },
      clearTimer(handle: unknown) {
        if (scheduled === handle) scheduled = undefined;
      },
    };
    const targetNetwork = new MockNetwork(["wss://relay.test"]);
    const target = new MarmotGroup(cloneState(), {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: targetNetwork,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      scheduler,
    });
    await expect(target.disband()).resolves.toMatchObject({
      kind: "acknowledged",
    });
    expect(target.lifecycle).toBe("Recovering");
    expect(targetNetwork.events).toHaveLength(1);

    const competitor = new MarmotGroup(cloneState(), {
      store: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: new MockNetwork(["wss://relay.test"]),
    });
    const activeCommit = (name: string) =>
      competitor.session.send({
        kind: "commit" as const,
        actorPubkey: admin,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: GROUP_PROFILE_COMPONENT_ID,
              operation: "update" as const,
              update: encodeGroupProfileV1({ name, description: "" }),
            },
          },
        ],
      });
    const first = await activeCommit("Active one");
    const firstWork = first.publish[0];
    if (!firstWork || firstWork.kind !== "groupEvolution")
      throw new Error("expected first active commit");
    competitor.session.confirmPublished(firstWork.pending);
    const second = await activeCommit("Active two");
    const secondWork = second.publish[0];
    if (!secondWork || secondWork.kind !== "groupEvolution")
      throw new Error("expected second active commit");

    for await (const _ of target.ingest([
      firstWork.envelope,
      secondWork.envelope,
    ])) {
      // Drain the real competing-branch ingest path.
    }
    expect(Number(target.state.groupContext.epoch)).toBe(2);
    expect(target.lifecycle).toBe("Recovering");

    nowMs = 5_100;
    const cutoff = scheduled;
    if (!cutoff) throw new Error("expected convergence cutoff");
    cutoff();
    await vi.waitFor(() => expect(targetNetwork.events).toHaveLength(2));
    expect(target.lifecycle).toBe("Recovering");
    expect((await target.session.disbandRequest())?.lastPreparedEpoch).toBe(2);

    nowMs = 10_100;
    const terminalCutoff = scheduled;
    if (!terminalCutoff) throw new Error("expected regenerated cutoff");
    terminalCutoff();
    await vi.waitFor(() => expect(target.status).toBe("disbanded"));
    expect(targetNetwork.events).toHaveLength(2);
  });

  it("rejects public legacy enablement when any resulting leaf lacks lifecycle support", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const memberAccount = testAccount(11);
    const member = memberAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
    const memberPackage = await generateKeyPackage({
      credential: createCredential(member),
      ciphersuiteImpl: impl,
      signer: memberAccount.signer,
    });
    const { clientState } = await createSimpleGroup(
      adminPackage,
      impl,
      "Legacy",
      { adminPubkeys: [admin], relays: ["wss://relay.test"] },
    );
    const added = await createCommit({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: clientState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberPackage.publicPackage },
        },
      ],
    });
    const legacy = added.newState;
    const withoutLifecycle = (
      extensions: typeof legacy.groupContext.extensions,
    ) =>
      extensions.map((extension) => {
        const dictionary = getAppDataDictionary([extension]);
        if (!dictionary) return extension;
        const entries = dictionary
          .filter((entry) => entry.componentId !== GROUP_LIFECYCLE_COMPONENT_ID)
          .map((entry) =>
            entry.componentId === APP_COMPONENTS_COMPONENT_ID
              ? {
                  ...entry,
                  data: encodeComponentsList(
                    decodeComponentsList(entry.data).filter(
                      (id) => id !== GROUP_LIFECYCLE_COMPONENT_ID,
                    ),
                  ),
                }
              : entry,
          );
        return makeAppDataDictionaryExtension(entries);
      });
    legacy.groupContext.extensions = withoutLifecycle(
      legacy.groupContext.extensions,
    );
    const memberLeaf = legacy.ratchetTree[2];
    if (!memberLeaf || !("leaf" in memberLeaf))
      throw new Error("member leaf missing");
    memberLeaf.leaf.extensions = withoutLifecycle(memberLeaf.leaf.extensions);

    const network = new MockNetwork(["wss://relay.test"]);
    const group = new MarmotGroup(legacy, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });
    await expect(group.enableDisbanding()).resolves.toMatchObject({
      kind: "rejected",
      reason: "unsupportedMembers",
    });
    expect(network.events).toEqual([]);
  });

  it("publishes disband intent once and keeps the durable request pending", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const network = new MockNetwork(["wss://relay.test"]);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore,
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });

    const result = await group.disband();
    expect(result).toMatchObject({ kind: "acknowledged" });
    expect(network.events).toHaveLength(1);
    expect(
      await lifecycleStore.getItem(`${group.idStr}/disband/request`),
    ).not.toBeNull();

    const repeated = await group.disband();
    expect(repeated.kind).toBe("pending");
    expect(network.events).toHaveLength(1);
  });

  it("retains disband intent and rolls staged state back on publish failure", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const network = new MockNetwork(["wss://relay.test"]);
    vi.spyOn(network, "publish").mockResolvedValue({
      "wss://relay.test": { from: "wss://relay.test", ok: false },
    });
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore,
      signer: adminAccount.signer,
      ciphersuite: impl,
      network,
    });

    const result = await group.disband();

    expect(result.kind).toBe("publishFailed");
    expect(group.lifecycle).toBe("Stable");
    expect(
      await lifecycleStore.getItem(`${group.idStr}/disband/request`),
    ).not.toBeNull();
  });

  it("reports lifecycle enablement idempotently through the public facade", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { clientState } = await createTestGroupState(adminAccount, impl);
    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      ciphersuite: impl,
      network: new MockNetwork(["wss://relay.test"]),
    });

    await expect(group.enableDisbanding()).resolves.toEqual({
      kind: "alreadyEnabled",
    });
  });

  it("starts Stable, returns to Stable after commit, and resets to Stable on publish failure", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
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
    const signer = adminAccount.signer;

    const group = new MarmotGroup(clientState, {
      store: new InMemoryKeyValueStore(),
      signer,
      ciphersuite: impl,
      network,
    });

    expect(group.lifecycle).toBe("Stable");
    expect(group.info.mls.groupIdHex).toBe(bytesToHex(group.id));
    expect(group.info.mls.epoch).toBe(clientState.groupContext.epoch);
    expect(group.info.mls.cipherSuite).toBe(
      clientState.groupContext.cipherSuite,
    );
    expect(group.info.app.view?.name).toBe("Test Group");
    expect(
      group.info.app.components.map((component) => component.name),
    ).toEqual([
      "app_components",
      "marmot.group.profile.v1",
      "marmot.group.admin-policy.v1",
      "marmot.transport.nostr.routing.v1",
      "marmot.group.lifecycle.v1",
    ]);
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
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: adminAccount.signer,
    });
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
    const signer = adminAccount.signer;
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
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const nonAdminAccount = testAccount(9);
    const nonAdminPubkey = nonAdminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
      signer: nonAdminAccount.signer,
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
    const thirdAccount = testAccount(11);
    const thirdPubkey = thirdAccount.pubkey;
    const thirdCredential = createCredential(thirdPubkey);
    const thirdKeyPackage = await generateKeyPackage({
      credential: thirdCredential,
      ciphersuiteImpl: impl,
      signer: thirdAccount.signer,
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

    const signer = adminAccount.signer;

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

    // A leaf whose 0x8009 account-identity-proof signature does not verify
    // for the credential identity it claims (one tampered signature byte).
    const account = testAccount(6);
    const mlsKey = new Uint8Array(32).fill(0xcd);
    const proof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: mlsKey,
      ciphersuite: impl.id,
      createdAt: 1700000000,
    });
    const tampered = proof.slice();
    tampered[tampered.length - 1] ^= 0xff; // forge

    const forgedLeaf = {
      credential: createCredential(account.pubkey),
      signaturePublicKey: mlsKey,
      extensions: [makeLeafAppComponentsExtension(tampered)],
    };
    const incoming = {
      kind: "commit" as const,
      senderLeafIndex: 0,
      proposals: [
        {
          proposal: {
            proposalType: defaultProposalTypes.add,
            add: {
              keyPackage: {
                cipherSuite: impl.id,
                leafNode: forgedLeaf,
                extensions: [],
              },
            },
          },
          senderLeafIndex: 0,
        },
      ],
    };

    // The committer is an admin (would otherwise be accepted); the forged proof
    // is rejected regardless, before the admin short-circuit.
    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [] as never,
      adminPubkeys: [account.pubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "reject",
    });

    expect(callback(incoming as never)).toBe("reject");
  });

  it("rejects an Add whose proof material is only at the KeyPackage level, matching the invite seam (WR-01)", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    const account = testAccount(6);
    const mlsKey = new Uint8Array(32).fill(0xcd);
    const proof = await produceAccountIdentityProof({
      signer: account.signer,
      accountIdentity: hexToBytes(account.pubkey),
      mlsSignatureKey: mlsKey,
      ciphersuite: impl.id,
      createdAt: 1700000000,
    });

    // The leaf itself carries no proof material at all.
    const bareLeaf = {
      credential: createCredential(account.pubkey),
      signaturePublicKey: mlsKey,
      extensions: [],
    };
    const addCommit = (keyPackageExtensions: unknown[]) => ({
      kind: "commit" as const,
      senderLeafIndex: 0,
      proposals: [
        {
          proposal: {
            proposalType: defaultProposalTypes.add,
            add: {
              keyPackage: {
                cipherSuite: impl.id,
                leafNode: bareLeaf,
                extensions: keyPackageExtensions,
              },
            },
          },
          senderLeafIndex: 0,
        },
      ],
    });

    // With an empty ratchet tree the sender lookup after the proof gate is
    // unverifiable, and "retry" makes that path throw instead of returning. So a
    // returned "reject" can only come from the proof gate itself.
    const callback = createAdminCommitPolicyCallback({
      ratchetTree: [] as never,
      adminPubkeys: [account.pubkey],
      ciphersuiteId: impl.id,
      onUnverifiableCommit: "retry",
    });

    // Legacy 0xf2f1 extension at the KeyPackage level.
    const legacyAtKeyPackage = addCommit([
      { extensionType: 0xf2f1, extensionData: new Uint8Array([1]) },
    ]);
    expect(callback(legacyAtKeyPackage as never)).toBe("reject");

    // A 0x8009 dictionary entry misplaced at the KeyPackage level.
    const proofAtKeyPackage = addCommit([
      makeAppDataDictionaryExtension(
        buildAppDataDictionary([
          componentEntry(ACCOUNT_IDENTITY_PROOF_COMPONENT_ID, proof),
        ]),
      ),
    ]);
    expect(callback(proofAtKeyPackage as never)).toBe("reject");

    // Both KeyPackages are rejected by the invite seam's validator too.
    for (const incoming of [legacyAtKeyPackage, proofAtKeyPackage]) {
      expect(() =>
        validateKeyPackageAccountIdentityProof(
          incoming.proposals[0]!.proposal.add.keyPackage as never,
          impl.id,
        ),
      ).toThrow(AccountIdentityProofError);
    }

    // Control: with no proof material anywhere the Add is skipped by the proof gate
    // (documented D-06 gap) and evaluation proceeds to the sender check.
    expect(() => callback(addCommit([]) as never)).toThrow(
      "unverifiable commit sender",
    );
  });

  it("accepts non-admin self-update commits (no proposals) (MIP-02)", async () => {
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const nonAdminAccount = testAccount(9);
    const nonAdminPubkey = nonAdminAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
      impl,
    );

    // Add non-admin member to the group
    const nonAdminCredential = createCredential(nonAdminPubkey);
    const nonAdminKeyPackage = await generateKeyPackage({
      credential: nonAdminCredential,
      ciphersuiteImpl: impl,
      signer: nonAdminAccount.signer,
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

    const signer = adminAccount.signer;

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
    const adminAccount = testAccount(6);
    const adminPubkey = adminAccount.pubkey;
    const memberAccount = testAccount(9);
    const memberPubkey = memberAccount.pubkey;
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    // Create initial group with admin as sole member
    const { clientState: createdState } = await createTestGroupState(
      adminAccount,
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
      signer: memberAccount.signer,
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

    const signer = memberAccount.signer;

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
