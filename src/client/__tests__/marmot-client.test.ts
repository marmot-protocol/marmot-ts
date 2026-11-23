import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotClient } from "../marmot-client.js";
import { getMarmotGroupView } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import type { MarmotDatabase } from "../storage/database/types.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";

const CIPHERSUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519" as const;

describe("admin pubkey deduplication — createSimpleGroup", () => {
  it("deduplicates exact duplicate pubkeys passed in adminPubkeys", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const account = testAccount(6);
    const pubkey = account.pubkey;
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: account.signer,
    });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [pubkey, pubkey, pubkey],
    });

    const groupData = getMarmotGroupView(clientState);
    expect(groupData).toBeTruthy();
    // Each pubkey should appear exactly once
    const seen = new Set(groupData!.adminPubkeys);
    expect(seen.size).toBe(groupData!.adminPubkeys.length);
    expect(groupData!.adminPubkeys.filter((k) => k === pubkey).length).toBe(1);
  });

  it("deduplicates when multiple distinct pubkeys have some duplicates", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const aliceAccount = testAccount(6);
    const alice = aliceAccount.pubkey;
    const bob = "b".repeat(64);
    const credential = createCredential(alice);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: aliceAccount.signer,
    });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [alice, bob, alice, bob, "c".repeat(64)],
    });

    const groupData = getMarmotGroupView(clientState);
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
    const account = testAccount(6);
    const pubkey = account.pubkey;
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: account.signer,
    });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [pubkey],
    });

    const groupData = getMarmotGroupView(clientState);
    expect(groupData).toBeTruthy();
    expect(groupData!.adminPubkeys).toEqual([pubkey]);
  });

  it("handles an empty adminPubkeys list without error", async () => {
    const impl = await getCiphersuiteImpl(CIPHERSUITE, defaultCryptoProvider);
    const account = testAccount(6);
    const pubkey = account.pubkey;
    const credential = createCredential(pubkey);
    const kp = await generateKeyPackage({
      credential,
      ciphersuiteImpl: impl,
      signer: account.signer,
    });

    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [],
    });

    const groupData = getMarmotGroupView(clientState);
    expect(groupData).toBeTruthy();
    // The creator is always an admin, so the set is never empty in v2.
    expect(groupData!.adminPubkeys).toEqual([pubkey]);
  });
});

describe("admin pubkey deduplication — MarmotClient.createGroup", () => {
  it("deduplicates when the caller re-passes the creator's own pubkey in adminPubkeys", async () => {
    const account = PrivateKeyAccount.generateNew();
    const creatorPubkey = await account.signer.getPublicKey();
    const mockNetwork = new MockNetwork();

    const client = new MarmotClient({
      database: memoryDatabase(),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.groups.create("Dedup Test", {
      // Creator is always prepended internally; passing it again should not duplicate it.
      adminPubkeys: [creatorPubkey],
      relays: ["wss://relay.example.com"],
    });

    const groupData = getMarmotGroupView(group.state);
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
      database: memoryDatabase(),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.groups.create("Dedup Test 2", {
      adminPubkeys: [creatorPubkey, otherAdmin, otherAdmin],
      relays: ["wss://relay.example.com"],
    });

    const groupData = getMarmotGroupView(group.state);
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
      database: memoryDatabase(),
      signer: account.signer,
      network: mockNetwork,
    });

    const group = await client.groups.create("No Extra Admins", {
      relays: ["wss://relay.example.com"],
    });

    const groupData = getMarmotGroupView(group.state);
    expect(groupData).toBeTruthy();
    expect(groupData!.adminPubkeys).toContain(creatorPubkey);
    // Still deduplicated (only one occurrence of the creator)
    expect(
      groupData!.adminPubkeys.filter((k) => k === creatorPubkey).length,
    ).toBe(1);
  });
});

describe("MarmotClient lifecycle persistence", () => {
  /** Writes a group-scoped record through the session and reads it at the root. */
  async function expectLifecycleWrite(
    group: Awaited<ReturnType<MarmotClient["groups"]["create"]>>,
    database: MarmotDatabase,
  ) {
    const stored = await database.groups.open(group.idStr);
    expect(await stored.meta.get("state")).toBeDefined();
    const marker = new Uint8Array([1, 2, 3]);
    await group.session.meta.set("removed", marker);
    expect(await stored.meta.get("removed")).toEqual(marker);
    await group.session.meta.delete("removed");
  }

  it("threads the client storage through create, import, and load", async () => {
    const account = PrivateKeyAccount.generateNew();
    const storage = memoryDatabase();
    const makeClient = (backend: MarmotDatabase) =>
      new MarmotClient({
        database: backend,
        signer: account.signer,
        network: new MockNetwork(),
      });

    const writer = makeClient(storage);
    const created = await writer.groups.create("Lifecycle create", {
      relays: ["wss://relay.example.com"],
    });
    await expectLifecycleWrite(created, storage);

    const reader = makeClient(storage);
    const [loaded, concurrent] = await Promise.all([
      reader.groups.get(created.id),
      reader.groups.get(created.id),
    ]);
    expect(loaded).toBe(concurrent);
    await expectLifecycleWrite(loaded, storage);

    const importStorage = memoryDatabase();
    const imported = await makeClient(importStorage).groups.import(
      created.state,
    );
    await expectLifecycleWrite(imported, importStorage);
  });
});
