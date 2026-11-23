/**
 * Client-level absence, single-write, and behavioural-matrix proofs for
 * founding Current-profile group creation via Welcome (FOUND-01, FOUND-02,
 * FOUND-03, FOUND-04).
 *
 * Covers decisions D-01 (stage the founding Add and confirm it with no
 * observable `PendingPublish` window), D-03 (only epoch 1 is durable — one
 * write), D-04/D-10/D-12 (in-memory, ignorable, never-thrown per-invitee
 * Welcome outcomes), D-08 (`options.invitees` on the existing `create()`;
 * omitting it keeps today's exact solo-create behaviour and code path), and
 * D-13 (duplicate-invitee refusal and the one-distinct-Welcome-per-invitee
 * assertion), plus risks R-01 (an unconfirmed `foundingGroupCreated` result
 * must be caught, not silently left as stale staged state — proven here as
 * "no persisted artifact ever observes epoch 0 for a founding create") and
 * R-04 (the delivery report is non-durable and ignorable — a group reloaded
 * from the store reports no pending Welcomes even though an invitee was
 * never reached; the only recovery is the spec's re-invite path).
 *
 * D-09 (the original decision allowing a relay-less founding create) and
 * R-05 (its FOUND-05 testing constraint) are **SUPERSEDED (2026-09-28, gap
 * closure — fail closed, see 10-VERIFICATION.md CR-01)**: `create()` now
 * refuses a founding create with invitees and no valid group relays before
 * any MLS state exists (Test 13, rewritten below). Test 15 pins the
 * still-allowed solo relay-less create (CR-01's scope boundary).
 *
 * See `refs/marmot/protocol-core/joining.md` lines 21-30 (the
 * founding-creation exception: a founding Add Commit from epoch 0 to epoch 1
 * has no group-message publication obligation because no pre-existing peer
 * needs it) and `refs/marmot/protocol-core/publish-lifecycle.md` lines 66-78
 * (each resulting epoch-1 Welcome is a separate retryable per-invitee
 * delivery obligation; a Welcome delivery succeeds or fails independently
 * and does not affect canonical group state; consumed KeyPackage material is
 * not restorable and the creator MAY re-invite with a fresh KeyPackage
 * against the now-canonical group).
 *
 * Plan 10-04 extended this file (Tests 7-14 below) with the behavioural
 * matrix: D-13 duplicate refusal, FOUND-02 refusal through the public API,
 * D-12 partial Welcome failure, FOUND-04 retry, R-04 non-durability, D-09
 * relay-less delivery, and fork-tree persistence through a configured
 * rewind store. Tests 1-6 (plan 10-03) stay scoped to the absence/
 * single-write proofs and must not be weakened.
 */
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import { verifiedSymbol } from "applesauce-core/helpers";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarmotClient } from "../marmot-client.js";
import { GroupFactory } from "../group-factory.js";
import { GroupsManager } from "../groups-manager.js";
import {
  deserializeClientState,
  type SerializedClientState,
} from "../../core/client-state.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import {
  memoryDatabase,
  memoryGroupDatabase,
} from "../../__tests__/helpers/database.js";
import type {
  GroupTransaction,
  MarmotDatabase,
  MarmotGroupDatabase,
} from "../storage/database/types.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import type { ProposalContext } from "../../engine/types.js";
import { defaultProposalTypes, type Proposal } from "ts-mls";

const RELAYS = ["wss://mock-relay.test"];

/**
 * A group database that records every canonical group-state value written
 * (meta `state`) before applying it — used by Tests 4-5 to attribute the
 * write count to `GroupFactory` alone, independent of registry tracking.
 */
class RecordingStorage {
  readonly writes: SerializedClientState[] = [];

