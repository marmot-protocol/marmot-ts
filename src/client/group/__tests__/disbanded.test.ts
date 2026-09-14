import { bytesToHex } from "@noble/hashes/utils.js";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
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
} from "../../../engine/disband-tombstone.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";

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
    await group.realizeDisbandIfNeeded();
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
