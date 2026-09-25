import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Welcome } from "ts-mls";
import { describe, expect, it } from "vitest";

import { testAccount } from "../../../../__tests__/helpers/test-accounts.js";
import { MockNetwork } from "../../../../__tests__/helpers/mock-network.js";
import type { NostrNetworkInterface } from "../../../nostr-interface.js";
import {
  NostrWelcomeDelivery,
  type WelcomeRecipient,
} from "../welcome-delivery.js";

// Minimal, real (never-thrown-away) `Welcome` object. `NostrWelcomeDelivery`
// only encodes it into a rumor's content — it does not need to be
// cryptographically joinable for these assertions.
const WELCOME: Welcome = {
  cipherSuite: 1,
  secrets: [],
  encryptedGroupInfo: new Uint8Array([1, 2, 3, 4]),
};

const GROUP_RELAYS = ["wss://relay.test"];

function makeRecipient(
  pubkey: string,
  keyPackageEventId: string,
): WelcomeRecipient {
  return {
    pubkey,
    keyPackageEventId,
    keyPackageEvent: {} as NostrEvent,
  };
}

/** Wraps a MockNetwork so `getUserInboxRelays` can be overridden per-pubkey. */
function makeNetwork(
  mockNetwork: MockNetwork,
  getUserInboxRelays: (pubkey: string) => Promise<string[]>,
): NostrNetworkInterface {
  return {
    publish: (relays, event) => mockNetwork.publish(relays, event),
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    getUserInboxRelays,
  };
}

describe("NostrWelcomeDelivery.deliverMany", () => {
  it("resolves two reachable recipients to two succeeded entries, in supplied order", async () => {
    const admin = testAccount(0);
    const adminPubkey = await admin.signer.getPublicKey();
    const mockNetwork = new MockNetwork();
    const network = makeNetwork(mockNetwork, async () => [
      "wss://mock-inbox.test",
    ]);
    const delivery = new NostrWelcomeDelivery({
      signer: admin.signer,
      network,
    });

    const first = makeRecipient(testAccount(1).pubkey, "a".repeat(64));
    const second = makeRecipient(testAccount(2).pubkey, "b".repeat(64));

    const outcomes = await delivery.deliverMany({
      welcome: WELCOME,
      author: adminPubkey,
      groupRelays: GROUP_RELAYS,
      recipients: [first, second],
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ kind: "succeeded", recipient: first });
    expect(outcomes[1]).toMatchObject({
      kind: "succeeded",
      recipient: second,
    });
    if (outcomes[0]!.kind !== "succeeded" || outcomes[1]!.kind !== "succeeded")
      throw new Error("expected both outcomes to succeed");
    expect(outcomes[0]!.response).toEqual({
      "wss://mock-inbox.test": { from: "wss://mock-inbox.test", ok: true },
    });
  });

  it("resolves one succeeded and one failed entry when the second recipient's inbox relays resolve empty", async () => {
    const admin = testAccount(0);
    const adminPubkey = await admin.signer.getPublicKey();
    const mockNetwork = new MockNetwork();

    const first = makeRecipient(testAccount(1).pubkey, "a".repeat(64));
    const second = makeRecipient(testAccount(2).pubkey, "b".repeat(64));

    // The second recipient's inbox-relay lookup resolves successfully but
    // empty (no NIP-65 relay list); `deliver()`'s own contract throws in
    // that case, with no group-relay fallback beyond the existing one
    // (D-09) — `deliverMany` must catch that per-recipient throw and report
    // it as a failed outcome rather than rejecting.
    const network = makeNetwork(mockNetwork, async (pubkey) =>
      pubkey === second.pubkey ? [] : ["wss://mock-inbox.test"],
    );
    const delivery = new NostrWelcomeDelivery({
      signer: admin.signer,
      network,
    });

    const outcomes = await delivery.deliverMany({
      welcome: WELCOME,
      author: adminPubkey,
      groupRelays: GROUP_RELAYS,
      recipients: [first, second],
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({ kind: "succeeded", recipient: first });
    expect(outcomes[1]).toMatchObject({
      kind: "failed",
      recipient: second,
      error: expect.stringMatching(/No relays available/),
    });
  });

  it("resolves an empty recipient list to an empty array and performs no publish", async () => {
    const admin = testAccount(0);
    const adminPubkey = await admin.signer.getPublicKey();
    const mockNetwork = new MockNetwork();
    const network = makeNetwork(mockNetwork, async () => [
      "wss://mock-inbox.test",
    ]);
    const delivery = new NostrWelcomeDelivery({
      signer: admin.signer,
      network,
    });

    const outcomes = await delivery.deliverMany({
      welcome: WELCOME,
      author: adminPubkey,
      groupRelays: GROUP_RELAYS,
      recipients: [],
    });

    expect(outcomes).toEqual([]);
    expect(mockNetwork.events).toHaveLength(0);
  });

  it("each recipient receives a gift wrap addressed to that recipient only", async () => {
    const admin = testAccount(0);
    const adminPubkey = await admin.signer.getPublicKey();
    const mockNetwork = new MockNetwork();
    const network = makeNetwork(mockNetwork, async () => [
      "wss://mock-inbox.test",
    ]);
    const delivery = new NostrWelcomeDelivery({
      signer: admin.signer,
      network,
    });

    const first = makeRecipient(testAccount(1).pubkey, "a".repeat(64));
    const second = makeRecipient(testAccount(2).pubkey, "b".repeat(64));

    await delivery.deliverMany({
      welcome: WELCOME,
      author: adminPubkey,
      groupRelays: GROUP_RELAYS,
      recipients: [first, second],
    });

    const giftWraps = mockNetwork.events.filter(
      (event) => event.kind === 1059,
    );
    expect(giftWraps).toHaveLength(2);

    const recipientOf = (event: NostrEvent) =>
      event.tags.find((tag) => tag[0] === "p")?.[1];
    expect(giftWraps.map(recipientOf).sort()).toEqual(
      [first.pubkey, second.pubkey].sort(),
    );
    // Exactly one gift wrap per recipient, none shared/batched.
    expect(
      giftWraps.filter((event) => recipientOf(event) === first.pubkey),
    ).toHaveLength(1);
    expect(
      giftWraps.filter((event) => recipientOf(event) === second.pubkey),
    ).toHaveLength(1);
  });
});

describe("NostrWelcomeDelivery.deliver (unchanged contract)", () => {
  it("still rejects on its own when no relays can be resolved for a single recipient", async () => {
    const admin = testAccount(0);
    const adminPubkey = await admin.signer.getPublicKey();
    const mockNetwork = new MockNetwork();
    // Inbox lookup resolves successfully but empty (no NIP-65 relay list),
    // so no fallback is consulted at all. `groupRelays` stays non-empty here
    // only because `createWelcomeRumor` requires a non-empty relays tag
    // (transport-level, unrelated to inbox-relay resolution) — this test
    // targets `deliver()`'s own empty-resolved-relay-list throw, unchanged
    // by this plan.
    const network = makeNetwork(mockNetwork, async () => []);
    const delivery = new NostrWelcomeDelivery({
      signer: admin.signer,
      network,
    });

    const recipient = makeRecipient(testAccount(1).pubkey, "a".repeat(64));

    await expect(
      delivery.deliver({
        welcome: WELCOME,
        author: adminPubkey,
        groupRelays: GROUP_RELAYS,
        recipient,
      }),
    ).rejects.toThrow(/No relays available/);
  });
});
