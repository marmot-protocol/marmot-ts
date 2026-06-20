import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import {
  CiphersuiteImpl,
  defaultCryptoProvider,
  getCiphersuiteImpl,
} from "ts-mls";
import { beforeEach, describe, expect, it } from "vitest";

import { accountProofSignerFor } from "../helpers/account-proof.js";
import { MarmotClient } from "../../client/marmot-client.js";
import type { StoredKeyPackage } from "../../client/key-package-manager.js";
import type { UnreadInvite } from "../../client/invite-manager.js";
import { SerializedClientState } from "../../core/client-state.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

describe("invite preview + canJoin (MarmotClient)", () => {
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

  /** Runs the invite flow and returns the invitee's decrypted Welcome rumor. */
  async function inviteAndGetWelcome(): Promise<UnreadInvite> {
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();
    const adminPubkey = await adminAccount.signer.getPublicKey();

    await inviteeClient.keyPackages.create({
      relays: ["wss://mock-relay.test"],
    });
    const keyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
    )!;

    const group = await adminClient.groups.create("Preview Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://mock-relay.test"],
      description: "a group for preview tests",
    });
    void group;

    await adminClient.groups.invite(group.id, keyPackageEvent);

    const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    return (await unlockGiftWrap(
      giftWraps[0],
      inviteeAccount.signer,
    )) as UnreadInvite;
  }

  it("canJoinInvite is true while the target KeyPackage is held, false for a stranger", async () => {
    const welcome = await inviteAndGetWelcome();

    expect(await inviteeClient.canJoinInvite(welcome)).toBe(true);
    // The admin never held the invitee's KeyPackage, so it can't join.
    expect(await adminClient.canJoinInvite(welcome)).toBe(false);
  });

  it("previewWelcome decodes group metadata + welcome fields before joining", async () => {
    const welcome = await inviteAndGetWelcome();

    const preview = await inviteeClient.previewWelcome(welcome);

    expect(preview.relays).toContain("wss://mock-relay.test");
    expect(preview.recipientCount).toBe(1);
    expect(typeof preview.cipherSuite).toBe("number");
    expect(preview.epoch).toBeTypeOf("bigint");
    expect(preview.group?.name).toBe("Preview Group");
    expect(preview.group?.adminPubkeys).toContain(
      await adminAccount.signer.getPublicKey(),
    );
  });

  it("previewWelcome yields rumor-level fields but no group when KeyPackage is not held", async () => {
    const welcome = await inviteAndGetWelcome();

    const preview = await adminClient.previewWelcome(welcome);

    // Rumor-level fields still decode without the KeyPackage…
    expect(preview.relays).toContain("wss://mock-relay.test");
    expect(preview.recipientCount).toBe(1);
    // …but the group block requires decrypting with our held KeyPackage.
    expect(preview.group).toBeNull();
  });

  it("watchInvites annotates each unread invite with joinable", async () => {
    const welcome = await inviteAndGetWelcome();
    // Ingest + decrypt the gift wrap into the invitee's invite store.
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();
    const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
      kinds: [1059],
      "#p": [inviteePubkey],
    });
    await inviteeClient.invites.ingestEvent(giftWraps[0]);
    await inviteeClient.invites.decryptGiftWraps();
    void welcome;

    const iterator = inviteeClient.watchInvites();
    const { value } = await iterator.next();
    void iterator.return?.(undefined);

    expect(value).toHaveLength(1);
    expect(value![0].joinable).toBe(true);
  });
});
