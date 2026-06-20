import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
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
import { unixNow } from "../../utils/nostr.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

describe("KeyPackage eligibility (group.evaluateKeyPackage)", () => {
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

  async function setup(): Promise<{
    keyPackageEvent: NostrEvent;
    adminGroup: Awaited<ReturnType<MarmotClient["groups"]["create"]>>;
  }> {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    await inviteeClient.keyPackages.create({
      relays: ["wss://mock-relay.test"],
    });
    const keyPackageEvent = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND,
    ) as NostrEvent;
    const adminGroup = await adminClient.groups.create("Test Group", {
      adminPubkeys: [adminPubkey],
      relays: ["wss://mock-relay.test"],
    });
    return { keyPackageEvent, adminGroup };
  }

  it("reports a fresh invitee KeyPackage as eligible", async () => {
    const { keyPackageEvent, adminGroup } = await setup();

    const result = adminGroup.evaluateKeyPackage(keyPackageEvent);

    expect(result.eligible).toBe(true);
    expect(result.alreadyMember).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.cipherSuite).toBe(adminGroup.state.groupContext.cipherSuite);
  });

  it("flags a KeyPackage whose account is already a member", async () => {
    const { keyPackageEvent, adminGroup } = await setup();

    // Add the invitee, advancing the epoch + member set.
    await adminClient.groups.invite(adminGroup.id, keyPackageEvent);

    const result = adminGroup.evaluateKeyPackage(keyPackageEvent);

    expect(result.alreadyMember).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("already a member");
  });

  it("never throws on an undecodable event — reports undecodable", async () => {
    const { adminGroup } = await setup();
    const inviteePubkey = await inviteeAccount.signer.getPublicKey();

    const bogus: NostrEvent = {
      id: "0".repeat(64),
      kind: ADDRESSABLE_KEY_PACKAGE_KIND,
      pubkey: inviteePubkey,
      created_at: unixNow(),
      content: "not-a-key-package",
      tags: [],
      sig: "0".repeat(128),
    };

    const result = adminGroup.evaluateKeyPackage(bogus);

    expect(result.eligible).toBe(false);
    expect(result.cipherSuite).toBe(-1);
    expect(result.reasons.some((r) => r.startsWith("undecodable:"))).toBe(true);
  });
});
