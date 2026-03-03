import { bytesToHex } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import type { BaseGroupHistory } from "../client/group/marmot-group.js";
import { MarmotClient } from "../client/marmot-client.js";
import { extractMarmotGroupData } from "../core/client-state.js";
import { deserializeApplicationData } from "../core/group-message.js";
import { GROUP_EVENT_KIND, KEY_PACKAGE_KIND } from "../core/protocol.js";
import { KeyValueGroupStateBackend } from "../store/adapters/key-value-group-state-backend.js";
import { KeyPackageStore } from "../store/key-package-store.js";
import { MockNetwork } from "./helpers/mock-network.js";
import { MemoryBackend } from "./ingest-commit-race.test.js";

/** Minimal in-memory history for testing */
class TestHistory implements BaseGroupHistory {
  readonly messages: Uint8Array[] = [];

  async saveMessage(message: Uint8Array): Promise<void> {
    this.messages.push(message);
  }

  async purgeMessages(): Promise<void> {
    this.messages.length = 0;
  }
}

/** Helper: set up two-member group and return the groups */
async function setupTwoMemberGroup(
  adminClient: MarmotClient,
  inviteeClient: MarmotClient,
  adminAccount: PrivateKeyAccount<any>,
  inviteeAccount: PrivateKeyAccount<any>,
  mockNetwork: MockNetwork,
  groupName: string,
) {
  const adminPubkey = await adminAccount.signer.getPublicKey();
  const inviteePubkey = await inviteeAccount.signer.getPublicKey();

  await inviteeClient.keyPackages.create({ relays: ["wss://mock-relay.test"] });

  const adminGroup = await adminClient.createGroup(groupName, {
    adminPubkeys: [adminPubkey],
    relays: ["wss://mock-relay.test"],
  });

  const keyPackageEvents = await mockNetwork.request(
    ["wss://mock-relay.test"],
    {
      kinds: [KEY_PACKAGE_KIND],
      authors: [inviteePubkey],
    },
  );
  await adminGroup.inviteByKeyPackageEvent(keyPackageEvents[0]);

  const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
    kinds: [1059],
    "#p": [inviteePubkey],
  });
  const welcomeRumor = await unlockGiftWrap(
    giftWraps[0],
    inviteeAccount.signer,
  );

  const { group: inviteeGroup } = await inviteeClient.joinGroupFromWelcome({
    welcomeRumor,
  });

  return { adminGroup, inviteeGroup, adminPubkey, inviteePubkey };
}

/** Helper: collect application rumor messages from admin ingesting all group events */
async function collectApplicationRumors(
  adminGroup: Awaited<ReturnType<MarmotClient["createGroup"]>>,
  mockNetwork: MockNetwork,
  nostrGroupIdHex: string,
): Promise<Rumor[]> {
  const groupEvents = await mockNetwork.request(["wss://mock-relay.test"], {
    kinds: [GROUP_EVENT_KIND],
    "#h": [nostrGroupIdHex],
  });

  const rumors: Rumor[] = [];
  for await (const ingestResult of adminGroup.ingest(groupEvents)) {
    if (
      ingestResult.kind === "processed" &&
      ingestResult.result.kind === "applicationMessage"
    ) {
      rumors.push(deserializeApplicationData(ingestResult.result.message));
    }
  }
  return rumors;
}

