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
import { KEY_PACKAGE_KIND, WELCOME_EVENT_KIND } from "../protocol.js";
import {
  getWelcome,
  readWelcomeGroupInfo,
  readWelcomeMarmotGroupData,
} from "../welcome.js";
import { KeyPackageStore } from "../../store/key-package-store.js";
import { KeyValueGroupStateBackend } from "../../store/adapters/key-value-group-state-backend.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { MemoryBackend } from "../../__tests__/helpers/memory-backend.js";

// ---------------------------------------------------------------------------
// spec compliance (MIP-02)
// ---------------------------------------------------------------------------

describe("spec compliance (MIP-02)", () => {
  it("should reject decoding kind 444 events that are missing an encoding=base64 tag", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "00",
      tags: [],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/encoding=base64 tag/i);
  });

  it("should reject decoding kind 444 events with encoding=hex", () => {
    const event: NostrEvent = {
      kind: WELCOME_EVENT_KIND,
      pubkey: "0".repeat(64),
      created_at: 1,
      content: "00",
      tags: [["encoding", "hex"]],
      id: "0".repeat(64),
      sig: "0".repeat(128),
    };

    expect(() => getWelcome(event)).toThrow(/encoding=base64 tag/i);
  });
});

// ---------------------------------------------------------------------------
// readWelcomeGroupInfo / readWelcomeMarmotGroupData
// ---------------------------------------------------------------------------

describe("readWelcomeGroupInfo / readWelcomeMarmotGroupData", () => {
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
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: adminAccount.signer,
      network: mockNetwork,
    });
  });

  async function setupWelcomeRumor(groupName: string, groupRelays: string[]) {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Invitee generates a key package
    const inviteeKeyPackage = await generateKeyPackage({
      credential: createCredential(inviteePubkey),
      ciphersuiteImpl: ciphersuite,
    });

    // Publish invitee key package event to the mock network
    const keyPackageEvent = await inviteeAccount.signer.signEvent(
      await createKeyPackageEvent({
        keyPackage: inviteeKeyPackage.publicPackage,
        relays: groupRelays,
      }),
    );
    await mockNetwork.publish(groupRelays, keyPackageEvent);

    // Admin creates group
    const adminGroup = await adminClient.createGroup(groupName, {
      adminPubkeys: [adminPubkey],
      relays: groupRelays,
    });

    // Admin invites invitee
    const [keyPackageNostrEvent] = await mockNetwork.request(groupRelays, {
      kinds: [KEY_PACKAGE_KIND],
      authors: [inviteePubkey],
    });
    await adminGroup.inviteByKeyPackageEvent(keyPackageNostrEvent);

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

  it("reads MarmotGroupData from a welcome rumor without joining the group", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const groupRelays = ["wss://mock-relay.test"];
    const groupName = "Read-Before-Join Group";

    const { welcomeRumor, inviteeKeyPackage } = await setupWelcomeRumor(
      groupName,
      groupRelays,
    );

    const groupData = await readWelcomeMarmotGroupData({
      welcome: welcomeRumor,
      keyPackage: inviteeKeyPackage,
      ciphersuiteImpl: ciphersuite,
    });

    expect(groupData).not.toBeNull();
    expect(groupData!.name).toBe(groupName);
    expect(groupData!.relays).toEqual(groupRelays);
    expect(groupData!.adminPubkeys).toContain(adminPubkey);
    // nostrGroupId is a 32-byte array
    expect(groupData!.nostrGroupId.length).toBe(32);
  });

  it("accepts a decoded Welcome object in addition to a Rumor", async () => {
    const groupRelays = ["wss://mock-relay.test"];
    const { welcomeRumor, inviteeKeyPackage } = await setupWelcomeRumor(
      "Decoded Welcome Test",
      groupRelays,
    );

    // Pass the decoded Welcome directly instead of the Rumor
    const decodedWelcome = getWelcome(welcomeRumor);

    const groupData = await readWelcomeMarmotGroupData({
      welcome: decodedWelcome,
      keyPackage: inviteeKeyPackage,
      ciphersuiteImpl: ciphersuite,
    });

    expect(groupData).not.toBeNull();
    expect(groupData!.name).toBe("Decoded Welcome Test");
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
