/**
 * Client-level absence and single-write proofs for founding Current-profile
 * group creation via Welcome (FOUND-01, FOUND-03).
 *
 * Covers decisions D-01 (stage the founding Add and confirm it with no
 * observable `PendingPublish` window), D-03 (only epoch 1 is durable — one
 * write), and D-08 (`options.invitees` on the existing `create()`; omitting
 * it keeps today's exact solo-create behaviour and code path), plus risk
 * R-01 (an unconfirmed `foundingGroupCreated` result must be caught, not
 * silently left as stale staged state — proven here as "no persisted
 * artifact ever observes epoch 0 for a founding create").
 *
 * See `refs/marmot/protocol-core/joining.md` lines 21-30 (the
 * founding-creation exception: a founding Add Commit from epoch 0 to epoch 1
 * has no group-message publication obligation because no pre-existing peer
 * needs it) and `refs/marmot/protocol-core/publish-lifecycle.md` lines 66-78
 * (each resulting epoch-1 Welcome is a separate retryable per-invitee
 * delivery obligation; a Welcome delivery succeeds or fails independently
 * and does not affect canonical group state).
 *
 * Plan 10-04 extends this same file with the behavioural matrix (duplicate
 * invitees, partial Welcome failure, retry, relay-less delivery,
 * non-durability, fork-tree persistence) — this file stays scoped to the
 * absence/single-write proofs only.
 */
import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { beforeEach, describe, expect, it } from "vitest";

import { MarmotClient } from "../marmot-client.js";
import { GroupFactory } from "../group-factory.js";
import {
  deserializeClientState,
  type SerializedClientState,
} from "../../core/client-state.js";
import {
  ADDRESSABLE_KEY_PACKAGE_KIND,
  GROUP_EVENT_KIND,
} from "../../core/protocol.js";
import type { StoredKeyPackage } from "../key-package-manager.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";

const RELAYS = ["wss://mock-relay.test"];

/**
 * Wraps an {@link InMemoryKeyValueStore} to record every `setItem` value
 * before delegating — used by Tests 4-5 to attribute the write count to
 * `GroupFactory` alone, independent of registry tracking.
 */
class RecordingKeyValueStore<T> implements GenericKeyValueStore<T> {
  readonly writes: T[] = [];
  readonly #inner = new InMemoryKeyValueStore<T>();

  async getItem(key: string): Promise<T | null> {
    return this.#inner.getItem(key);
  }

  async setItem(key: string, value: T): Promise<T> {
    this.writes.push(value);
    return this.#inner.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    return this.#inner.removeItem(key);
  }

  async clear(): Promise<void> {
    return this.#inner.clear();
  }

  async keys(): Promise<string[]> {
    return this.#inner.keys();
  }
}

describe("Founding group creation via Welcome (FOUND-01, FOUND-03; D-01/D-03/D-08; R-01)", () => {
  let mockNetwork: MockNetwork;
  let adminAccount: PrivateKeyAccount<any>;
  let adminClient: MarmotClient;
  let inviteeAccounts: PrivateKeyAccount<any>[];
  let inviteeClients: MarmotClient[];

  beforeEach(() => {
    mockNetwork = new MockNetwork(RELAYS);
    adminAccount = PrivateKeyAccount.generateNew();
    adminClient = new MarmotClient({
      groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
      keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
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
          groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
          keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
          signer: account.signer,
          network: mockNetwork,
          clientId: `test-invitee-${index}`,
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
    const store = new RecordingKeyValueStore<SerializedClientState>();
    const factory = new GroupFactory({
      store,
      ingestStateStore: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
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

    const store = new RecordingKeyValueStore<SerializedClientState>();
    const factory = new GroupFactory({
      store,
      ingestStateStore: new InMemoryKeyValueStore(),
      lifecycleStore: new InMemoryKeyValueStore(),
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
});