describe("MarmotGroup.sendChatMessage", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccount: PrivateKeyAccount<any>;
  let _ciphersuite: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;
  let inviteeClient: MarmotClient;

  beforeEach(async () => {
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccount = PrivateKeyAccount.generateNew();

    _ciphersuite = await getCiphersuiteImpl(
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

    inviteeClient = new MarmotClient({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: inviteeAccount.signer,
      network: mockNetwork,
    });
  });

  it("sends a kind 9 rumor that the other member can decrypt", async () => {
    const { adminGroup, inviteeGroup, inviteePubkey } =
      await setupTwoMemberGroup(
        adminClient,
        inviteeClient,
        adminAccount,
        inviteeAccount,
        mockNetwork,
        "Chat Test Group",
      );

    const content = "Hello via sendChatMessage!";
    await inviteeGroup.sendChatMessage(content);

    const marmotGroupData = extractMarmotGroupData(adminGroup.state);
    if (!marmotGroupData) throw new Error("MarmotGroupData missing");
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);

    const rumors = await collectApplicationRumors(
      adminGroup,
      mockNetwork,
      nostrGroupIdHex,
    );

    expect(rumors.length).toBe(1);
    expect(rumors[0].kind).toBe(9);
    expect(rumors[0].content).toBe(content);
    expect(rumors[0].pubkey).toBe(inviteePubkey);
    // id should be a 64-char hex-encoded SHA-256
    expect(typeof rumors[0].id).toBe("string");
    expect(rumors[0].id.length).toBe(64);
    expect(rumors[0].tags).toEqual([]);
  });

  it("sends a kind 9 rumor with custom tags", async () => {
    const { adminGroup, inviteeGroup } = await setupTwoMemberGroup(
      adminClient,
      inviteeClient,
      adminAccount,
      inviteeAccount,
      mockNetwork,
      "Chat Test Group 2",
    );

    const replyTag = ["e", "deadbeef".repeat(8), "", "reply"];
    await inviteeGroup.sendChatMessage("Replying to something", [replyTag]);

    const marmotGroupData = extractMarmotGroupData(adminGroup.state);
    if (!marmotGroupData) throw new Error("MarmotGroupData missing");
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);

    const rumors = await collectApplicationRumors(
      adminGroup,
      mockNetwork,
      nostrGroupIdHex,
    );

    expect(rumors.length).toBe(1);
    expect(rumors[0].tags).toEqual([replyTag]);
  });

  it("sets the correct pubkey from the signer on the rumor", async () => {
    const { adminGroup, inviteeGroup, adminPubkey, inviteePubkey } =
      await setupTwoMemberGroup(
        adminClient,
        inviteeClient,
        adminAccount,
        inviteeAccount,
        mockNetwork,
        "Chat Test Group 3",
      );

    await inviteeGroup.sendChatMessage("Message from invitee");

    const marmotGroupData = extractMarmotGroupData(adminGroup.state);
    if (!marmotGroupData) throw new Error("MarmotGroupData missing");
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);

    const rumors = await collectApplicationRumors(
      adminGroup,
      mockNetwork,
      nostrGroupIdHex,
    );

    expect(rumors.length).toBe(1);
    // pubkey should be the invitee's, not the admin's
    expect(rumors[0].pubkey).toBe(inviteePubkey);
    expect(rumors[0].pubkey).not.toBe(adminPubkey);
  });

  it("self-echo is skipped with reason 'self-echo' when the sender ingests their own event", async () => {
    const { inviteeGroup } = await setupTwoMemberGroup(
      adminClient,
      inviteeClient,
      adminAccount,
      inviteeAccount,
      mockNetwork,
      "Self-echo Test Group",
    );

    await inviteeGroup.sendChatMessage("Hello from invitee");

    const marmotGroupData = extractMarmotGroupData(inviteeGroup.state);
    if (!marmotGroupData) throw new Error("MarmotGroupData missing");
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);

    const groupEvents = await mockNetwork.request(["wss://mock-relay.test"], {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    });
    // Should contain at least the application message event
    const appEvents = groupEvents.filter(
      (e) => !e.tags.some((t) => t[0] === "e"),
    );

    const results: string[] = [];
    for await (const result of inviteeGroup.ingest(groupEvents)) {
      results.push(result.kind);
      if (result.kind === "skipped") {
        expect(result.reason).toBe("self-echo");
      }
      // The sender should NOT receive their own message back as an applicationMessage
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        throw new Error(
          "Self-echo was processed as an applicationMessage — ratchet would be corrupted",
        );
      }
    }
  });

  it("sending multiple messages in sequence does not cause 'desired gen in the past'", async () => {
    const { adminGroup, inviteeGroup, inviteePubkey } =
      await setupTwoMemberGroup(
        adminClient,
        inviteeClient,
        adminAccount,
        inviteeAccount,
        mockNetwork,
        "Multi-message Test Group",
      );

    // Send three messages in sequence — each advances the sender's ratchet
    await inviteeGroup.sendChatMessage("Message 1");
    await inviteeGroup.sendChatMessage("Message 2");
    await inviteeGroup.sendChatMessage("Message 3");

    const marmotGroupData = extractMarmotGroupData(adminGroup.state);
    if (!marmotGroupData) throw new Error("MarmotGroupData missing");
    const nostrGroupIdHex = bytesToHex(marmotGroupData.nostrGroupId);

    // Admin (different ratchet state) should be able to read all three
    const rumors = await collectApplicationRumors(
      adminGroup,
      mockNetwork,
      nostrGroupIdHex,
    );

    expect(rumors.length).toBe(3);
    expect(rumors.map((r) => r.content)).toEqual(
      expect.arrayContaining(["Message 1", "Message 2", "Message 3"]),
    );

    // The sender ingesting their own relay echo should not throw and should
    // NOT produce applicationMessage results (they're skipped as self-echoes)
    const allGroupEvents = await mockNetwork.request(
      ["wss://mock-relay.test"],
      { kinds: [GROUP_EVENT_KIND], "#h": [nostrGroupIdHex] },
    );
    const applicationMessageResults: unknown[] = [];
    for await (const result of inviteeGroup.ingest(allGroupEvents)) {
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        applicationMessageResults.push(result);
      }
    }
    // Sender's own messages should be skipped, not re-processed
    expect(applicationMessageResults.length).toBe(0);
  });

  it("saves message to history immediately on send without waiting for ingest", async () => {
    const history = new TestHistory();

    // Create a fresh invitee client that uses our test history factory
    const inviteeClientWithHistory = new MarmotClient<TestHistory>({
      groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
      keyPackageStore: new KeyPackageStore(new MemoryBackend()),
      signer: inviteeAccount.signer,
      network: mockNetwork,
      historyFactory: () => history,
    });

    const { inviteeGroup } = await setupTwoMemberGroup(
      adminClient,
      inviteeClientWithHistory,
      adminAccount,
      inviteeAccount,
      mockNetwork,
      "History Test Group",
    );

    expect(history.messages.length).toBe(0);

    await inviteeGroup.sendChatMessage("Saved immediately");

    // History should be populated before any ingest() call
    expect(history.messages.length).toBe(1);
    const savedRumor = deserializeApplicationData(history.messages[0]);
    expect(savedRumor.content).toBe("Saved immediately");

    // Sending a second message should not double-save the first
    await inviteeGroup.sendChatMessage("Second message");
    expect(history.messages.length).toBe(2);
    const secondRumor = deserializeApplicationData(history.messages[1]);
    expect(secondRumor.content).toBe("Second message");
  });
});
