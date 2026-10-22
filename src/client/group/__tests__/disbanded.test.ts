import { bytesToHex } from "@noble/hashes/utils.js";
import {
  defaultCryptoProvider,
  getCiphersuiteImpl,
  createCommit,
  createProposal,
  defaultProposalTypes,
  joinGroup,
  unsafeTestingAuthenticationService,
  getAppDataDictionary,
  makeAppDataDictionaryExtension,
  selfRemoveProposalType,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";

import { createCredential } from "../../../core/credential.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { GroupTerminalError, MarmotGroup } from "../marmot-group.js";
import { MockNetwork } from "../../../__tests__/helpers/mock-network.js";
import { GroupRegistry } from "../../group-registry.js";
import {
  decodeDisbandTombstone,
  disbandTombstoneKey,
  encodeDisbandTombstone,
  type DisbandTombstone,
  encodeDisbandTerminalIntent,
  decodeDisbandTerminalIntent,
  disbandTerminalIntentKey,
} from "../../../engine/disband-tombstone.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import { deserializeClientState } from "../../../core/client-state.js";
import { GROUP_PROFILE_COMPONENT_ID } from "../../../core/components/ids.js";
import { GroupSession } from "../../session/group-session.js";
import { createGroupEvent } from "../../../core/group-event.js";

async function peers() {
  const admin = testAccount(6),
    member = testAccount(9);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const [adminKp, memberKp] = await Promise.all(
    [admin, member].map((account) =>
      generateKeyPackage({
        credential: createCredential(account.pubkey),
        ciphersuiteImpl: impl,
        signer: account.signer,
      }),
    ),
  );
  const { clientState } = await createSimpleGroup(
    adminKp,
    impl,
    "real terminal peers",
    { adminPubkeys: [admin.pubkey], relays: ["wss://relay.test"] },
  );
  const context = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const added = await createCommit({
    context,
    state: clientState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
  });
  const memberState = await joinGroup({
    context,
    welcome: added.welcome!.welcome!,
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { admin, member, impl, adminState: added.newState, memberState };
}

const GROUP_ID = new Uint8Array([1, 2, 3]);
const COMMIT_DIGEST = new Uint8Array(32).fill(4);

describe("disband tombstone", () => {
  const tombstone: DisbandTombstone = {
    groupId: GROUP_ID,
    selectedEpoch: 7,
    commitDigest: COMMIT_DIGEST,
    actorPubkey: "a".repeat(64),
    notificationState: "pending",
  };

  it("uses a namespace distinct from the pending request", () => {
    expect(disbandTombstoneKey("010203")).toBe("010203/disband/terminal");
  });

  it("round-trips authenticated terminal evidence", () => {
    expect(decodeDisbandTombstone(encodeDisbandTombstone(tombstone))).toEqual(
      tombstone,
    );
  });

  it("round-trips a versioned intent separately from legacy terminal evidence", () => {
    const intent = { tombstone, registryState: new Uint8Array([1, 2, 3]) };
    expect(disbandTerminalIntentKey("010203")).toBe("010203/disband/intent/v1");
    expect(
      decodeDisbandTerminalIntent(encodeDisbandTerminalIntent(intent)),
    ).toEqual(intent);
    expect(() =>
      decodeDisbandTerminalIntent(new TextEncoder().encode('{"version":2}')),
    ).toThrow();
    expect(() =>
      decodeDisbandTerminalIntent(
        new TextEncoder().encode('{"version":1,"registryState":"xx"}'),
      ),
    ).toThrow();
  });

  it("fails closed on unknown, corrupt, and semantically invalid records", () => {
    const encoder = new TextEncoder();
    expect(() => decodeDisbandTombstone(encoder.encode("not-json"))).toThrow();
    expect(() =>
      decodeDisbandTombstone(
        encoder.encode(
          JSON.stringify({
            version: 2,
            groupId: "010203",
            selectedEpoch: 7,
            commitDigest: "04".repeat(32),
            actorPubkey: "a".repeat(64),
            notificationState: "pending",
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeDisbandTombstone(
        encoder.encode(
          JSON.stringify({
            version: 1,
            groupId: "010203",
            selectedEpoch: -1,
            commitDigest: "04",
            actorPubkey: "not-a-pubkey",
            notificationState: "pending",
          }),
        ),
      ),
    ).toThrow();
  });
});

async function fixture() {
  const account = testAccount(6);
  const pubkey = account.pubkey;
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const kp = await generateKeyPackage({
    credential: createCredential(pubkey),
    ciphersuiteImpl: impl,
    signer: account.signer,
  });
  const { clientState } = await createSimpleGroup(kp, impl, "terminal", {
    adminPubkeys: [pubkey],
    relays: ["wss://relay.test"],
  });
  const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
  const store = new InMemoryKeyValueStore<Uint8Array>();
  const network = new MockNetwork(["wss://relay.test"]);
  const group = new MarmotGroup(clientState, {
    store,
    lifecycleStore,
    signer: account.signer,
    ciphersuite: impl,
    network,
  });
  return { group, lifecycleStore, store, network, pubkey, account };
}

describe("public disband terminal contract", () => {
  it.each(["before", "after"] as const)(
    "records a consumed callback attempt across a notification write crash %s forwarding",
    async (forwarding) => {
      const { group, store, lifecycleStore, network, account, pubkey } =
        await fixture();
      await group.session.persistSelectedDisband({
        actorPubkey: pubkey,
        commitDigest: COMMIT_DIGEST,
        parentTag: "parent",
        sourceEpoch: 0,
        terminalOutcome: "disbanded",
      });
      const write = lifecycleStore.setItem.bind(lifecycleStore);
      let armed = true;
      const fault = vi
        .spyOn(lifecycleStore, "setItem")
        .mockImplementation(async (key, value) => {
          const hit =
            armed &&
            key.endsWith("/disband/terminal") &&
            decodeDisbandTombstone(value).notificationState === "delivered";
          if (hit && forwarding === "before") {
            armed = false;
            throw new Error("notification crash");
          }
          const result = await write(key, value);
          if (hit) {
            armed = false;
            throw new Error("notification crash");
          }
          return result;
        });
      const liveCallback = vi.fn();
      group.on("disbanded", liveCallback);
      await expect(group.realizeDisbandIfNeeded()).rejects.toThrow(
        "notification crash",
      );
      expect(liveCallback).not.toHaveBeenCalled();
      fault.mockRestore();
      group.dispose();
      for (let restart = 0; restart < 2; restart++) {
        const restored = new MarmotGroup(group.state, {
          store,
          lifecycleStore,
          network,
          signer: account.signer,
          ciphersuite: group.ciphersuite,
        });
        const callback = vi.fn();
        restored.on("disbanded", callback);
        await restored.session.hydrateLifecycleEvidence();
        await restored.realizeDisbandIfNeeded();
        expect(restored.status).toBe("disbanded");
        expect(callback).toHaveBeenCalledTimes(
          restart === 0 && forwarding === "before" ? 1 : 0,
        );
        restored.dispose();
      }
    },
  );

  it("keeps the public direct persistence store requirement", async () => {
    const { group, options, evidence } = await (async () => {
      const { group, store, network, account, pubkey } = await fixture();
      return {
        group,
        options: {
          store,
          network,
          signer: account.signer,
          ciphersuite: group.ciphersuite,
        },
        evidence: {
          actorPubkey: pubkey,
          commitDigest: COMMIT_DIGEST,
          parentTag: "parent",
          sourceEpoch: 0,
          terminalOutcome: "disbanded" as const,
        },
      };
    })();
    const withoutStore = new MarmotGroup(group.state, options);
    await expect(
      withoutStore.session.persistSelectedDisband(evidence),
    ).rejects.toThrow("Selected disband requires a lifecycle store");
    expect(withoutStore.status).toBe("active");
    withoutStore.dispose();
    group.dispose();
  });

  it.each(["absent", "first-tombstone-failure"] as const)(
    "WR-02: internally selects disband with %s optional lifecycle storage",
    async (mode) => {
      const f = await peers();
      const network = new MockNetwork(["wss://relay.test"]);
      const author = new MarmotGroup(f.adminState, {
        store: new InMemoryKeyValueStore<Uint8Array>(),
        lifecycleStore: new InMemoryKeyValueStore<Uint8Array>(),
        signer: f.admin.signer,
        ciphersuite: f.impl,
        network,
      });
      const candidate = await author.session.requestDisband();
      const lifecycleStore =
        mode === "absent" ? undefined : new InMemoryKeyValueStore<Uint8Array>();
      let failures = 0;
      if (lifecycleStore) {
        const write = lifecycleStore.setItem.bind(lifecycleStore);
        vi.spyOn(lifecycleStore, "setItem").mockImplementation(
          async (key, bytes) => {
            if (key.endsWith("/disband/terminal") && failures++ === 0)
              throw new Error("first tombstone crash");
            return write(key, bytes);
          },
        );
      }
      let now = 0;
      const observedGroup = new MarmotGroup(f.memberState, {
        ciphersuite: f.impl,
        store: new InMemoryKeyValueStore<Uint8Array>(),
        lifecycleStore,
        signer: f.member.signer,
        network,
        now: () => now,
        settlementQuiescenceMs: 1,
        scheduler: { setTimer: () => 0, clearTimer: () => {} },
      });
      const observer = observedGroup.session;
      observedGroup.on("stateChanged", () =>
        expect(observedGroup.status).toBe("disbanded"),
      );
      const removed = vi.fn(),
        disbanded = vi.fn();
      observedGroup.on("removed", removed);
      observedGroup.on("disbanded", disbanded);
      const admitted = [];
      for await (const result of observer.ingest([
        candidate.publish[0].envelope,
      ]))
        admitted.push(result);
      expect(observer.lifecycle).toBe("Recovering");
      now = 1;
      await observer.driveConvergence();
      expect(observer.terminalTombstone?.actorPubkey).toBe(f.admin.pubkey);
      expect(observer.lifecycle).toBe("Disbanded");
      if (lifecycleStore) {
        expect(
          await lifecycleStore.getItem(`${author.idStr}/disband/terminal`),
        ).toBeNull();
        for await (const _ of observer.ingest([])) {
          /* fully drain retry */
        }
        expect(
          await lifecycleStore.getItem(`${author.idStr}/disband/terminal`),
        ).not.toBeNull();
      }
      for await (const _ of observedGroup.ingest([])) {
        /* fully drain terminal facade activation */
      }
      expect(disbanded).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();
      await expect(observedGroup.selfUpdate()).rejects.toBeInstanceOf(
        GroupTerminalError,
      );
      author.dispose();
      observedGroup.dispose();
    },
  );

  it("WR-01: malformed cosmetic metadata cannot elect a non-admin to commit an admin departure", async () => {
    const f = await peers();
    for (const state of [f.adminState, f.memberState])
      state.groupContext.extensions = state.groupContext.extensions.map(
        (extension) => {
          const dictionary = getAppDataDictionary([extension]);
          return dictionary
            ? makeAppDataDictionaryExtension(
                dictionary.map((entry) =>
                  entry.componentId === GROUP_PROFILE_COMPONENT_ID
                    ? { ...entry, data: new Uint8Array([255]) }
                    : entry,
                ),
              )
            : extension;
        },
      );
    const store = new InMemoryKeyValueStore<Uint8Array>();
    const observer = new GroupSession({
      state: f.memberState,
      ciphersuite: f.impl,
      store,
    });
    // An active admin's SelfRemove is refused before sending, so build it
    // directly: the observer must neither stage it nor commit it.
    const { message } = await createProposal({
      context: {
        cipherSuite: f.impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: f.adminState,
      wireAsPublicMessage: true,
      proposal: { proposalType: selfRemoveProposalType },
    });
    const envelope = await createGroupEvent({
      message,
      state: f.adminState,
      ciphersuite: f.impl,
    });
    const results = [];
    for await (const result of observer.ingest([envelope]))
      results.push(result);
    expect(results.some((r) => r.kind === "autoCommit")).toBe(false);
    expect(Object.keys(observer.state.unappliedProposals)).toHaveLength(0);
    observer.dispose();
  });

  it.each([false, true])(
    "WR-01: peer self-removal fully drains with pending disband publish failure=%s",
    async (publishFailure) => {
      const f = await peers();
      const store = new InMemoryKeyValueStore<Uint8Array>();
      const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
      const network = new MockNetwork(["wss://relay.test"]);
      const group = new MarmotGroup(f.adminState, {
        store,
        lifecycleStore,
        network,
        signer: f.admin.signer,
        ciphersuite: f.impl,
      });
      const leaver = new GroupSession({
        state: f.memberState,
        ciphersuite: f.impl,
        store: new InMemoryKeyValueStore<Uint8Array>(),
      });
      if (publishFailure) {
        // An explicit rejecting OK is a definitive failure. A thrown adapter
        // error is now ACK-uncertain and correctly keeps PendingPublish.
        vi.spyOn(network, "publish").mockResolvedValueOnce({
          "wss://relay.test": {
            from: "wss://relay.test",
            ok: false,
            message: "blocked",
          },
        });
        expect(await group.disband()).toMatchObject({ kind: "publishFailed" });
        expect((await group.session.disbandRequest())?.status).toBe("pending");
      }
      const proposal = await leaver.leave(f.member.pubkey);
      const results = [];
      for await (const result of group.ingest([proposal.publish[0].envelope]))
        results.push(result);
      expect(results.some((r) => r.kind === "processed")).toBe(true);
      expect(results.some((r) => r.kind === "autoCommit")).toBe(
        !publishFailure,
      );
      const durable = deserializeClientState(
        (await store.getItem(group.idStr))!,
      );
      expect(durable.groupContext.epoch).toBe(group.state.groupContext.epoch);
      if (publishFailure)
        expect(Object.keys(durable.unappliedProposals)).toHaveLength(1);
      else expect(durable.groupContext.epoch).toBe(2n);
      group.dispose();
      leaver.dispose();
    },
  );
  it("repairs a missing registry shell after the tombstone write and survives two restarts", async () => {
    const { group, lifecycleStore, store, network, pubkey, account } =
      await fixture();
    await group.save(true);
    let failShell = true;
    const faultStore = {
      getItem: (key: string) => lifecycleStore.getItem(key),
      setItem: async (key: string, value: Uint8Array) => {
        if (failShell && key.endsWith("/disband/registry-state")) {
          failShell = false;
          throw new Error("injected registry shell crash");
        }
        return lifecycleStore.setItem(key, value);
      },
      removeItem: (key: string) => lifecycleStore.removeItem(key),
      clear: () => lifecycleStore.clear(),
      keys: () => lifecycleStore.keys(),
    };
    const crashing = new MarmotGroup(group.state, {
      store,
      lifecycleStore: faultStore,
      signer: account.signer,
      ciphersuite: group.ciphersuite,
      network,
    });
    await expect(
      crashing.session.persistSelectedDisband({
        actorPubkey: pubkey,
        commitDigest: COMMIT_DIGEST,
        parentTag: "parent",
        sourceEpoch: 0,
        terminalOutcome: "disbanded",
      }),
    ).rejects.toThrow("injected registry shell crash");

    const options = {
      store,
      ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
      lifecycleStore,
      signer: account.signer,
      network,
    };
    const first = new GroupRegistry(options);
    expect((await first.get(group.id)).status).toBe("disbanded");
    first.untrack(group.id);
    const second = new GroupRegistry(options);
    expect((await second.get(group.id)).status).toBe("disbanded");
  });

  it("discovers and loads a scrubbed terminal facade after live-state cleanup", async () => {
    const { group, lifecycleStore, store, network, pubkey, account } =
      await fixture();
    await group.session.persistSelectedDisband({
      actorPubkey: pubkey,
      commitDigest: COMMIT_DIGEST,
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });
    expect(await store.getItem(group.idStr)).toBeNull();

    const registry = new GroupRegistry({
      store,
      ingestStateStore: new InMemoryKeyValueStore<Uint8Array>(),
      lifecycleStore,
      signer: account.signer,
      network,
    });
    expect((await registry.listIds()).map(bytesToHex)).toContain(group.idStr);
    expect(await registry.has(group.id)).toBe(true);
    const restored = await registry.get(group.id);
    expect(restored.status).toBe("disbanded");
    expect(restored.groupData).toBeNull();
    expect(await registry.has(group.id)).toBe(true);
    await expect(restored.selfUpdate()).rejects.toBeInstanceOf(
      GroupTerminalError,
    );
  });

  it("records delivery before emitting once and rejects every outbound intent", async () => {
    const { group, pubkey } = await fixture();
    const digest = new Uint8Array(32).fill(7);
    const seen = vi.fn(() => {
      expect(group.status).toBe("disbanded");
      throw new Error("application callback failure");
    });
    group.on("disbanded", seen);

    await group.session.persistSelectedDisband({
      actorPubkey: pubkey,
      commitDigest: digest,
      parentTag: "parent",
      sourceEpoch: 0,
      terminalOutcome: "disbanded",
    });
    await Promise.all([
      group.realizeDisbandIfNeeded(),
      group.realizeDisbandIfNeeded(),
    ]);
    await group.realizeDisbandIfNeeded();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(group, {
      actorPubkey: pubkey,
      commitDigest: digest,
    });
    await expect(
      group.submitIntent({
        kind: "applicationMessage",
        payload: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ reason: "group_disbanded" });
    await expect(group.selfUpdate()).rejects.toBeInstanceOf(GroupTerminalError);
    await expect(group.enableDisbanding()).rejects.toMatchObject({
      reason: "group_disbanded",
    });
    await expect(group.disband()).rejects.toMatchObject({
      reason: "group_disbanded",
    });
  });
});
