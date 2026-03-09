import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotClient } from "../marmot-client.js";
import { extractMarmotGroupData } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { KeyValueGroupStateBackend } from "../../store/adapters/key-value-group-state-backend.js";
import { KeyPackageStore } from "../../store/key-package-store.js";
import { MemoryBackend } from "../../__tests__/helpers/memory-backend.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";

const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

describe("admin pubkey deduplication — createSimpleGroup", () => {
  it("deduplicates exact duplicate pubkeys passed in adminPubkeys", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const pubkey = "a".repeat(64);
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [pubkey, pubkey, pubkey],
    });

    const groupData = extractMarmotGroupData(clientState);
    expect(groupData).toBeTruthy();
    // Each pubkey should appear exactly once
    const seen = new Set(groupData!.adminPubkeys);
    expect(seen.size).toBe(groupData!.adminPubkeys.length);
    expect(groupData!.adminPubkeys.filter((k) => k === pubkey).length).toBe(1);
  });

  it("deduplicates when multiple distinct pubkeys have some duplicates", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    const credential = createCredential(alice);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [alice, bob, alice, bob, "c".repeat(64)],
    });

    const groupData = extractMarmotGroupData(clientState);
    expect(groupData).toBeTruthy();
    const keys = groupData!.adminPubkeys;
    // No duplicates
    expect(new Set(keys).size).toBe(keys.length);
    // All three unique keys are present
    expect(keys).toContain(alice);
    expect(keys).toContain(bob);
    expect(keys).toContain("c".repeat(64));
  });

  it("preserves a single pubkey without modification", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const pubkey = "a".repeat(64);
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [pubkey],
    });

    const groupData = extractMarmotGroupData(clientState);
    expect(groupData).toBeTruthy();
    expect(groupData!.adminPubkeys).toEqual([pubkey]);
  });

  it("handles an empty adminPubkeys list without error", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const pubkey = "a".repeat(64);
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [],
    });

    const groupData = extractMarmotGroupData(clientState);
    expect(groupData).toBeTruthy();
    expect(groupData!.adminPubkeys).toEqual([]);
  });
});

describe("admin pubkey deduplication — MarmotClient.createGroup", () => {
  it("deduplicates when the caller re-passes the creator's own pubkey in adminPubkeys", async () => {
    const account = PrivateKeyAccount.generateNew();
    const creatorPubkey = await account.signer.getPublicKey();
    const mockNetwork = new MockNetwork();

    const client = new MarmotClient({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.createGroup("Dedup Test", {
      // Creator is always prepended internally; passing it again should not duplicate it.
      adminPubkeys: [creatorPubkey],
      relays: ["wss://relay.example.com"],
    });

    const groupData = extractMarmotGroupData(group.state);
    expect(groupData).toBeTruthy();
    const creatorOccurrences = groupData!.adminPubkeys.filter(
      (k) => k === creatorPubkey,
    ).length;
    expect(creatorOccurrences).toBe(1);
  });

  it("deduplicates extra pubkeys passed alongside a duplicate creator pubkey", async () => {
    const account = PrivateKeyAccount.generateNew();
    const creatorPubkey = await account.signer.getPublicKey();
    const otherAdmin = "b".repeat(64);
    const mockNetwork = new MockNetwork();

    const client = new MarmotClient({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.createGroup("Dedup Test 2", {
      adminPubkeys: [creatorPubkey, otherAdmin, otherAdmin],
      relays: ["wss://relay.example.com"],
    });

    const groupData = extractMarmotGroupData(group.state);
    expect(groupData).toBeTruthy();
    const keys = groupData!.adminPubkeys;
    // No duplicates
    expect(new Set(keys).size).toBe(keys.length);
    // Both unique keys present
    expect(keys).toContain(creatorPubkey);
    expect(keys).toContain(otherAdmin);
  });

  it("retains creator pubkey even when adminPubkeys is omitted", async () => {
    const account = PrivateKeyAccount.generateNew();
    const creatorPubkey = await account.signer.getPublicKey();
    const mockNetwork = new MockNetwork();

    const client = new MarmotClient({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.createGroup("No Extra Admins", {
      relays: ["wss://relay.example.com"],
    });

    const groupData = extractMarmotGroupData(group.state);
    expect(groupData).toBeTruthy();
    expect(groupData!.adminPubkeys).toContain(creatorPubkey);
    // Still deduplicated (only one occurrence of the creator)
    expect(
      groupData!.adminPubkeys.filter((k) => k === creatorPubkey).length,
    ).toBe(1);
  });
});
