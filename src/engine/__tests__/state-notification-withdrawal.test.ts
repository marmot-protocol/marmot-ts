import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers/event";
import { getEventHash } from "applesauce-core/helpers/event";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  mlsMessageEncoder,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import {
  commitDigest,
  DEFAULT_CONVERGENCE_POLICY,
} from "../../core/convergence.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  decryptGroupMessages,
} from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import type { SerializedClientState } from "../../core/client-state.js";
import type { EventSigner } from "applesauce-core";
import { deriveStateNotifications } from "../state-notifications.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler } from "../types.js";

const RELAY = "wss://relay.test";
const CUSTOM_COMPONENT_ID = 0x9001;

function testPeeler(ciphersuite: CiphersuiteImpl): GroupPeeler<NostrEvent> {
  return {
    async peelGroupMessages(envelopes, state) {
      const { read, unreadable } = await decryptGroupMessages(
        envelopes,
        state,
        ciphersuite,
      );
      return {
        read: read.map(({ event, message }) => ({ envelope: event, message })),
        unreadable,
      };
    },
    wrapGroupMessage(message, state) {
      return createGroupEvent({ message, state, ciphersuite });
    },
    idOf(envelope) {
      return envelope.id;
    },
  };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

/** A 2-member group (admin + one member), both at epoch 1. */
async function twoMemberEpoch1Group() {
  const adminPubkey = "a".repeat(64);
  const memberPubkey = "e".repeat(64);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(
    adminKp,
    impl,
    "Group",
    { adminPubkeys: [adminPubkey], relays: [RELAY] },
  );
  const memberKp = await generateKeyPackage({
    credential: createCredential(memberPubkey),
    ciphersuiteImpl: impl,
  });
  const { newState: adminEpoch1, welcome } = await createCommit({
    context: ctx,
    state: created,
    wireAsPublicMessage: false,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: memberKp.publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const memberEpoch1 = await joinGroup({
    context: ctx,
    welcome: welcome!.welcome ?? (welcome as never),
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });
  return { impl, ctx, adminPubkey, memberPubkey, adminEpoch1, memberEpoch1 };
}

/** Wraps a valid Marmot application-message envelope from `senderPubkey`
 * against `state`, mirroring `ingest-commit-race.test.ts`'s M7 fixture. */
async function buildAppEvent(
  ctx: {
    cipherSuite: CiphersuiteImpl;
    authService: typeof unsafeTestingAuthenticationService;
  },
  state: Parameters<typeof createApplicationMessage>[0]["state"],
  senderPubkey: string,
  content: string,
  ciphersuite: CiphersuiteImpl,
): Promise<NostrEvent> {
  const rumor: Rumor = {
    id: "",
    kind: 1,
    content,
    tags: [],
    created_at: 1_700_000_000,
    pubkey: senderPubkey,
  };
  rumor.id = getEventHash(rumor);
  const payload = new TextEncoder().encode(JSON.stringify(rumor));
  const app = await createApplicationMessage({
    context: ctx,
    state,
    message: payload,
  });
  return createGroupEvent({ message: app.message, state, ciphersuite });
}

function noNetwork(): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async () => {
      throw new Error("not used");
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

describe("state notification derivation + withdrawal (CONV-03, D-10/D-11)", () => {
  it("derives epochAdvanced and memberAdded, both carrying the same commitDigest, for a commit that adds a member", async () => {
    const adminPubkey = "a".repeat(64);
    const member1Pubkey = "d".repeat(64);
    const member2Pubkey = "e".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const member1Kp = await generateKeyPackage({
      credential: createCredential(member1Pubkey),
      ciphersuiteImpl: impl,
    });
    const { newState: adminEpoch1, welcome: welcome1 } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: member1Kp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const member1Epoch1 = await joinGroup({
      context: ctx,
      welcome: welcome1!.welcome ?? (welcome1 as never),
      keyPackage: member1Kp.publicPackage,
      privateKeys: member1Kp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin adds a SECOND member from epoch 1 -> 2; member1 observes this
    // inbound (never authored it) so it goes through the direct in-order
    // commit branch that derives + records notifications.
    const member2Kp = await generateKeyPackage({
      credential: createCredential(member2Pubkey),
      ciphersuiteImpl: impl,
    });
    const { commit: addCommit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: member2Kp.publicPackage },
        },
      ],
    });
    const addEvent = await createGroupEvent({
      message: addCommit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const expectedDigest = commitDigest(encode(mlsMessageEncoder, addCommit));

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: member1Epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const results: { kind: string; notifications?: unknown }[] = [];
    for await (const r of engine.ingest([addEvent])) results.push(r as never);

    const processed = results.find((r) => r.kind === "processed") as
      | {
          kind: "processed";
          notifications?: import("../state-notifications.js").StateNotification[];
        }
      | undefined;
    expect(processed).toBeDefined();
    const notifications = processed!.notifications ?? [];

    const epochAdvanced = notifications.find((n) => n.kind === "epochAdvanced");
    expect(epochAdvanced).toEqual({
      kind: "epochAdvanced",
      commitDigest: expectedDigest,
      from: 1,
      to: 2,
    });

    const memberAdded = notifications.find((n) => n.kind === "memberAdded");
    expect(memberAdded).toEqual({
      kind: "memberAdded",
      commitDigest: expectedDigest,
      pubkey: member2Pubkey,
    });
  });

  it("derives a memberRemoved notification (no actor) for a commit that removes a different member", async () => {
    const adminPubkey = "a".repeat(64);
    const member1Pubkey = "d".repeat(64);
    const member2Pubkey = "e".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: adminEpoch0 } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const member1Kp = await generateKeyPackage({
      credential: createCredential(member1Pubkey),
      ciphersuiteImpl: impl,
    });
    const member2Kp = await generateKeyPackage({
      credential: createCredential(member2Pubkey),
      ciphersuiteImpl: impl,
    });
    const add = await createCommit({
      context: ctx,
      state: adminEpoch0,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: member1Kp.publicPackage },
        },
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: member2Kp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const adminEpoch1 = add.newState;
    const member1Epoch1 = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: member1Kp.publicPackage,
      privateKeys: member1Kp.privatePackage,
      ratchetTree: undefined,
    });
    const member2Epoch1 = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: member2Kp.publicPackage,
      privateKeys: member2Kp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin removes member2; member1 (the observer) is a genuine third party,
    // never the target, so its own state stays active (not removedFromGroup).
    const { commit: removeCommit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: member2Epoch1.privatePath.leafIndex },
        },
      ],
    });
    const removeEvent = await createGroupEvent({
      message: removeCommit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const expectedDigest = commitDigest(
      encode(mlsMessageEncoder, removeCommit),
    );

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: member1Epoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const results: { kind: string; notifications?: unknown }[] = [];
    for await (const r of engine.ingest([removeEvent]))
      results.push(r as never);

    expect(engine.state.groupActiveState.kind).not.toBe("removedFromGroup");
    const processed = results.find((r) => r.kind === "processed") as
      | {
          kind: "processed";
          notifications?: import("../state-notifications.js").StateNotification[];
        }
      | undefined;
    expect(processed).toBeDefined();
    const notifications = processed!.notifications ?? [];
    const memberRemoved = notifications.find((n) => n.kind === "memberRemoved");
    expect(memberRemoved).toEqual({
      kind: "memberRemoved",
      commitDigest: expectedDigest,
      pubkey: member2Pubkey,
    });
  });

  it("derives a componentChanged notification for exactly the updated component id", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    const componentBytes = new Uint8Array([1, 2, 3, 4]);
    const { commit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: CUSTOM_COMPONENT_ID,
            operation: "update",
            update: componentBytes,
          },
        },
      ],
    });
    const event = await createGroupEvent({
      message: commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const results: { kind: string; notifications?: unknown }[] = [];
    for await (const r of engine.ingest([event])) results.push(r as never);

    const processed = results.find((r) => r.kind === "processed") as
      | {
          kind: "processed";
          notifications?: import("../state-notifications.js").StateNotification[];
        }
      | undefined;
    expect(processed).toBeDefined();
    const notifications = processed!.notifications ?? [];
    const componentChanged = notifications.filter(
      (n) => n.kind === "componentChanged",
    );
    expect(componentChanged).toHaveLength(1);
    expect(componentChanged[0]).toMatchObject({
      kind: "componentChanged",
      componentId: CUSTOM_COMPONENT_ID,
    });
  });

  it("is deterministic: two calls over the same parent/resulting pair return an identical array", async () => {
    const { ctx, adminEpoch1 } = await twoMemberEpoch1Group();

    const { commit, newState } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: CUSTOM_COMPONENT_ID,
            operation: "update",
            update: new Uint8Array([9, 9]),
          },
        },
      ],
    });
    const digest = commitDigest(encode(mlsMessageEncoder, commit));

    const first = deriveStateNotifications({
      parentState: adminEpoch1,
      resultingState: newState,
      commitDigest: digest,
    });
    const second = deriveStateNotifications({
      parentState: adminEpoch1,
      resultingState: newState,
      commitDigest: digest,
    });
    expect(second).toEqual(first);
  });

  it("withdraws exactly a superseded commit's notifications when a rewind lands on a competing branch", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    // Two competing commits from the same epoch-1 admin state: one applied
    // first as our canonical (in-order) tip, one that arrives late and wins
    // the digest tie-break, forcing a real rewind.
    const componentA = new Uint8Array([1]);
    const componentB = new Uint8Array([2]);
    let applied = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: CUSTOM_COMPONENT_ID,
            operation: "update",
            update: componentA,
          },
        },
      ],
    });
    let winner = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: CUSTOM_COMPONENT_ID,
            operation: "update",
            update: componentB,
          },
        },
      ],
    });

    // Search for a `winner` digest that beats `applied`'s (lower wins the
    // same-epoch tie-break), so the SECOND-arriving commit forces a real
    // rewind rather than losing (mirrors convergence-parity.test.ts).
    let attempts = 0;
    const appliedKey = () =>
      commitDigest(encode(mlsMessageEncoder, applied.commit));
    const winnerKey = () =>
      commitDigest(encode(mlsMessageEncoder, winner.commit));
    // AppDataUpdate-only commits carry no UpdatePath (nothing tree-related to
    // randomize), so `createCommit` is fully deterministic for identical
    // inputs — the search must vary the component bytes per attempt, not rely
    // on internal randomization (unlike a path-changing proposal).
    while (
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())) <=
        0 &&
      attempts < 25
    ) {
      attempts++;
      winner = await createCommit({
        context: ctx,
        state: adminEpoch1,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [
          {
            proposalType: appDataUpdateProposalType,
            appDataUpdate: {
              componentId: CUSTOM_COMPONENT_ID,
              operation: "update",
              update: new Uint8Array([2, attempts]),
            },
          },
        ],
      });
    }
    expect(
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())),
    ).toBeGreaterThan(0);

    const appliedDigest = appliedKey();
    const winnerDigest = winnerKey();

    const appliedEvent = await createGroupEvent({
      message: applied.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const winnerEvent = await createGroupEvent({
      message: winner.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    // Apply the (losing) branch first — it becomes canonical and its
    // notification is ledger-recorded via the direct in-order branch.
    await drain(engine.ingest([appliedEvent]));
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    // The winning competitor arrives late, forcing a real rewind.
    const results: {
      kind: string;
      commitDigest?: Uint8Array;
      withdrawn?: import("../state-notifications.js").StateNotification[];
    }[] = [];
    for await (const r of engine.ingest([winnerEvent]))
      results.push(r as never);

    const invalidations = results.filter((r) => r.kind === "stateInvalidated");
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0].commitDigest).toEqual(appliedDigest);
    const withdrawn = invalidations[0].withdrawn ?? [];
    expect(
      withdrawn.some(
        (n) =>
          n.kind === "componentChanged" &&
          n.componentId === CUSTOM_COMPONENT_ID,
      ),
    ).toBe(true);
    // Every withdrawn notification is attributed to the superseded commit.
    for (const n of withdrawn) expect(n.commitDigest).toEqual(appliedDigest);
    // None of the withdrawn notifications belong to the winning commit.
    for (const n of withdrawn) expect(n.commitDigest).not.toEqual(winnerDigest);

    // Converged onto the winning branch.
    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(winner.newState.confirmationTag),
    );
  });

  it("yields stateInvalidated before any invalidated app-payload result at a rewind site", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    let applied = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    let winner = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    let attempts = 0;
    const appliedKey = () =>
      commitDigest(encode(mlsMessageEncoder, applied.commit));
    const winnerKey = () =>
      commitDigest(encode(mlsMessageEncoder, winner.commit));
    while (
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())) <=
        0 &&
      attempts < 25
    ) {
      winner = await createCommit({
        context: ctx,
        state: adminEpoch1,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
      attempts++;
    }
    expect(
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())),
    ).toBeGreaterThan(0);

    const appliedEvent = await createGroupEvent({
      message: applied.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });
    const winnerEvent = await createGroupEvent({
      message: winner.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    await drain(engine.ingest([appliedEvent]));

    // An app payload delivered eagerly on the (about-to-be-abandoned) applied
    // branch, epoch 2 — mirrors ingest-commit-race.test.ts's M7 fixture.
    const losingAppEvent = await buildAppEvent(
      ctx,
      applied.newState,
      adminPubkey,
      "message on the losing branch",
      impl,
    );
    let delivered = false;
    for await (const r of engine.ingest([losingAppEvent])) {
      if (r.kind === "processed") delivered = true;
    }
    expect(delivered).toBe(true);

    const kinds: string[] = [];
    for await (const r of engine.ingest([winnerEvent])) kinds.push(r.kind);

    const invalidatedIndex = kinds.indexOf("invalidated");
    const stateInvalidatedIndex = kinds.indexOf("stateInvalidated");
    expect(stateInvalidatedIndex).toBeGreaterThanOrEqual(0);
    expect(invalidatedIndex).toBeGreaterThanOrEqual(0);
    expect(stateInvalidatedIndex).toBeLessThan(invalidatedIndex);
  });

  it("clears the persisted removed-inactive marker when ingest yields a stateInvalidated result whose withdrawn set contains selfRemoved (CONV-03)", async () => {
    // This test targets ONLY the marker-clearing wiring Task 3 adds to
    // `MarmotGroup#ingest` — the `result.kind === "stateInvalidated"` branch
    // that calls `#clearRemovalMarker()` when `withdrawn` contains a
    // `selfRemoved` entry. The engine-level mechanics of DERIVING and
    // WITHDRAWING notifications (including `selfRemoved`) at a real rewind are
    // proven end-to-end by the two tests above, driven by a real
    // `MarmotGroupEngine`. Composing BOTH into one scenario is not currently
    // reachable: `ForkRecovery`'s branch exploration deduplicates candidates
    // by resulting `confirmationTag` (`fork-recovery.ts`'s `seen` set), and a
    // `removedFromGroup` tombstone's `confirmationTag` is identical to its
    // parent's (ts-mls has no legitimate new transcript hash to compute for
    // the party being removed) — so a commit that would remove the *observing*
    // party can never become a distinct, explorable candidate via pool-replay
    // fork recovery, and the direct in-order removal branch deliberately skips
    // retained-history/tree recording ("retained history is moot" once
    // removed), so the tree never learns of it for a later tree-fed
    // reconvergence either. This is a pre-existing engine/ts-mls interaction,
    // not something this plan's tasks touch.
    const { memberEpoch1, memberPubkey } = await twoMemberEpoch1Group();

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
    const idHex = bytesToHex(memberEpoch1.groupContext.groupId);
    // Simulate a prior removal already realized (marker set) — exactly the
    // state `#realizeRemovalIfNeeded` leaves behind after a genuine removal.
    await removedMarkerStore.setItem(idHex, true);

    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const group = new MarmotGroup(memberEpoch1, {
      store,
      removedMarkerStore,
      signer: { getPublicKey: async () => memberPubkey } as EventSigner,
      ciphersuite: impl,
      network: noNetwork(),
    });

    // Craft exactly the shape the engine yields at a rewind site once a
    // withdrawn set contains `selfRemoved` (D-11) — the trigger the
    // marker-clearing branch added to `MarmotGroup#ingest` reacts to.
    const withdrawnSelfRemoved: import("../state-notifications.js").StateNotification =
      {
        kind: "selfRemoved",
        commitDigest: new Uint8Array(32),
      };
    (
      group.session as unknown as {
        ingest: (events: NostrEvent[]) => AsyncGenerator<{
          kind: "stateInvalidated";
          commitDigest: Uint8Array;
          forkEpoch: number;
          withdrawn: import("../state-notifications.js").StateNotification[];
          disposition: { kind: "invalidated" };
        }>;
      }
    ).ingest = async function* () {
      yield {
        kind: "stateInvalidated",
        commitDigest: new Uint8Array(32),
        forkEpoch: 1,
        withdrawn: [withdrawnSelfRemoved],
        disposition: { kind: "invalidated" },
      };
    };

    for await (const _ of group.ingest([])) void _;

    expect(await removedMarkerStore.getItem(idHex)).toBeFalsy();
  });

  it("prunes the notification ledger below the retained anchor, so an old commit's notifications cannot be resurrected past the horizon", async () => {
    const { impl, ctx, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: memberEpoch1,
      ciphersuite: impl,
      // Tight horizon: only the current + 1 prior epoch stay retained.
      convergencePolicy: { ...DEFAULT_CONVERGENCE_POLICY, maxRewindCommits: 1 },
      peeler: testPeeler(impl),
    });

    // A commit at the (soon to be pruned) epoch 1 -> 2 boundary.
    let state = adminEpoch1;
    const c1 = await createCommit({
      context: ctx,
      state,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [
        {
          proposalType: appDataUpdateProposalType,
          appDataUpdate: {
            componentId: CUSTOM_COMPONENT_ID,
            operation: "update",
            update: new Uint8Array([1]),
          },
        },
      ],
    });
    const c1Event = await createGroupEvent({
      message: c1.commit,
      state,
      ciphersuite: impl,
    });
    await drain(engine.ingest([c1Event]));
    state = c1.newState;

    // Two more in-order commits advance the tip so the anchor moves past
    // epoch 1's retained state.
    for (let i = 0; i < 2; i++) {
      const next = await createCommit({
        context: ctx,
        state,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
      const event = await createGroupEvent({
        message: next.commit,
        state,
        ciphersuite: impl,
      });
      await drain(engine.ingest([event]));
      state = next.newState;
    }
    expect(Number(engine.state.groupContext.epoch)).toBe(4);
    const tipBefore = bytesToHex(engine.state.confirmationTag);

    // A late competitor sourced from the now-pruned epoch 1 -> 2 boundary: the
    // retained (`RetainedHistoryStore`) state for epoch 1 is gone, so it can
    // never reach `resolveFork`/withdraw anything at that fork point — the
    // ledger's own commit-1 notifications (pruned below the anchor above) are
    // unreachable regardless of whatever the history-tree sweep does with the
    // stray commit. The canonical tip stays exactly where it was.
    const competitor = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const competitorEvent = await createGroupEvent({
      message: competitor.commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    const results: { kind: string; reason?: string }[] = [];
    for await (const r of engine.ingest([competitorEvent]))
      results.push(r as never);

    expect(results.some((r) => r.kind === "stateInvalidated")).toBe(false);
    // The canonical branch is unaffected — nothing below the retained anchor
    // can ever be withdrawn from or rewound onto.
    expect(Number(engine.state.groupContext.epoch)).toBe(4);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(tipBefore);
  });
});
