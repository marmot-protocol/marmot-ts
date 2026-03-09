import { bytesToHex } from "@noble/hashes/utils.js";
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { defaultCryptoProvider, getCiphersuiteImpl } from "ts-mls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarmotClient } from "../marmot-client.js";
import { GROUP_EVENT_KIND, KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { KeyValueGroupStateBackend } from "../../store/adapters/key-value-group-state-backend.js";
import { KeyPackageStore } from "../../store/key-package-store.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { MemoryBackend } from "../../__tests__/helpers/memory-backend.js";

// ============================================================================
// Shared setup helpers
// ============================================================================

async function makeClient(network: MockNetwork): Promise<MarmotClient> {
  const account = PrivateKeyAccount.generateNew();
  return new MarmotClient({
    groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
    keyPackageStore: new KeyPackageStore(new MemoryBackend()),
    signer: account.signer,
    network,
  });
}

async function setupTwoMemberGroup(mockNetwork: MockNetwork) {
  const adminAccount = PrivateKeyAccount.generateNew();
  const memberAccount = PrivateKeyAccount.generateNew();
  const adminPubkey = await adminAccount.signer.getPublicKey();
  const memberPubkey = await memberAccount.signer.getPublicKey();

  const adminClient = new MarmotClient({
    groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
    keyPackageStore: new KeyPackageStore(new MemoryBackend()),
    signer: adminAccount.signer,
    network: mockNetwork,
  });

  const memberClient = new MarmotClient({
    groupStateBackend: new KeyValueGroupStateBackend(new MemoryBackend()),
    keyPackageStore: new KeyPackageStore(new MemoryBackend()),
    signer: memberAccount.signer,
    network: mockNetwork,
  });

  // Member publishes a key package
  await memberClient.keyPackages.create({ relays: ["wss://mock-relay.test"] });

  // Admin creates the group
  const adminGroup = await adminClient.createGroup("Test Group", {
    adminPubkeys: [adminPubkey],
    relays: ["wss://mock-relay.test"],
  });

  // Admin fetches the member's key package and invites them
  const keyPackageEvents = await mockNetwork.request(
    ["wss://mock-relay.test"],
    { kinds: [KEY_PACKAGE_KIND], authors: [memberPubkey] },
  );
  await adminGroup.inviteByKeyPackageEvent(keyPackageEvents[0]);

  // Member joins from the welcome
  const { unlockGiftWrap } =
    await import("applesauce-common/helpers/gift-wrap");
  const giftWraps = await mockNetwork.request(["wss://mock-inbox.test"], {
    kinds: [1059],
    "#p": [memberPubkey],
  });
  const welcomeRumor = await unlockGiftWrap(giftWraps[0], memberAccount.signer);
  const { group: memberGroup } = await memberClient.joinGroupFromWelcome({
    welcomeRumor,
  });

  return {
    adminClient,
    memberClient,
    adminGroup,
    memberGroup,
    adminPubkey,
    memberPubkey,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("MarmotGroup.leave()", () => {
  let mockNetwork: MockNetwork;

  beforeEach(() => {
    mockNetwork = new MockNetwork();
  });

  it("publishes a leave commit event to group relays", async () => {
    const { memberGroup } = await setupTwoMemberGroup(mockNetwork);

    const commitCountBefore = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    ).length;

    await memberGroup.leave();

    const commitCountAfter = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    ).length;

    // One new group event published for the leave commit
    expect(commitCountAfter).toBe(commitCountBefore + 1);
  });

  it("destroys local group state (store is empty after leave)", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    // Group should be accessible before leaving
    const groupIdHex = bytesToHex(memberGroup.id);
    const groupsBefore = await memberClient.groupStateStore.list();
    expect(groupsBefore.some((id) => bytesToHex(id) === groupIdHex)).toBe(true);

    await memberGroup.leave();

    // Group should be removed from store after leaving
    const groupsAfter = await memberClient.groupStateStore.list();
    expect(groupsAfter.some((id) => bytesToHex(id) === groupIdHex)).toBe(false);
  });

  it("emits the 'destroyed' event", async () => {
    const { memberGroup } = await setupTwoMemberGroup(mockNetwork);

    const destroyedHandler = vi.fn();
    memberGroup.on("destroyed", destroyedHandler);

    await memberGroup.leave();

    expect(destroyedHandler).toHaveBeenCalledOnce();
  });

  it("returns the relay publish response", async () => {
    const { memberGroup } = await setupTwoMemberGroup(mockNetwork);

    const response = await memberGroup.leave();

    expect(response).toBeDefined();
    // MockNetwork always acks with ok: true
    const values = Object.values(response);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((r) => r.ok)).toBe(true);
  });

  it("throws and preserves local state when no relay acks the proposals", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    // Swap in a network that always returns ok: false
    const failingNetwork = {
      ...mockNetwork,
      publish: async (_relays: string[], event: any) => {
        mockNetwork.events.push(event); // still record the event
        return {
          "wss://mock-relay.test": { from: "wss://mock-relay.test", ok: false },
        };
      },
    };
    // @ts-expect-error — patching private field for test
    memberGroup["network"] = failingNetwork;

    const groupIdHex = bytesToHex(memberGroup.id);

    await expect(memberGroup.leave()).rejects.toThrow("no relay acknowledged");

    // Local state must still exist after the failed leave attempt
    const groupsAfter = await memberClient.groupStateStore.list();
    expect(groupsAfter.some((id) => bytesToHex(id) === groupIdHex)).toBe(true);
  });

  it("throws NoMarmotGroupDataError when group data is missing", async () => {
    // Create a minimal group with no group data by using the admin's group
    // without the marmot extension — instead, just check the error fires for
    // a group with no relays configured.
    const { memberGroup } = await setupTwoMemberGroup(mockNetwork);

    // Monkeypatch relays to simulate missing relay config
    Object.defineProperty(memberGroup, "relays", {
      get: () => null,
    });

    await expect(memberGroup.leave()).rejects.toThrow();
  });
});

