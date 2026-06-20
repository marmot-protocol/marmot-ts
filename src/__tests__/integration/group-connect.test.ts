import {
  unlockGiftWrap,
  type Rumor,
} from "applesauce-common/helpers/gift-wrap";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { createApplicationMessageIntent } from "../../client/group/application-message.js";
import { MarmotClient } from "../../client/marmot-client.js";
import type { StoredKeyPackage } from "../../client/key-package-manager.js";
import type { MarmotGroup } from "../../client/group/marmot-group.js";
import { SerializedClientState } from "../../core/client-state.js";
import { deserializeApplicationData } from "../../core/group-message.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { unixNow } from "../../utils/nostr.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

const RELAYS = ["wss://mock-relay.test"];

/** Resolve on the group's next applicationMessage, decoded; rejects after `ms`. */
function nextMessage(group: MarmotGroup, ms = 2000): Promise<Rumor> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    group.once("applicationMessage", (bytes: Uint8Array) => {
      clearTimeout(timer);
      resolve(deserializeApplicationData(bytes));
    });
  });
}

function chatRumor(pubkey: string, content: string): Rumor {
  const rumor: Rumor = {
    id: "",
    kind: 9,
    pubkey,
    created_at: unixNow(),
    content,
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

describe("GroupsManager.connect / connectAll (inbound transport)", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccount: PrivateKeyAccount<any>;
  let ciphersuite: CiphersuiteImpl;
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;
  let inviteeClient: MarmotClient;

  beforeEach(async () => {
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccount = PrivateKeyAccount.generateNew();
    ciphersuite = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    void ciphersuite;
    mockNetwork = new MockNetwork();

    adminClient = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: adminAccount.signer,
      accountProofSigner: accountProofSignerFor(adminAccount),
      network: mockNetwork,
    });

    inviteeClient = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
      signer: inviteeAccount.signer,
      accountProofSigner: accountProofSignerFor(inviteeAccount),
      network: mockNetwork,
      clientId: "test-invitee-device",
    });
  });

  /** Admin creates a group and the invitee joins it. */
  async function adminAndInvitee(): Promise<{
    adminGroup: MarmotGroup;
    inviteeGroup: MarmotGroup;
  }> {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    await inviteeClient.keyPackages.create({ relays: RELAYS });
    const keyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
    )!;

    const adminGroup = await adminClient.groups.create("Connect Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
    });
    await adminClient.groups.invite(adminGroup.id, keyPackageEvent);

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
    return { adminGroup, inviteeGroup };
  }

  it("delivers live messages to a connected group", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Awaiting connect() guarantees the live subscription is installed.
    const handle = await adminClient.groups.connect(adminGroup.id);
    const received = nextMessage(adminGroup);

    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(chatRumor(inviteePubkey, "live!")),
    );

    expect((await received).content).toBe("live!");
    handle.unsubscribe();
  });

  it("backfills already-published messages on connect", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    // Publish BEFORE the admin connects — must be picked up by the backfill.
    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(chatRumor(inviteePubkey, "backfilled")),
    );

    const received = nextMessage(adminGroup);
    const handle = await adminClient.groups.connect(adminGroup.id);

    expect((await received).content).toBe("backfilled");
    handle.unsubscribe();
  });

  it("stops delivering after the connection is torn down", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    const handle = await adminClient.groups.connect(adminGroup.id);
    handle.unsubscribe();

    let delivered = false;
    adminGroup.once("applicationMessage", () => {
      delivered = true;
    });

    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(
        chatRumor(inviteePubkey, "after-teardown"),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(delivered).toBe(false);
  });

  it("connectAll delivers to already-loaded groups and stops on unsubscribe", async () => {
    const { adminGroup, inviteeGroup } = await adminAndInvitee();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    const handle = adminClient.groups.connectAll();
    // Give connectAll's async per-group connect a tick to install subscriptions.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received = nextMessage(adminGroup);
    await inviteeClient.groups.send(
      inviteeGroup.id,
      createApplicationMessageIntent(
        chatRumor(inviteePubkey, "via-connectAll"),
      ),
    );
    expect((await received).content).toBe("via-connectAll");

    handle.unsubscribe();
  });
});
