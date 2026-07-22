import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import type { CiphersuiteImpl } from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { MarmotClient } from "../../client/marmot-client.js";
import { createCredential } from "../credential.js";
import { generateKeyPackage } from "../key-package.js";
import { createKeyPackageEvent } from "../key-package-event.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  WELCOME_EVENT_KIND,
} from "../protocol.js";
import {
  getWelcome,
  readWelcomeGroupInfo,
  readWelcomeMarmotGroupView,
} from "../welcome.js";
import type { StoredKeyPackage } from "../../client/key-package-manager.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { accountProofSignerFor } from "../../__tests__/helpers/account-proof.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

// ---------------------------------------------------------------------------
// spec compliance (welcome delivery)
// ---------------------------------------------------------------------------

describe("spec compliance (welcome delivery)", () => {
  const validRelays = ["relays", "wss://relay.example.com"];
  const validE = ["e", "a".repeat(64)];

  it("rejects a kind 444 rumor missing the e tag", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validRelays],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/e tag/i);
  });

  it("rejects a kind 444 rumor whose e tag is not a 32-byte hex id", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validRelays, ["e", "abc123"]],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/e tag/i);
  });

  it("rejects a kind 444 rumor missing the relays tag", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validE],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/relays/i);
  });

  it("rejects a kind 444 rumor whose relays tag is empty", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [["relays"], validE],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/relays/i);
  });

  it("does not require an encoding tag (spec forbids it)", () => {
    // A well-formed envelope with no encoding tag passes transport validation
    // and fails only later, on MLS decode of the (here garbage) content.
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validRelays, validE],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).not.toThrow(/encoding|e tag|relays/i);
  });

  it("rejects a kind 444 rumor carrying two e tags (#236 singleton cardinality)", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validRelays, validE, ["e", "b".repeat(64)]],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/e tag/i);
  });

  it("rejects a kind 444 rumor whose relays tag is repeated (#236 list cardinality)", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [validRelays, ["relays", "wss://other.example.com"], validE],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/relays/i);
  });

  it("rejects a kind 444 rumor whose relays tag carries duplicate URLs (#236 list cardinality)", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "AAAA",
      tags: [
        ["relays", "wss://relay.example.com", "wss://relay.example.com"],
        validE,
      ],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/relays/i);
  });
});

// ---------------------------------------------------------------------------
// readWelcomeGroupInfo / readWelcomeMarmotGroupView
// ---------------------------------------------------------------------------

