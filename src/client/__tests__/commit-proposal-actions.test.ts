import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { unlockGiftWrap } from "applesauce-common/helpers";
import { describe, expect, it } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";
import { ADDRESSABLE_KEY_PACKAGE_KIND } from "../../core/protocol.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { Proposals } from "../group/index.js";
import { MarmotClient } from "../marmot-client.js";

const RELAY = "wss://mock-relay.test";

async function setupTwoMemberGroup(network: MockNetwork) {
  const adminAccount = PrivateKeyAccount.generateNew();
  const memberAccount = PrivateKeyAccount.generateNew();
  const adminPubkey = await adminAccount.signer.getPublicKey();
  const memberPubkey = await memberAccount.signer.getPublicKey();

  const adminClient = new MarmotClient({
    groupStateStore: new InMemoryKeyValueStore(),
    keyPackageStore: new InMemoryKeyValueStore(),
    signer: adminAccount.signer,
    network,
    clientId: "aa".repeat(32),
  });
  const memberClient = new MarmotClient({
    groupStateStore: new InMemoryKeyValueStore(),
    keyPackageStore: new InMemoryKeyValueStore(),
    signer: memberAccount.signer,
    network,
    clientId: "bb".repeat(32),
  });

  await memberClient.keyPackages.create({ relays: [RELAY] });
  const adminGroup = await adminClient.groups.create("Test Group", {
    adminPubkeys: [adminPubkey],
    relays: [RELAY],
  });
  const keyPackageEvents = await network.request([RELAY], {
    kinds: [ADDRESSABLE_KEY_PACKAGE_KIND],
    authors: [memberPubkey],
  });
  await adminClient.groups.invite(adminGroup.id, keyPackageEvents[0]);

  const giftWraps = await network.request(["wss://mock-inbox.test"], {
    kinds: [1059],
    "#p": [memberPubkey],
  });
  const welcomeRumor = await unlockGiftWrap(giftWraps[0], memberAccount.signer);
  await memberClient.joinGroupFromWelcome({ welcomeRumor });

  return { adminClient, adminGroup, adminPubkey, memberPubkey };
}

// Regression for #105: the library's own builders return
// `ProposalAction<Proposal[]>`; committing them via `extraProposals` must
// flatten the resolved array into the commit rather than embedding it as a
// single (malformed) proposal.
describe("groups.commit() with array-returning ProposalActions", () => {
  it("removes a member via Proposals.proposeRemoveUser", async () => {
    const network = new MockNetwork();
    const { adminClient, adminGroup, adminPubkey, memberPubkey } =
      await setupTwoMemberGroup(network);
    expect(getGroupMemberPubkeys(adminGroup.state)).toContain(memberPubkey);
    const epochBefore = adminGroup.state.groupContext.epoch;

    await adminClient.groups.commit(adminGroup.id, {
      extraProposals: [Proposals.proposeRemoveUser(memberPubkey)],
    });

    const members = getGroupMemberPubkeys(adminGroup.state);
    expect(members).not.toContain(memberPubkey);
    expect(members).toContain(adminPubkey);
    expect(adminGroup.state.groupContext.epoch).toBe(epochBefore + 1n);
  });

  it("updates name and admins via a two-component Proposals.proposeUpdateMetadata", async () => {
    const network = new MockNetwork();
    const { adminClient, adminGroup, adminPubkey, memberPubkey } =
      await setupTwoMemberGroup(network);
    expect(adminGroup.groupData?.name).toBe("Test Group");
    expect(adminGroup.groupData?.adminPubkeys).toEqual([adminPubkey]);

    // name + adminPubkeys touch two components, so this action resolves to a
    // multi-element array.
    await adminClient.groups.commit(adminGroup.id, {
      extraProposals: [
        Proposals.proposeUpdateMetadata({
          name: "Renamed",
          adminPubkeys: [adminPubkey, memberPubkey],
        }),
      ],
    });

    expect(adminGroup.groupData?.name).toBe("Renamed");
    expect([...(adminGroup.groupData?.adminPubkeys ?? [])].sort()).toEqual(
      [adminPubkey, memberPubkey].sort(),
    );
  });
});
