import {
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  createCommit,
  type MlsMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { MarmotGroupEngine } from "../group-engine.js";
import { GroupHistoryTree } from "../history-tree.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import type { GroupPeeler } from "../types.js";

describe("bounded disband convergence", () => {
  it("holds its locally acknowledged disband at the parent until cutoff", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      signer: adminAccount.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState } = await createSimpleGroup(
      adminPackage,
      ciphersuite,
      "Terminal",
      { adminPubkeys: [admin], relays: [] },
    );
    type Envelope = { id: string };
    const messages = new Map<string, MlsMessage>();
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.map((envelope) => ({
            envelope,
            message: messages.get(envelope.id)!,
          })),
          unreadable: [],
        };
      },
      wrapGroupMessage(message) {
        messages.set("local", message);
        return Promise.resolve({ id: "local" });
      },
      idOf: (envelope) => envelope.id,
    };
    let nowMs = 100;
    const engine = new MarmotGroupEngine({
      state: clientState,
      ciphersuite,
      peeler,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
    });
    const pending = await engine.requestDisband();
    if (pending?.kind !== "groupEvolution") throw new Error("expected commit");
    const parentEpoch = Number(engine.state.groupContext.epoch);
    expect(engine.confirmPublished(pending.pending)).toEqual([]);
    expect(engine.lifecycle).toBe("Recovering");
    expect(Number(engine.state.groupContext.epoch)).toBe(parentEpoch);
    expect(engine.convergencePass).toMatchObject({
      generation: 1,
      baseEpoch: parentEpoch,
      deadlineMs: 5_100,
    });
    nowMs = 1_100;
    await engine.driveConvergence();
    expect(engine.lifecycle).toBe("Disbanded");
  });

  it("restores terminal candidate and immutable pass evidence after a crash", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      signer: adminAccount.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState } = await createSimpleGroup(
      adminPackage,
      ciphersuite,
      "Crash",
      { adminPubkeys: [admin], relays: [] },
    );
    type Envelope = { id: string };
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        return { read: [], unreadable: envelopes };
      },
      wrapGroupMessage() {
        return Promise.resolve({ id: "local" });
      },
      idOf: (envelope) => envelope.id,
    };
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
    let nowMs = 50;
    const first = new MarmotGroupEngine({
      state: clientState,
      ciphersuite,
      peeler,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      lifecycleStore,
    });
    first.history.bindStore(rewindStore);
    const staged = await first.requestDisband();
    if (staged?.kind !== "groupEvolution") throw new Error("expected commit");
    first.confirmPublished(staged.pending);
    const originalPass = first.convergencePass;
    await first.history.flush();
    await first.persistDisbandConvergence();

    const tree = await GroupHistoryTree.load(
      rewindStore,
      bytesToHex(clientState.groupContext.groupId),
    );
    if (!tree) throw new Error("expected history");
    const restored = new MarmotGroupEngine({
      state: clientState,
      ciphersuite,
      peeler,
      historyTree: tree,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
      lifecycleStore,
    });
    await restored.disbandRequest();
    expect(restored.lifecycle).toBe("Recovering");
    expect(restored.convergencePass?.generation).toBe(originalPass?.generation);
    expect(Number(restored.state.groupContext.epoch)).toBe(
      Number(clientState.groupContext.epoch),
    );
    nowMs += 1_000;
    await restored.driveConvergence();
    expect(restored.lifecycle).toBe("Disbanded");
  });

  it("recovers when history persistence crashes after write-ahead terminal evidence", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      signer: adminAccount.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState } = await createSimpleGroup(
      adminPackage,
      ciphersuite,
      "Write ahead",
      { adminPubkeys: [admin], relays: ["wss://relay.test"] },
    );
    const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
    const backing = new InMemoryKeyValueStore<Uint8Array>();
    let failHistory = true;
    const rewindStore = {
      getItem: (key: string) => backing.getItem(key),
      setItem: async (key: string, value: Uint8Array) => {
        if (failHistory) {
          failHistory = false;
          throw new Error("injected history crash");
        }
        return backing.setItem(key, value);
      },
      removeItem: (key: string) => backing.removeItem(key),
      clear: () => backing.clear(),
      keys: () => backing.keys(),
    };
    const options = {
      store: new InMemoryKeyValueStore<Uint8Array>(),
      lifecycleStore,
      rewindStore,
      signer: adminAccount.signer,
      ciphersuite,
      network: new MockNetwork(["wss://relay.test"]),
    };
    const first = new MarmotGroup(clientState, options);
    const effects = await first.session.requestDisband();
    const work = effects.publish[0];
    if (!work || work.kind !== "groupEvolution")
      throw new Error("expected commit");
    first.session.confirmPublished(work.pending);
    await expect(first.save(true)).rejects.toThrow("injected history crash");

    const restored = new MarmotGroup(clientState, options);
    await restored.session.hydrateLifecycleEvidence();
    expect(restored.lifecycle).toBe("Recovering");
    expect(Number(restored.state.groupContext.epoch)).toBe(
      Number(clientState.groupContext.epoch),
    );
    await restored.save(true);
    expect((await backing.keys()).some((key) => key.includes("/commit/"))).toBe(
      true,
    );
  });
  it("holds a valid linear disband until cutoff and terminalizes only its selected branch", async () => {
    const adminAccount = testAccount(6);
    const admin = adminAccount.pubkey;
    const memberAccount = testAccount(9);
    const member = memberAccount.pubkey;
    const ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const context = {
      cipherSuite: ciphersuite,
      authService: unsafeTestingAuthenticationService,
    };
    const adminPackage = await generateKeyPackage({
      credential: createCredential(admin),
      signer: adminAccount.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const memberPackage = await generateKeyPackage({
      credential: createCredential(member),
      signer: memberAccount.signer,
      ciphersuiteImpl: ciphersuite,
    });
    const { clientState: adminEpoch0 } = await createSimpleGroup(
      adminPackage,
      ciphersuite,
      "Terminal",
      { adminPubkeys: [admin], relays: [] },
    );
    const add = await createCommit({
      context,
      state: adminEpoch0,
      wireAsPublicMessage: false,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberPackage.publicPackage },
        },
      ],
    });
    const memberEpoch1 = await joinGroup({
      context,
      welcome: add.welcome!.welcome!,
      keyPackage: memberPackage.publicPackage,
      privateKeys: memberPackage.privatePackage,
      ratchetTree: undefined,
    });
    type Envelope = { id: string };
    const messages = new Map<string, MlsMessage>();
    let nextEnvelope = 0;
    const peeler: GroupPeeler<Envelope> = {
      async peelGroupMessages(envelopes) {
        return {
          read: envelopes.map((envelope) => ({
            envelope,
            message: messages.get(envelope.id)!,
          })),
          unreadable: [],
        };
      },
      wrapGroupMessage(message) {
        const id = `e-${nextEnvelope++}`;
        messages.set(id, message);
        return Promise.resolve({ id });
      },
      idOf(envelope) {
        return envelope.id;
      },
    };
    let nowMs = 100;
    const observer = new MarmotGroupEngine({
      state: memberEpoch1,
      ciphersuite,
      peeler,
      now: () => nowMs,
      settlementQuiescenceMs: 1_000,
    });
    const author = new MarmotGroupEngine({
      state: add.newState,
      ciphersuite,
      peeler,
      lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
    });
    const candidate = await author.requestDisband();
    if (candidate?.kind !== "groupEvolution")
      throw new Error("expected disband candidate");

    const beforeEpoch = Number(observer.state.groupContext.epoch);
    const ordinaryPass = observer.admitConvergencePass();
    nowMs = 500;
    const yielded = [];
    for await (const result of observer.ingest([candidate.envelope]))
      yielded.push(result);

    expect(yielded).toEqual([]);
    expect(observer.lifecycle).toBe("Recovering");
    expect(Number(observer.state.groupContext.epoch)).toBe(beforeEpoch);
    expect(observer.convergencePass).toMatchObject({
      generation: 1,
      openedAtMs: 100,
      deadlineMs: 5_100,
      lastRelevantInputMs: 100,
      baseEpoch: beforeEpoch,
    });
    expect(observer.convergencePass).toEqual(ordinaryPass);
    const openedPass = observer.convergencePass;

    nowMs = 700;
    for await (const _ of observer.ingest([candidate.envelope])) {
      // Duplicate terminal evidence has no scheduler effect.
    }
    expect(observer.convergencePass).toEqual(openedPass);

    nowMs = 1_100;
    await observer.driveConvergence();
    expect(observer.lifecycle).toBe("Disbanded");
    expect(observer.state.groupActiveState.kind).toBe("removedFromGroup");
    await expect(observer.send({ kind: "selfUpdate" })).rejects.toThrow();
  });
});