describe("readWelcomeGroupInfo / readWelcomeMarmotGroupView", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccount: PrivateKeyAccount<any>;
  let ciphersuite: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;

  beforeEach(async () => {
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccount = PrivateKeyAccount.generateNew();

    ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );

    mockNetwork = new MockNetwork();

    adminClient = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore(),
      keyPackageStore: new InMemoryKeyValueStore(),
      signer: adminAccount.signer,
      accountProofSigner: accountProofSignerFor(adminAccount),
      network: mockNetwork,
    });
  });

  async function setupWelcomeRumor(groupName: string, groupRelays: string[]) {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Invitee generates a key package carrying its account identity proof
    const inviteeKeyPackage = await generateKeyPackage({
      credential: createCredential(inviteePubkey),
      ciphersuiteImpl: ciphersuite,
      accountProofSigner: accountProofSignerFor(inviteeAccount),
    });

    // Publish invitee key package event to the mock network
    const keyPackageEvent = await inviteeAccount.signer.signEvent(
      await createKeyPackageEvent({
        keyPackage: inviteeKeyPackage.publicPackage,
        identifier: inviteePubkey,
        relays: groupRelays,
      }),
    );
    await mockNetwork.publish(groupRelays, keyPackageEvent);

    // Admin creates group
    const adminGroup = await adminClient.groups.create(groupName, {
      adminPubkeys: [adminPubkey],
      relays: groupRelays,
    });

    // Admin invites invitee
    const [keyPackageNostrEvent] = await mockNetwork.request(groupRelays, {
      kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
      authors: [inviteePubkey],
    });
    await adminClient.groups.invite(adminGroup.id, keyPackageNostrEvent);

    // Fetch and unwrap the gift wrap sent to the invitee
    const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    expect(giftWraps.length).toBe(1);

    const welcomeRumor = await unlockGiftWrap(
      giftWraps[0],
      inviteeAccount.signer,
    );
    expect(welcomeRumor.kind).toBe(WELCOME_EVENT_KIND);

    return { welcomeRumor, inviteeKeyPackage, adminGroup, adminPubkey };
  }

  it("reads GroupInfo from a welcome rumor without joining the group", async () => {
    const groupRelays = ["wss://mock-relay.test"];
    const { welcomeRumor, inviteeKeyPackage } = await setupWelcomeRumor(
      "My Test Group",
      groupRelays,
    );

    const groupInfo = await readWelcomeGroupInfo({
      welcome: welcomeRumor,
      keyPackage: inviteeKeyPackage,
      ciphersuiteImpl: ciphersuite,
    });

    expect(groupInfo).toBeDefined();
    expect(groupInfo.groupContext).toBeDefined();
    // groupId is a non-empty byte array
    expect(groupInfo.groupContext.groupId.length).toBeGreaterThan(0);
    // epoch starts at 1 because the admin's invite commit advanced it
    expect(groupInfo.groupContext.epoch).toBeGreaterThanOrEqual(1n);
    // extensions are present
    expect(groupInfo.groupContext.extensions.length).toBeGreaterThan(0);
  });

  it("reads MarmotGroupView from a welcome rumor without joining the group", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const groupRelays = ["wss://mock-relay.test"];
    const groupName = "Read-Before-Join Group";

    const { welcomeRumor, inviteeKeyPackage } = await setupWelcomeRumor(
      groupName,
      groupRelays,
    );

    const groupView = await readWelcomeMarmotGroupView({
      welcome: welcomeRumor,
      keyPackage: inviteeKeyPackage,
      ciphersuiteImpl: ciphersuite,
    });

    expect(groupView).not.toBeNull();
    expect(groupView!.name).toBe(groupName);
    expect(groupView!.relays).toEqual(groupRelays);
    expect(groupView!.adminPubkeys).toContain(adminPubkey);
    // nostrGroupId is a 32-byte array
    expect(groupView!.nostrGroupId!.length).toBe(32);
  });

  it("accepts a decoded Welcome object in addition to a Rumor", async () => {
    const groupRelays = ["wss://mock-relay.test"];
    const { welcomeRumor, inviteeKeyPackage } = await setupWelcomeRumor(
      "Decoded Welcome Test",
      groupRelays,
    );

    // Pass the decoded Welcome directly instead of the Rumor
    const decodedWelcome = getWelcome(welcomeRumor);

    const groupView = await readWelcomeMarmotGroupView({
      welcome: decodedWelcome,
      keyPackage: inviteeKeyPackage,
      ciphersuiteImpl: ciphersuite,
    });

    expect(groupView).not.toBeNull();
    expect(groupView!.name).toBe("Decoded Welcome Test");
  });

  it("throws when the key package does not match the welcome", async () => {
    const groupRelays = ["wss://mock-relay.test"];
    const { welcomeRumor } = await setupWelcomeRumor(
      "Mismatch Test",
      groupRelays,
    );

    // Generate a completely different (unrelated) key package
    const otherPubkey =
      await PrivateKeyAccount.generateNew().signer.getPublicKey();
    const wrongKeyPackage = await generateKeyPackage({
      credential: createCredential(otherPubkey),
      ciphersuiteImpl: ciphersuite,
    });

    await expect(
      readWelcomeGroupInfo({
        welcome: welcomeRumor,
        keyPackage: wrongKeyPackage,
        ciphersuiteImpl: ciphersuite,
      }),
    ).rejects.toThrow("Failed to decrypt group secrets");
  });
});