  /** `GroupFactoryOptions.prepare` over a recording group database. */
  readonly prepare = async () => {
    const database: MarmotGroupDatabase = memoryGroupDatabase();
    const transaction = database.transaction.bind(database);
    database.transaction = <T>(fn: (tx: GroupTransaction) => Promise<T>) =>
      transaction((tx) =>
        fn({
          ...tx,
          meta: {
            ...tx.meta,
            set: async (key, value) => {
              if (key === "state") this.writes.push(value.slice());
              return tx.meta.set(key, value);
            },
          },
        }),
      );
    return {
      database,
      dropDatabase: async () => {},
      complete: async () => {},
      abort: async () => {},
    };
  };
}

/** Every group the account database lists, with or without state. */
async function storedGroups(database: MarmotDatabase) {
  return database.account.groups.all();
}

describe("Founding group creation via Welcome (FOUND-01..05; D-01/D-03/D-04/D-08/D-09/D-10/D-12/D-13; R-01/R-04/R-05; CR-01)", () => {
  let mockNetwork: MockNetwork;
  let adminAccount: PrivateKeyAccount<any>;
  let adminStorage: MarmotDatabase;
  let adminClient: MarmotClient;
  let inviteeAccounts: PrivateKeyAccount<any>[];
  let inviteeClients: MarmotClient[];

  beforeEach(() => {
    mockNetwork = new MockNetwork(RELAYS);
    adminAccount = PrivateKeyAccount.generateNew();
    adminStorage = memoryDatabase();
    adminClient = new MarmotClient({
      database: adminStorage,
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    inviteeAccounts = [
      PrivateKeyAccount.generateNew(),
      PrivateKeyAccount.generateNew(),
    ];
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

  /** Has an invitee client publish a KeyPackage and returns the resulting event. */
  async function publishKeyPackage(client: MarmotClient): Promise<NostrEvent> {
    await client.keyPackages.create({ relays: RELAYS });
    const pubkey = await client.signer.getPublicKey();
    const event = mockNetwork.events.find(
      (e) => e.kind === ADDRESSABLE_KEY_PACKAGE_KIND && e.pubkey === pubkey,
    );
    if (!event) throw new Error("expected a published KeyPackage event");
    return event;
  }

  it.each(["array", "empty", "mixed"] as const)(
    "handles a %s proposal builder result before founding persistence or delivery",
    async (shape) => {
      const invitees = [
        await publishKeyPackage(inviteeClients[0]!),
        await publishKeyPackage(inviteeClients[1]!),
      ];
      const originalSend = MarmotGroupEngine.prototype.send;
      const spy = vi
        .spyOn(MarmotGroupEngine.prototype, "send")
        .mockImplementation(async function (
          this: MarmotGroupEngine<NostrEvent>,
          intent,
        ) {
          if (intent.kind !== "foundingAdd")
            return originalSend.call(this, intent);
          const originalInputs = intent.extraProposals;
          const parent = this.state;
          try {
            return await originalSend.call(this, {
              ...intent,
              extraProposals: [
                async (context) => {
                  if (shape === "empty") return [];
                  const proposals: Proposal[] = [];
                  for (const item of originalInputs.flat()) {
                    const result =
                      typeof item === "function" ? await item(context) : item;
                    proposals.push(
                      ...(Array.isArray(result) ? result : [result]),
                    );
                  }
                  if (shape === "mixed")
                    proposals.push({
                      proposalType: defaultProposalTypes.remove,
                      remove: { removed: 0 },
                    });
                  return proposals;
                },
              ],
            });
          } catch (error) {
            expect(this.state).toBe(parent);
            expect(this.lifecycle).toBe("Stable");
            throw error;
          }
        });
      try {
        const creation = adminClient.groups.create("Builder founding group", {
          relays: RELAYS,
          invitees,
        });
        if (shape === "array") {
          const group = await creation;
          expect(group.state.groupContext.epoch).toBe(1n);
          expect(group.info.members.pubkeys).toHaveLength(3);
          expect(
            mockNetwork.events.filter((e) => e.kind === 1059),
          ).toHaveLength(2);
        } else {
          await expect(creation).rejects.toThrow(
            shape === "empty" ? /empty proposal/i : /may only carry Add/,
          );
          expect(await storedGroups(adminStorage)).toHaveLength(0);
          expect(adminClient.groups.loaded).toHaveLength(0);
          expect(
            mockNetwork.events.filter((e) => e.kind === 1059),
          ).toHaveLength(0);
        }
        expect(
          mockNetwork.events.filter((e) => e.kind === GROUP_EVENT_KIND),
        ).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("keeps the convenience propose array path publishing each proposal", async () => {
    const group = await adminClient.groups.create("Proposal convenience", {
      relays: RELAYS,
    });
    const events = [
      await publishKeyPackage(inviteeClients[0]!),
      await publishKeyPackage(inviteeClients[1]!),
    ];
    const { proposeInviteUser } =
      await import("../group/proposals/invite-user.js");
    await group.propose(async (context: ProposalContext) => {
      const proposals: Proposal[] = [];
      for (const event of events)
        proposals.push(await proposeInviteUser(event)(context));
      return proposals;
    });
    expect(
      mockNetwork.events.filter((e) => e.kind === GROUP_EVENT_KIND),
    ).toHaveLength(2);
    expect(Object.keys(group.state.unappliedProposals)).toHaveLength(2);
  });

  it("Test 1 (FOUND-01): creating a group with two invitees publishes zero kind-445 events", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    await adminClient.groups.create("Founding Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });

    // The absence assertion reads the mock network's publish log, not the
    // returned value — a spurious founding commit is exactly the failure
    // this pins, and it is only visible in the transport log.
    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(commitEvents).toHaveLength(0);
  });

  it("Test 2 (FOUND-01): the same create publishes exactly one gift wrap per invitee, each addressed to that invitee", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Pubkey = await inviteeAccounts[0]!.signer.getPublicKey();
    const invitee2Pubkey = await inviteeAccounts[1]!.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    await adminClient.groups.create("Founding Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });

    const giftWraps = mockNetwork.events.filter((e) => e.kind === 1059);
    expect(giftWraps).toHaveLength(2);

    const recipientOf = (event: NostrEvent) =>
      event.tags.find((tag) => tag[0] === "p")?.[1];
    expect(giftWraps.map(recipientOf).sort()).toEqual(
      [invitee1Pubkey, invitee2Pubkey].sort(),
    );
    expect(
      giftWraps.filter((e) => recipientOf(e) === invitee1Pubkey),
    ).toHaveLength(1);
    expect(
      giftWraps.filter((e) => recipientOf(e) === invitee2Pubkey),
    ).toHaveLength(1);
  });

  it("Test 3 (FOUND-03): synchronously after create() resolves the group is Stable at epoch 1", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    const group = await adminClient.groups.create("Founding Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });
    // The adjacency here is the assertion (D-01): reading `lifecycle` and
    // `epoch` in the statement immediately following `await create(...)`,
    // with no other `await` between, is the only way "no observable
    // PendingPublish window" is actually checked.
    expect(group.lifecycle).toBe("Stable");
    expect(group.state.groupContext.epoch).toBe(1n);
  });

  it("Test 4 (D-03/R-01): a write-recording store observes exactly one write during a founding GroupFactory.create call, and it decodes to epoch 1", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    // Constructed directly (bypassing GroupsManager/registry) so the write
    // count is attributable to the factory alone.
    const store = new RecordingStorage();
    const factory = new GroupFactory({
      prepare: store.prepare,
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    await factory.create("Founding via factory", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });

    expect(store.writes).toHaveLength(1);
    const decoded = deserializeClientState(store.writes[0]!);
    expect(decoded.groupContext.epoch).toBe(1n);
  });

  it("Test 5 (R-01): no write observed on a founding create ever decodes to epoch 0", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    const store = new RecordingStorage();
    const factory = new GroupFactory({
      prepare: store.prepare,
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    await factory.create("Founding via factory", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });

    expect(store.writes.length).toBeGreaterThan(0);
    for (const write of store.writes) {
      const decoded = deserializeClientState(write);
      expect(decoded.groupContext.epoch).not.toBe(0n);
    }
  });

  it("Test 6 (D-08): creating with no invitees still publishes zero kind-445 events and leaves the group at epoch 0", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();

    const group = await adminClient.groups.create("Solo Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
    });

    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(commitEvents).toHaveLength(0);
    expect(group.state.groupContext.epoch).toBe(0n);
  });

  // ==========================================================================
  // Plan 10-04: behavioural matrix — refusals, partial failure, retry,
  // non-durability, relay-less delivery, fork-tree persistence.
  // ==========================================================================

  it("Test 7 (D-13): creating with a duplicate invitee KeyPackage is refused before anything is burned", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);

    // The same published KeyPackage event listed twice as the invitee list.
    await expect(
      adminClient.groups.create("Founding Group", {
        adminPubkeys: [adminPubkey],
        relays: RELAYS,
        invitees: [invitee1Event, invitee1Event],
      }),
    ).rejects.toThrow();

    // D-13's pre-burn placement is only observable as an absence: the
    // refusal happened before any Welcome gift wrap or commit event was ever
    // published.
    const giftWraps = mockNetwork.events.filter((e) => e.kind === 1059);
    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(giftWraps).toHaveLength(0);
    expect(commitEvents).toHaveLength(0);
  });

  it("Test 8 (FOUND-02): creating with a tampered-signature invitee KeyPackage is refused through the public create() API", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);

    // A legitimately published KeyPackage event, copied with only its `sig`
    // altered (every other field untouched) — exercises the inherited
    // SEC-01 signature gate through the public create() API.
    const tamperedSig =
      invitee1Event.sig.slice(0, -2) +
      (invitee1Event.sig.endsWith("00") ? "11" : "00");
    const tamperedEvent: NostrEvent = {
      ...invitee1Event,
      sig: tamperedSig,
    };
    // A plain object spread copies own enumerable symbol-keyed properties
    // too, including nostr-tools' cached `verifiedSymbol` result from
    // publishing the original event — without clearing it, `verifyEvent`
    // would return the stale cached `true` instead of re-verifying the
    // tampered signature.
    delete (tamperedEvent as Record<PropertyKey, unknown>)[verifiedSymbol];

    await expect(
      adminClient.groups.create("Founding Group", {
        adminPubkeys: [adminPubkey],
        relays: RELAYS,
        invitees: [tamperedEvent],
      }),
    ).rejects.toThrow();

    // A refused founding create leaves no local group: the store holds no
    // keys at all.
    expect(await storedGroups(adminStorage)).toHaveLength(0);
  });

  /**
   * Test 9-12 shared setup: founds a two-invitee group **with group relays
   * supplied** (so the founding Welcome rumor itself is constructible —
   * `createWelcomeRumor` requires a non-empty `relays` tag; see CR-01 in
   * Test 13 below, which now enforces this at `create()`'s entry point)
   * where the second invitee's own NIP-65 inbox-relay lookup resolves to an
   * empty list (published no inbox relays of their own), so `deliver` throws
   * "No relays available" for exactly that recipient while the first
   * invitee succeeds independently.
   */
  async function createFoundingWithSecondInviteeUnreachable() {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Pubkey = await inviteeAccounts[0]!.signer.getPublicKey();
    const invitee2Pubkey = await inviteeAccounts[1]!.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    const reachableLookup = mockNetwork.getUserInboxRelays.bind(mockNetwork);
    mockNetwork.getUserInboxRelays = async (pubkey: string) => {
      if (pubkey === invitee2Pubkey) return [];
      return reachableLookup(pubkey);
    };

    const group = await adminClient.groups.create("Founding Group", {
      adminPubkeys: [adminPubkey],
      relays: RELAYS,
      invitees: [invitee1Event, invitee2Event],
    });

    return {
      adminPubkey,
      invitee1Pubkey,
      invitee2Pubkey,
      group,
      restoreLookup: () => {
        mockNetwork.getUserInboxRelays = reachableLookup;
      },
    };
  }

  it("Test 9 (D-12/FOUND-04): a founding create with one undeliverable invitee still resolves at epoch 1 with all members", async () => {
    const { adminPubkey, invitee1Pubkey, invitee2Pubkey, group } =
      await createFoundingWithSecondInviteeUnreachable();

    // D-12: canonical state is independent of Welcome delivery outcome —
    // read membership from the group's own state, not from the delivery
    // report.
    expect(group.state.groupContext.epoch).toBe(1n);
    expect(group.info.members.pubkeys.slice().sort()).toEqual(
      [adminPubkey, invitee1Pubkey, invitee2Pubkey].sort(),
    );

    expect(group.welcomeDeliveries).toHaveLength(2);
    expect(group.pendingWelcomes).toHaveLength(1);
    expect(group.pendingWelcomes[0]!.recipient.pubkey).toBe(invitee2Pubkey);
  });

  it("Test 10 (FOUND-04): retryWelcome re-delivers exactly the failed invitee's Welcome and clears it from pendingWelcomes", async () => {
    const { invitee2Pubkey, group, restoreLookup } =
      await createFoundingWithSecondInviteeUnreachable();
    expect(group.pendingWelcomes).toHaveLength(1);

    // The invitee becomes reachable; restore the lookup before retrying.
    restoreLookup();
    const giftWrapsBefore = mockNetwork.events.filter(
      (e) => e.kind === 1059,
    ).length;

    const outcome = await group.retryWelcome(invitee2Pubkey);

    expect(outcome.kind).toBe("succeeded");
    expect(group.pendingWelcomes).toHaveLength(0);
    const giftWrapsAfter = mockNetwork.events.filter(
      (e) => e.kind === 1059,
    ).length;
    expect(giftWrapsAfter - giftWrapsBefore).toBe(1);
  });

  it("Test 11 (FOUND-04): retryWelcome rejects for a pubkey that was never an invitee, and no-ops on an already-succeeded invitee", async () => {
    const { invitee1Pubkey, group } =
      await createFoundingWithSecondInviteeUnreachable();

    // A pubkey that was never an invitee of this founding create.
    await expect(group.retryWelcome("a".repeat(64))).rejects.toThrow();

    // invitee1 already succeeded during the founding create — retrying it
    // returns the existing outcome without performing another delivery.
    const giftWrapsBefore = mockNetwork.events.filter(
      (e) => e.kind === 1059,
    ).length;
    const outcome = await group.retryWelcome(invitee1Pubkey);
    expect(outcome.kind).toBe("succeeded");
    const giftWrapsAfter = mockNetwork.events.filter(
      (e) => e.kind === 1059,
    ).length;
    expect(giftWrapsAfter).toBe(giftWrapsBefore);
  });

  it("Test 12 (R-04): a group reloaded from the store reports no pending Welcomes even though an invitee was never reached", async () => {
    const { group } = await createFoundingWithSecondInviteeUnreachable();
    expect(group.pendingWelcomes).toHaveLength(1);

    // A fresh GroupsManager over the SAME store simulates a restart: the
    // in-memory welcomeDeliveries report never survives, because it was
    // never persisted (D-04). This is R-04's accepted, documented
    // silent-loss window — not a bug to fix here. The only recovery is the
    // spec's re-invite path: the founding creator MAY re-invite the
    // unreachable member with a fresh KeyPackage against the now-canonical
    // group (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78).
    const reloadedManager = new GroupsManager({
      database: adminStorage,
      signer: adminAccount.signer,
      network: mockNetwork,
    });
    const reloaded = await reloadedManager.get(group.idStr);

    expect(reloaded.pendingWelcomes).toHaveLength(0);
    expect(reloaded.state.groupContext.epoch).toBe(1n);
    expect(reloaded.info.members.pubkeys).toHaveLength(3);
  });

  it("Test 13 (CR-01; supersedes D-09/R-05): a founding create with invitees but no valid group relays throws before any MLS state is created, and nothing is persisted, tracked or published", async () => {
    // Per the user's 2026-09-28 locked decision (10-VERIFICATION.md CR-01),
    // this reverses D-09: a founding create with invitees and no valid group
    // relays now fails closed, before any MLS state exists, instead of
    // silently producing a persisted group with N phantom members whose
    // Welcomes all fail (createWelcomeRumor() throws unconditionally for
    // every recipient when the relays tag would be empty).
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    const signEventSpy = vi.spyOn(adminAccount.signer, "signEvent");
    const createdSpy = vi.fn();
    adminClient.groups.on("created", createdSpy);

    const relayShapes: (string[] | undefined)[] = [
      undefined,
      [],
      [""],
      ["https://relay.example.com"],
      ["not a relay url"],
      ["wss://mock-relay.test", ""],
    ];

    for (const relays of relayShapes) {
      const options =
        relays === undefined
          ? {
              adminPubkeys: [adminPubkey],
              invitees: [invitee1Event, invitee2Event],
            }
          : {
              adminPubkeys: [adminPubkey],
              relays,
              invitees: [invitee1Event, invitee2Event],
            };
      await expect(
        adminClient.groups.create("Founding Group", options),
      ).rejects.toThrow(
        /founding invitees require a non-empty list of valid group relays/,
      );
    }

    // The refusal preceded creator KeyPackage generation entirely — the
    // 0x8009 account-identity proof it carries is signed via signEvent — so
    // nothing MLS-related was ever built, let alone persisted or published.
    expect(signEventSpy).not.toHaveBeenCalled();
    expect(await storedGroups(adminStorage)).toHaveLength(0);
    expect(adminClient.groups.loaded).toHaveLength(0);
    expect(await adminClient.groups.listIds()).toHaveLength(0);
    expect(createdSpy).not.toHaveBeenCalled();

    const giftWraps = mockNetwork.events.filter((e) => e.kind === 1059);
    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(giftWraps).toHaveLength(0);
    expect(commitEvents).toHaveLength(0);
  });

  it("Test 14: a founding create driven through a GroupsManager binds the supplied history tree to its storage before the single save", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();
    const invitee1Event = await publishKeyPackage(inviteeClients[0]!);
    const invitee2Event = await publishKeyPackage(inviteeClients[1]!);

    const storage = memoryDatabase();
    const manager = new GroupsManager({
      database: storage,
      signer: adminAccount.signer,
      network: mockNetwork,
    });

    // Regression pin for the bound-tree requirement: if the founding
    // engine's supplied GroupHistoryTree were not bound to storage
    // before the single save() runs, its history.flush() would throw here.
    await expect(
      manager.create("Founding via manager", {
        adminPubkeys: [adminPubkey],
        relays: RELAYS,
        invitees: [invitee1Event, invitee2Event],
      }),
    ).resolves.toBeDefined();

    const group = manager.loaded[0]!;
    expect(
      await (await storage.groups.open(group.idStr)).meta.get("tree"),
    ).toBeDefined();
  });

  it("Test 15 (CR-01 scope): a solo create without relays — invitees omitted or empty — is still allowed and stays at epoch 0", async () => {
    const adminPubkey = await adminAccount.signer.getPublicKey();

    const soloOmitted = await adminClient.groups.create("Solo relay-less", {
      adminPubkeys: [adminPubkey],
    });
    expect(soloOmitted.state.groupContext.epoch).toBe(0n);

    const soloEmptyInvitees = await adminClient.groups.create(
      "Solo relay-less, empty invitees",
      {
        adminPubkeys: [adminPubkey],
        invitees: [],
      },
    );
    expect(soloEmptyInvitees.state.groupContext.epoch).toBe(0n);

    const giftWraps = mockNetwork.events.filter((e) => e.kind === 1059);
    const commitEvents = mockNetwork.events.filter(
      (e) => e.kind === GROUP_EVENT_KIND,
    );
    expect(giftWraps).toHaveLength(0);
    expect(commitEvents).toHaveLength(0);
  });
});
