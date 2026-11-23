import { describe, expect, it } from "vitest";
import { memoryDatabase } from "../../__tests__/helpers/database.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import {
  createApplicationMessageIntent,
  createChatRumor,
  Proposals,
} from "../group/index.js";
import { MarmotClient } from "../marmot-client.js";

describe("member removal and re-invitation end to end", () => {
  it("lets B accept a fresh invitation after A bans B and exchange messages again", async () => {
    const network = new MockNetwork();
    const relays = ["wss://mock-relay.test"];
    const accountA = testAccount(1);
    const accountB = testAccount(2);
    const a = new MarmotClient({
      database: memoryDatabase(),
      signer: accountA.signer,
      network,
      clientId: "aa".repeat(32),
    });
    const b = new MarmotClient({
      database: memoryDatabase(),
      signer: accountB.signer,
      network,
      clientId: "bb".repeat(32),
    });

    try {
      const groupA = await a.groups.create("Re-invitation", {
        adminPubkeys: [accountA.pubkey],
        relays,
      });
      expect(getGroupMemberPubkeys(groupA.state)).toEqual([accountA.pubkey]);

      async function inviteAndAccept() {
        // Publish fresh material each time: a consumed single-use package
        // must not be reused for the second Welcome.
        const before = network.events.length;
        await b.keyPackages.create({ relays });
        const keyPackages = network.events
          .slice(before)
          .filter((event) => event.kind === ADDRESSABLE_KEY_PACKAGE_KIND);
        expect(keyPackages).toHaveLength(1);
        await a.groups.invite(groupA.id, keyPackages[0]);

        const giftWraps = network.events
          .slice(before)
          .filter((event) => event.kind === 1059);
        expect(giftWraps).toHaveLength(1);
        expect(await b.invites.ingestEvent(giftWraps[0])).toBe(true);
        const invite = await b.invites.decryptGiftWrap(giftWraps[0].id);
        expect(invite).not.toBeNull();
        if (!invite) throw new Error("B could not decrypt the invitation");
        const { group } = await b.joinGroupFromWelcome({
          welcomeRumor: invite,
        });
        await b.invites.markAsRead(invite.id);
        expect(await b.invites.getUnread()).toEqual([]);
        expect(group.id).toEqual(groupA.id);
        expect(group.status).toBe("active");
        expect(getGroupMemberPubkeys(group.state).sort()).toEqual(
          [accountA.pubkey, accountB.pubkey].sort(),
        );
        expect(group.state.confirmationTag).toEqual(
          groupA.state.confirmationTag,
        );
        return group;
      }

      async function sendAndReceive(
        sender: MarmotClient,
        receiver: MarmotClient,
        content: string,
      ) {
        const rumor = createChatRumor({
          pubkey: await sender.signer.getPublicKey(),
          content,
        });
        const before = network.events.length;
        await sender.groups.send(
          groupA.id,
          createApplicationMessageIntent(rumor),
        );
        const envelopes = network.events
          .slice(before)
          .filter((event) => event.kind === GROUP_EVENT_KIND);
        expect(envelopes).toHaveLength(1);
        const results = [];
        // Explicit delivery keeps the scenario ordered; drain every batch.
        for await (const result of receiver.groups.ingest(groupA.id, envelopes))
          results.push(result);
        expect(results.map((result) => result.kind)).toEqual(["processed"]);
        const group = await receiver.groups.get(groupA.id);
        expect(await group.history.queryRumors({ ids: [rumor.id] })).toEqual([
          rumor,
        ]);
      }

      const groupB = await inviteAndAccept();
      await sendAndReceive(a, b, "A: welcome B");
      await sendAndReceive(b, a, "B: hello A");
      await sendAndReceive(a, b, "A: before removal");

      // The demo's Ban action is an admin Remove proposal.
      // See refs/marmot/protocol-core/member-departure.md.
      const beforeRemoval = network.events.length;
      await a.groups.commit(groupA.id, {
        extraProposals: [Proposals.proposeRemoveUser(accountB.pubkey)],
      });
      const removalEvents = network.events
        .slice(beforeRemoval)
        .filter((event) => event.kind === GROUP_EVENT_KIND);
      expect(removalEvents).toHaveLength(1);
      const removalResults = [];
      for await (const result of b.groups.ingest(groupA.id, removalEvents))
        removalResults.push(result);
      expect(removalResults.map((result) => result.kind)).toContain("removed");
      expect(groupB.status).toBe("removed");
      expect(getGroupMemberPubkeys(groupA.state)).toEqual([accountA.pubkey]);
      await expect(
        b.groups.send(
          groupA.id,
          createApplicationMessageIntent(
            createChatRumor({
              pubkey: accountB.pubkey,
              content: "B: cannot send while removed",
            }),
          ),
        ),
      ).rejects.toThrow(/removed/i);

      // Keep B's client and database, including the removed group. Accepting
      // a new Welcome should restore membership without manually deleting it.
      const rejoined = await inviteAndAccept();
      expect(await b.groups.get(groupA.id)).toBe(rejoined);
      expect(await b.groups.listIds()).toEqual([groupA.id]);
      expect(getGroupMemberPubkeys(groupA.state).sort()).toEqual(
        [accountA.pubkey, accountB.pubkey].sort(),
      );
      await sendAndReceive(a, b, "A: welcome back B");
      await sendAndReceive(b, a, "B: I am back");
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
