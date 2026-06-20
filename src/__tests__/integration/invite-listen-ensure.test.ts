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
import { SerializedClientState } from "../../core/client-state.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

const RELAYS = ["wss://mock-relay.test"];
const INBOX = ["wss://mock-inbox.test"];

describe("invites.listen + keyPackages.ensurePublished", () => {
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

  it("ensurePublished creates one KeyPackage and is idempotent", async () => {
    expect(await inviteeClient.keyPackages.count()).toBe(0);

    const first = await inviteeClient.keyPackages.ensurePublished({
      relays: RELAYS,
    });
    expect(await inviteeClient.keyPackages.count()).toBe(1);

    const second = await inviteeClient.keyPackages.ensurePublished({
      relays: RELAYS,
    });

    // No new KeyPackage was created — same ref, single published event.
    expect(second.keyPackageRef).toEqual(first.keyPackageRef);
    expect(await inviteeClient.keyPackages.count()).toBe(1);
    expect(
      mockNetwork.events.filter((e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND)
        .length,
    ).toBe(1);
  });

  it("listen ingests + decrypts a gift wrap delivered live", async () => {
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();
    const adminPubkey = await adminAccount.signer.getPublicKey();

    await inviteeClient.keyPackages.ensurePublished({ relays: RELAYS });
    const keyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
    )!;

    // Start listening BEFORE the invite is sent — exercises live delivery.
    const decrypted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), 2000);
      inviteeClient.invites.once("decrypted", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const handle = await inviteeClient.invites.listen(INBOX);

    const group = await adminClient.groups.create("Listen Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
    });
    await adminClient.groups.invite(group.id, keyPackageEvent);

    await decrypted;
    const unread = await inviteeClient.invites.getUnread();
    expect(unread).toHaveLength(1);

    handle.unsubscribe();
    void inviteePubkey;
  });
});
