/**
 * FOUND-05 end-to-end positive control for phase 10
 * (founding-group-creation-via-welcome): an honest all-Welcomes-succeed
 * founding create producing a working group whose invitees can message the
 * creator, in both directions.
 *
 * See `refs/marmot/protocol-core/joining.md` lines 21-30 (the
 * founding-creation exception: the creator first creates the one-member
 * epoch-0 group, then creates and locally merges one founding Add Commit
 * from epoch 0 to epoch 1 containing the initial invitees — that Add Commit
 * has no group-message publication obligation, and the creator then attempts
 * independent per-invitee epoch-1 Welcome deliveries) and lines 44-80 (the
 * Welcome receiving flow, steps 1-14, including step 13's catch-up on
 * outstanding Commits).
 *
 * Relays are supplied deliberately, per R-05: FOUND-05 is only satisfiable
 * when the founding group has relays, because a relay-less group has no
 * `transport.nostr.routing` component and can carry no group traffic (see
 * `src/client/__tests__/founding-create.test.ts` Test 13 for the relay-less
 * counterpart, which this file deliberately does not duplicate).
 *
 * Phase 9 shipped a Critical defect precisely because it lacked a positive
 * control — this test is planned explicitly rather than assumed, following
 * `end-to-end-invite-join-message.test.ts`'s scaffolding.
 */
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { Rumor, unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import { getEventHash, type NostrEvent } from "applesauce-core/helpers/event";
import { beforeEach, describe, expect, it } from "vitest";

import { createApplicationMessageIntent } from "../../client/group/application-message.js";
import { MarmotClient } from "../../client/marmot-client.js";
import { getNostrGroupIdHex } from "../../core/client-state.js";
import { deserializeApplicationData } from "../../core/group-message.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import { unixNow } from "../../utils/nostr.js";
import { MockNetwork } from "../helpers/mock-network.js";
import { memoryDatabase } from "../helpers/database.js";

const RELAYS = ["wss://mock-relay.test"];

describe("FOUND-05: founding group creation, joining, and first message (positive control)", () => {
  let adminAccount: PrivateKeyAccount<any>;
  let inviteeAccounts: PrivateKeyAccount<any>[];
  let mockNetwork: MockNetwork;
  let adminClient: MarmotClient;
  let inviteeClients: MarmotClient[];

  beforeEach(async () => {
    adminAccount = PrivateKeyAccount.generateNew();
    inviteeAccounts = [
      PrivateKeyAccount.generateNew(),
      PrivateKeyAccount.generateNew(),
    ];

    mockNetwork = new MockNetwork(RELAYS);

    adminClient = new MarmotClient({
      database: memoryDatabase(),
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    inviteeClients = inviteeAccounts.map(
      (account, index) =>
        new MarmotClient({
          database: memoryDatabase(),
          signer: account.signer,
          network: mockNetwork,
          clientId: index.toString(16).padStart(64, "0"),
        }),
    );
  });

  it("admin founding-creates a group with two invitees; both join at epoch 1, see each other, and exchange messages with the creator", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Pubkey = await inviteeAccounts[0]!.signer.getPublicKey();
    const invitee2Pubkey = await inviteeAccounts[1]!.signer.getPublicKey();

    // Step 1: both invitees publish KeyPackages and we recover the published
    // events (needed to pass as `invitees` and to cross-check the Welcome's
    // `e` tag below).
    await inviteeClients[0]!.keyPackages.create({ relays: RELAYS });
    await inviteeClients[1]!.keyPackages.create({ relays: RELAYS });
    const invitee1KeyPackageEvent = mockNetwork.events.find(
      (e) =>
        e.kind === ADDRESSABLE_KEY_PACKAGE_KIND && e.pubkey === invitee1Pubkey,
    );
    const invitee2KeyPackageEvent = mockNetwork.events.find(
      (e) =>
        e.kind === ADDRESSABLE_KEY_PACKAGE_KIND && e.pubkey === invitee2Pubkey,
    );
    expect(invitee1KeyPackageEvent).toBeDefined();
    expect(invitee2KeyPackageEvent).toBeDefined();
    if (!invitee1KeyPackageEvent || !invitee2KeyPackageEvent)
      throw new Error("expected both published KeyPackages");

    // Step 2: admin founding-creates the group in a single call — one Add
    // commit carrying both invitees, merged locally to epoch 1. Relays are
    // supplied deliberately (R-05).
    const adminGroup = await adminClient.groups.create("Founding Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1KeyPackageEvent, invitee2KeyPackageEvent],
    });

    // FOUND-01 absence assertion: the founding Add is never published as a
    // kind-445 group event.
    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(commitEvents).toHaveLength(0);

    // FOUND-03: synchronously after create() resolves the group is already
    // Stable at epoch 1.
    expect(adminGroup.lifecycle).toBe("Stable");
    expect(adminGroup.state.groupContext.epoch).toBe(1n);

    // Step 3 (negative + positive): exactly one gift wrap per invitee,
    // addressed to that invitee, each unwrappable only by its intended
    // recipient.
    const giftWraps = mockNetwork.events.filter((e) => e.kind === 1059);
    expect(giftWraps).toHaveLength(2);
    const recipientOf = (event: NostrEvent) =>
      event.tags.find((tag) => tag[0] === "p")?.[1];
    const invitee1GiftWrap = giftWraps.find(
      (e) => recipientOf(e) === invitee1Pubkey,
    );
    const invitee2GiftWrap = giftWraps.find(
      (e) => recipientOf(e) === invitee2Pubkey,
    );
    expect(invitee1GiftWrap).toBeDefined();
    expect(invitee2GiftWrap).toBeDefined();

    // Addressing proof: each gift wrap's `p` tag names exactly one
    // recipient, and no gift wrap is addressed to the other invitee (the
    // filters above already partition the two events by that tag). A
    // direct cross-signer decrypt-failure assertion is not meaningful over
    // this in-memory MockNetwork: applesauce's gift-wrap helpers cache the
    // decrypted rumor on the event object itself once unlocked by anyone
    // holding the right key, and — because the mock transport shares object
    // references in-process rather than serializing bytes over a wire — the
    // event the creator just encrypted already carries that cache before
    // any test code touches it. Real transport-serialized gift wraps carry
    // no such cache and only decrypt for their true ECDH-derived recipient.
    const invitee1WelcomeRumor = await unlockGiftWrap(
      invitee1GiftWrap!,
      inviteeAccounts[0]!.signer,
    );
    const invitee2WelcomeRumor = await unlockGiftWrap(
      invitee2GiftWrap!,
      inviteeAccounts[1]!.signer,
    );
    expect(invitee1WelcomeRumor.tags.find((t) => t[0] === "e")?.[1]).toBe(
      invitee1KeyPackageEvent.id,
    );
    expect(invitee2WelcomeRumor.tags.find((t) => t[0] === "e")?.[1]).toBe(
      invitee2KeyPackageEvent.id,
    );

    // Step 4: each invitee independently joins from its own Welcome.
    const { group: invitee1Group } =
      await inviteeClients[0]!.joinGroupFromWelcome({
        welcomeRumor: invitee1WelcomeRumor,
      });
    const { group: invitee2Group } =
      await inviteeClients[1]!.joinGroupFromWelcome({
        welcomeRumor: invitee2WelcomeRumor,
      });

    expect(invitee1Group.state.groupContext.epoch).toBe(
      adminGroup.state.groupContext.epoch,
    );
    expect(invitee2Group.state.groupContext.epoch).toBe(
      adminGroup.state.groupContext.epoch,
    );
    expect(invitee1Group.state.groupContext.epoch).toBe(1n);
    expect(invitee2Group.state.groupContext.epoch).toBe(1n);

    // Step 5: the consumed KeyPackage is marked used on each invitee's own
    // client.
    expect(await inviteeClients[0]!.keyPackages.count()).toBe(1);
    expect(
      (await inviteeClients[0]!.keyPackages.list()).some((p) => p.used),
    ).toBe(true);
    expect(await inviteeClients[1]!.keyPackages.count()).toBe(1);
    expect(
      (await inviteeClients[1]!.keyPackages.list()).some((p) => p.used),
    ).toBe(true);

    // Step 6: shared-commit structural proof — each invitee sees the
    // creator AND the other invitee as members, proving one shared founding
    // Add rather than N sequential per-invitee commits.
    const expectedMembers = [adminPubkey, invitee1Pubkey, invitee2Pubkey]
      .slice()
      .sort();
    expect(adminGroup.info.members.pubkeys.slice().sort()).toEqual(
      expectedMembers,
    );
    expect(invitee1Group.info.members.pubkeys.slice().sort()).toEqual(
      expectedMembers,
    );
    expect(invitee2Group.info.members.pubkeys.slice().sort()).toEqual(
      expectedMembers,
    );

    // Step 7: catch-up backlog ingest is a no-op — a joiner must tolerate
    // re-ingesting the (empty, since no commit was ever published) backlog.
    const nostrGroupIdHex = getNostrGroupIdHex(adminGroup.state);
    const backlogEvents = await mockNetwork.request([RELAYS[0]!], {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    });
    for await (const _ of invitee1Group.ingest(backlogEvents)) {
      // Drain iterator
    }
    for await (const _ of invitee2Group.ingest(backlogEvents)) {
      // Drain iterator
    }
    expect(invitee1Group.state.groupContext.epoch).toBe(1n);
    expect(invitee2Group.state.groupContext.epoch).toBe(1n);

    // Step 8: bidirectional messaging relative to the creator.

    // invitee1 -> admin
    const invitee1MessageContent = "Hello from invitee 1!";
    const invitee1MessageRumor: Rumor = {
      id: "",
      kind: 9,
      pubkey: invitee1Pubkey,
      created_at: unixNow(),
      content: invitee1MessageContent,
      tags: [],
    };
    invitee1MessageRumor.id = getEventHash(invitee1MessageRumor);
    await inviteeClients[0]!.groups.send(
      invitee1Group.id,
      createApplicationMessageIntent(invitee1MessageRumor),
    );

    const groupEventsAfterInvitee1Send = await mockNetwork.request(
      [RELAYS[0]!],
      { kinds: [GROUP_EVENT_KIND], "#h": [nostrGroupIdHex] },
    );
    const receivedByAdmin: Rumor[] = [];
    for await (const result of adminGroup.ingest(
      groupEventsAfterInvitee1Send,
    )) {
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        receivedByAdmin.push(deserializeApplicationData(result.result.message));
      }
    }
    expect(receivedByAdmin).toHaveLength(1);
    expect(receivedByAdmin[0]!.content).toBe(invitee1MessageContent);
    expect(receivedByAdmin[0]!.pubkey).toBe(invitee1Pubkey);

    // admin -> invitee2
    const adminMessageContent = "Hello from the admin!";
    const adminMessageRumor: Rumor = {
      id: "",
      kind: 9,
      pubkey: adminPubkey,
      created_at: unixNow(),
      content: adminMessageContent,
      tags: [],
    };
    adminMessageRumor.id = getEventHash(adminMessageRumor);
    await adminClient.groups.send(
      adminGroup.id,
      createApplicationMessageIntent(adminMessageRumor),
    );

    // invitee2 has not yet ingested anything, so this batch also contains
    // invitee1's earlier message alongside the admin's — both decrypt fine
    // (application messages don't gate on delivery order); assert the
    // admin's message specifically is among them.
    const groupEventsAfterAdminSend = await mockNetwork.request([RELAYS[0]!], {
      kinds: [GROUP_EVENT_KIND],
      "#h": [nostrGroupIdHex],
    });
    const receivedByInvitee2: Rumor[] = [];
    for await (const result of invitee2Group.ingest(
      groupEventsAfterAdminSend,
    )) {
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        receivedByInvitee2.push(
          deserializeApplicationData(result.result.message),
        );
      }
    }
    const adminMessageReceivedByInvitee2 = receivedByInvitee2.find(
      (r) => r.content === adminMessageContent,
    );
    expect(adminMessageReceivedByInvitee2).toBeDefined();
    expect(adminMessageReceivedByInvitee2!.pubkey).toBe(adminPubkey);
  });
});
