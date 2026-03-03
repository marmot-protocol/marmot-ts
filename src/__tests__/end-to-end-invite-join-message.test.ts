import { bytesToHex } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { Rumor, unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import { getEventHash, type NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { MarmotClient } from "../client/marmot-client";
import { extractMarmotGroupData } from "../core/client-state";
import {
  GROUP_EVENT_KIND,
  KEY_PACKAGE_KIND,
  WELCOME_EVENT_KIND,
} from "../core/protocol";
import { KeyPackageStore } from "../store/key-package-store";
import { KeyValueGroupStateBackend } from "../store/adapters/key-value-group-state-backend";
import { unixNow } from "../utils/nostr";
import { MockNetwork } from "./helpers/mock-network";
import { MemoryBackend } from "./ingest-commit-race.test";
import { deserializeApplicationData } from "../core/group-message";

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
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
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

    // Step 1: Invitee creates and publishes a KeyPackage via the manager
    const inviteePkg = await inviteeClient.keyPackages.create({
      relays: ["wss://mock-relay.test"],
    });

    // Retrieve the published event so we can verify the event ID later
    const signedKeyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === KEY_PACKAGE_KIND,
    ) as NostrEvent;

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

    // Get the keyPackageEventId from the rumor tags — should match what was published
    const keyPackageEventId = welcomeRumor.tags.find((t) => t[0] === "e")?.[1];
    expect(keyPackageEventId).toBe(signedKeyPackageEvent.id);

    // Join the group — returns { group }
    const { group: inviteeGroup } = await inviteeClient.joinGroupFromWelcome({
      welcomeRumor,
    });

    // Invitee joins at the same epoch as admin (no automatic self-update).
    // MIP-02 self-update is the caller's responsibility.
    expect(inviteeGroup.state.groupContext.epoch).toBe(
      adminGroup.state.groupContext.epoch,
    );

    // The consumed key package is marked as used; private material is retained.
    // The caller can rotate it via client.keyPackages.rotate(ref) when ready.
    expect(await inviteeClient.keyPackages.count()).toBe(1);
    const listedPkgs = await inviteeClient.keyPackages.list();
    expect(listedPkgs.some((p) => p.used)).toBe(true);

    // The caller can now rotate the consumed key package to clean up relays
    expect(inviteePkg.keyPackageRef).toBeDefined();

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

    // Invitee ingests the group backlog (the invite commit). This should be a
    // no-op since joining from Welcome already incorporates that commit.
    const inviteeEpochBeforeCatchup = inviteeGroup.state.groupContext.epoch;
    for await (const _ of inviteeGroup.ingest(groupEvents)) {
      // Drain iterator
    }
    expect(inviteeGroup.state.groupContext.epoch).toBe(
      inviteeEpochBeforeCatchup,
    );

    // Both clients are already at the same epoch — no self-update was sent.
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
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        const rumor = deserializeApplicationData(result.result.message);
        receivedMessages.push(rumor);
      }
    }

    // Verify the message was received and decrypted correctly
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].content).toBe(messageContent);
    expect(receivedMessages[0].pubkey).toBe(inviteePubkey);
  });
});