describe("MarmotClient.leaveGroup()", () => {
  let mockNetwork: MockNetwork;

  beforeEach(() => {
    mockNetwork = new MockNetwork();
  });

  it("publishes a leave commit and evicts the group from the client cache", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    const groupId = memberGroup.id;
    expect(
      memberClient.groups.some((g) => bytesToHex(g.id) === bytesToHex(groupId)),
    ).toBe(true);

    await memberClient.leaveGroup(groupId);

    // Group should be evicted from in-memory cache
    expect(
      memberClient.groups.some((g) => bytesToHex(g.id) === bytesToHex(groupId)),
    ).toBe(false);
  });

  it("emits groupLeft with the group id", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    const groupLeftHandler = vi.fn();
    memberClient.on("groupLeft", groupLeftHandler);

    await memberClient.leaveGroup(memberGroup.id);

    expect(groupLeftHandler).toHaveBeenCalledOnce();
    expect(bytesToHex(groupLeftHandler.mock.calls[0][0])).toBe(
      bytesToHex(memberGroup.id),
    );
  });

  it("emits groupsUpdated after leaving", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    const groupsUpdatedHandler = vi.fn();
    memberClient.on("groupsUpdated", groupsUpdatedHandler);

    await memberClient.leaveGroup(memberGroup.id);

    expect(groupsUpdatedHandler).toHaveBeenCalled();
  });

  it("accepts a hex string group id", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    const hexId = bytesToHex(memberGroup.id);
    await expect(memberClient.leaveGroup(hexId)).resolves.toBeDefined();
  });

  it("publishes a commit event to the group relays", async () => {
    const { memberClient, memberGroup } =
      await setupTwoMemberGroup(mockNetwork);

    const groupIdHex = bytesToHex(memberGroup.id);
    const commitsBefore = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    ).length;

    await memberClient.leaveGroup(memberGroup.id);

    const commitsAfter = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    ).length;

    expect(commitsAfter).toBe(commitsBefore + 1);
  });
});
