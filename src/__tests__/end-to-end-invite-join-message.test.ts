import { bytesToHex } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { Rumor, unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import { getEventHash, type NostrEvent } from "nostr-tools";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { MarmotClient } from "../client/marmot-client";
import {
  defaultMarmotClientConfig,
  extractMarmotGroupData,
} from "../core/client-state";
import { createCredential } from "../core/credential";
import { deserializeApplicationRumor } from "../core/group-message";
import { generateKeyPackage } from "../core/key-package";
import { createKeyPackageEvent } from "../core/key-package-event";
import {
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
  WELCOME_EVENT_KIND,
} from "../core/protocol";
import { KeyPackageStore } from "../store/key-package-store";
import { GroupStateStore } from "../store/group-state-store";
import { KeyValueGroupStateBackend } from "../store/adapters/key-value-group-state-backend";
import { unixNow } from "../utils/nostr";
import { MockNetwork } from "./helpers/mock-network";
import { MemoryBackend } from "./ingest-commit-race.test";

// NOTE: we use the shared test helper MockNetwork, not an inline version.

// ============================================================================
// Test Setup
// ============================================================================

describe("End-to-end: invite, join, first message", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccount: PrivateKeyAccount<any>;
  let ciphersuite: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;
  let inviteeClient: MarmotClient;

  beforeEach(async () => {
    // Create real accounts
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccount = PrivateKeyAccount.generateNew();

    // Initialize ciphersuite
    ciphersuite = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    // Create mock network
    mockNetwork = new MockNetwork();

    // Create clients using the new bytes-first API
    const groupStateBackend = new KeyValueGroupStateBackend(
      new MemoryBackend(),
    );
    const keyPackageStore = new KeyPackageStore(new MemoryBackend());

    adminClient = new MarmotClient({
      groupStateBackend,
      keyPackageStore,
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    inviteeClient = new MarmotClient({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: inviteeAccount.signer,
      network: mockNetwork,
    });
  });

  it("admin invites invitee, invitee joins and sends first message", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Step 1: Invitee generates and stores KeyPackage, then publishes event
    const inviteeCredential = createCredential(inviteePubkey);
    const inviteeKeyPackage = await generateKeyPackage({
      credential: inviteeCredential,
      ciphersuiteImpl: ciphersuite,
    });

    // Store the KeyPackage in invitee's local store (required for joinGroupFromWelcome)
    await inviteeClient.keyPackageStore.add(inviteeKeyPackage);

    const unsignedKeyPackageEvent = createKeyPackageEvent({
      keyPackage: inviteeKeyPackage.publicPackage,
      pubkey: inviteePubkey,
      relays: ["wss://mock-relay.test"],
    });

    // Sign the event
    const signedKeyPackageEvent: NostrEvent =
      await inviteeAccount.signer.signEvent(unsignedKeyPackageEvent);

    await mockNetwork.publish(["wss://mock-relay.test"], signedKeyPackageEvent);

    // Step 2: Admin creates group
    const adminGroup = await adminClient.createGroup("Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://mock-relay.test"],
    });

    // Step 3: Admin invites invitee
    // First, fetch the invitee's KeyPackage event
    const keyPackageEvents = await mockNetwork.request(
      ["wss://mock-relay.test"],
      {
        kinds: [KEY_PACKAGE_KIND],
        authors: [inviteePubkey],
      },
    );
    expect(keyPackageEvents.length).toBe(1);

    // Invite using the KeyPackage event
    await adminGroup.inviteByKeyPackageEvent(keyPackageEvents[0]);

    // Verify invite produced BOTH:
    // - group commit event (kind 445) published to group relays
    // - welcome giftwrap (kind 1059) published to invitee inbox relays
    // And that they were published in the required order (commit before welcome).
    const commitIndex = mockNetwork.events.findIndex(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    const giftwrapIndex = mockNetwork.events.findIndex((e) => e.kind === 1059);
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(giftwrapIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeLessThan(giftwrapIndex);

    // Step 4: Invitee receives Welcome and joins
    // Fetch gift wraps for invitee (filter by recipient pubkey in p tag, not author)
    const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    expect(giftWraps.length).toBe(1);

    // Unwrap the gift wrap
    const welcomeRumor = await unlockGiftWrap(
      giftWraps[0],
      inviteeAccount.signer,
    );
    expect(welcomeRumor.kind).toBe(WELCOME_EVENT_KIND);

    // Get the keyPackageEventId from the rumor tags
    const keyPackageEventId = welcomeRumor.tags.find((t) => t[0] === "e")?.[1];
    expect(keyPackageEventId).toBe(signedKeyPackageEvent.id);

    // Join the group
    const inviteeGroup = await inviteeClient.joinGroupFromWelcome({
      welcomeRumor,
      keyPackageEventId,
    });

    // Step 5: Invitee ingests group events to catch up
    // Extract nostr group ID from extensions
    const marmotGroupData = extractMarmotGroupData(adminGroup.state);
    if (!marmotGroupData) {
      throw new Error("Marmot Group Data extension not found");
    }
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);
    const groupEvents = await mockNetwork.request(["wss://mock-relay.test"], {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    });

    // NOTE: joining from Welcome yields a state that already includes the
    // invite commit. Ingesting the backlog should be a no-op (but must not
    // regress state or throw).
    const inviteeEpochBeforeCatchup = inviteeGroup.state.groupContext.epoch;
    for await (const _ of inviteeGroup.ingest(groupEvents)) {
      // Drain iterator
    }
    expect(inviteeGroup.state.groupContext.epoch).toBe(
      inviteeEpochBeforeCatchup,
    );

    // Verify both clients are at the same epoch
    expect(inviteeGroup.state.groupContext.epoch).toBe(
      adminGroup.state.groupContext.epoch,
    );

    // Step 6: Invitee sends first message
    const messageContent = "Hello from invitee!";
    const messageRumor: Rumor = {
      id: "",
      kind: 9,
      pubkey: inviteePubkey,
      created_at: unixNow(),
      content: messageContent,
      tags: [],
    };
    messageRumor.id = getEventHash(messageRumor);

    await inviteeGroup.sendApplicationRumor(messageRumor);

    // Step 7: Admin receives and decrypts the message
    // Fetch new group events (the application message)
    const newGroupEvents = await mockNetwork.request(
      ["wss://mock-relay.test"],
      { kinds: [GROUP_EVENT_KIND], "#h": [nostrGroupIdHex] },
    );

    // Process the new events
    const receivedMessages: Rumor[] = [];
    for await (const result of adminGroup.ingest(newGroupEvents)) {
      if (result.kind === "applicationMessage") {
        const rumor = deserializeApplicationRumor(result.message);
        receivedMessages.push(rumor);
      }
    }

    // Verify the message was received and decrypted correctly
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].content).toBe(messageContent);
    expect(receivedMessages[0].pubkey).toBe(inviteePubkey);
  });
});
