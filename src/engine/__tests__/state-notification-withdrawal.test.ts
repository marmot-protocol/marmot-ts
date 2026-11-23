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

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
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
import { memoryGroupDatabase } from "../../__tests__/helpers/database.js";
import { groupMetaStore } from "../../client/storage/database/group-batch.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import { ConvergenceEffectLedger } from "../../client/storage/wrapper-ledger.js";
import { deriveStateNotifications } from "../state-notifications.js";
import { MarmotGroupEngine } from "../group-engine.js";
import type { GroupPeeler, IngestResult } from "../types.js";

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
  const adminAccount = testAccount(6);
  const memberAccount = testAccount(11);
  const adminPubkey = adminAccount.pubkey;
  const memberPubkey = memberAccount.pubkey;
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
    signer: adminAccount.signer,
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
    signer: memberAccount.signer,
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
    welcome: welcome!.welcome,
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
  it("persists exactly-once withdrawal and revalidation verdicts", async () => {
    const store = memoryGroupDatabase();
    const digest = new Uint8Array(32).fill(7);
    const notification = {
      kind: "epochAdvanced" as const,
      commitDigest: digest,
      from: 1,
      to: 2,
    };
    const first = new ConvergenceEffectLedger(store);

    expect(await first.prepareWithdrawal(digest, 1, [notification])).toBe(true);
    expect(await first.prepareWithdrawal(digest, 1, [notification])).toBe(true);

    const restarted = new ConvergenceEffectLedger(store);
    expect(await restarted.pending()).toEqual([
      {
        kind: "stateInvalidated",
        commitDigest: digest,
        forkEpoch: 1,
        withdrawn: [notification],
      },
    ]);
    await restarted.acknowledge(digest, "withdrawal");
    expect(await restarted.pending()).toEqual([]);
    expect(await restarted.prepareAdoption(digest, [notification])).toBe(true);
    expect(await restarted.prepareAdoption(digest, [notification])).toBe(true);
    expect((await restarted.pending())[0]).toMatchObject({
      kind: "stateRevalidated",
      commitDigest: digest,
    });
    await restarted.acknowledge(digest, "adoption");
    expect(await restarted.prepareAdoption(digest, [notification])).toBe(false);
  });
  it("attributes notifications for locally confirmed commit and selfUpdate", async () => {
    const { impl, adminPubkey, adminEpoch1 } = await twoMemberEpoch1Group();
    const engine = new MarmotGroupEngine<NostrEvent>({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const commitResult = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (commitResult.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    const commitNotifications = engine.confirmPublished(commitResult.pending);
    const localCommitDigest = commitDigest(
      encode(mlsMessageEncoder, commitResult.pending.commitMessage!),
    );
    expect(commitNotifications).toContainEqual({
      kind: "epochAdvanced",
      commitDigest: localCommitDigest,
      from: 1,
      to: 2,
    });

    const selfUpdateResult = await engine.send({ kind: "selfUpdate" });
    if (selfUpdateResult.kind !== "selfUpdate")
      throw new Error("expected selfUpdate");
    const selfUpdateNotifications = engine.confirmPublished(
      selfUpdateResult.pending,
    );
    const selfUpdateDigest = commitDigest(
      encode(mlsMessageEncoder, selfUpdateResult.pending.commitMessage!),
    );
    expect(selfUpdateNotifications).toContainEqual({
      kind: "epochAdvanced",
      commitDigest: selfUpdateDigest,
      from: 2,
      to: 3,
    });
    for (const notification of selfUpdateNotifications)
      expect(notification.commitDigest).toEqual(selfUpdateDigest);
  });
  it("derives epochAdvanced and memberAdded, both carrying the same commitDigest, for a commit that adds a member", async () => {
    const adminAccount = testAccount(6);
    const member1Account = testAccount(9);
    const member2Account = testAccount(11);
    const adminPubkey = adminAccount.pubkey;
    const member1Pubkey = member1Account.pubkey;
    const member2Pubkey = member2Account.pubkey;
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
      signer: adminAccount.signer,
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
      signer: member1Account.signer,
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
      welcome: welcome1!.welcome,
      keyPackage: member1Kp.publicPackage,
      privateKeys: member1Kp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin adds a SECOND member from epoch 1 -> 2; member1 observes this
    // inbound (never authored it) so it goes through the direct in-order
    // commit branch that derives + records notifications.
    const member2Kp = await generateKeyPackage({
      credential: createCredential(member2Pubkey),
      signer: member2Account.signer,
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

    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([addEvent])) results.push(r);

    const processed = results.find((r) => r.kind === "processed");
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
    const adminAccount = testAccount(6);
    const member1Account = testAccount(9);
    const member2Account = testAccount(11);
    const adminPubkey = adminAccount.pubkey;
    const member1Pubkey = member1Account.pubkey;
    const member2Pubkey = member2Account.pubkey;
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
      signer: adminAccount.signer,
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
      signer: member1Account.signer,
      ciphersuiteImpl: impl,
    });
    const member2Kp = await generateKeyPackage({
      credential: createCredential(member2Pubkey),
      signer: member2Account.signer,
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

    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([removeEvent])) results.push(r);

    expect(engine.state.groupActiveState.kind).not.toBe("removedFromGroup");
    const processed = results.find((r) => r.kind === "processed");
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

    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([event])) results.push(r);

    const processed = results.find((r) => r.kind === "processed");
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
    //
    // BOTH sides are regenerated on every attempt. Varying only `winner`
    // against a fixed `applied` does not give independent 50/50 trials: it
    // asks "is `applied` the minimum of the whole candidate set", which fails
    // with probability 1/(attempts+1) — ~4% at 25 attempts, and that is
    // exactly how often this test used to fail. Re-drawing both makes each
    // attempt independent, so 25 attempts fail with probability 2^-25.
    //
    // AppDataUpdate-only commits carry no UpdatePath (nothing tree-related to
    // randomize), so `createCommit` is fully deterministic for identical
    // inputs — the search must vary the component bytes per attempt, not rely
    // on internal randomization (unlike a path-changing proposal).
    const appliedKey = () =>
      commitDigest(encode(mlsMessageEncoder, applied.commit));
    const winnerKey = () =>
      commitDigest(encode(mlsMessageEncoder, winner.commit));
    const commitWithComponent = (update: Uint8Array) =>
      createCommit({
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
              update,
            },
          },
        ],
      });
    for (
      let attempts = 1;
      attempts <= 25 &&
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())) <= 0;
      attempts++
    ) {
      applied = await commitWithComponent(new Uint8Array([1, attempts]));
      winner = await commitWithComponent(new Uint8Array([2, attempts]));
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
    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([winnerEvent])) results.push(r);

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

  it("withdraws notifications recorded by confirmPublished when a peer fork wins", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();
    const engine = new MarmotGroupEngine<NostrEvent>({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
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
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    const localDigest = commitDigest(
      encode(mlsMessageEncoder, sent.pending.commitMessage!),
    );

    // The local commit carries an AppDataUpdate, so it is a privileged tip and
    // beats a lone peer self-update at the same depth (`convergence.md`
    // "Branch selection", step 4). The peer branch therefore wins on depth:
    // two self-updates on top of the shared parent.
    const peerFirst = await createCommit({
      context: ctx,
      state: memberEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const peerSecond = await createCommit({
      context: ctx,
      state: peerFirst.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });

    const confirmed = engine.confirmPublished(sent.pending);
    expect(confirmed.map((notification) => notification.kind)).toEqual(
      expect.arrayContaining(["epochAdvanced", "componentChanged"]),
    );

    const results: IngestResult<NostrEvent>[] = [];
    for await (const result of engine.ingest([
      await createGroupEvent({
        message: peerFirst.commit,
        state: memberEpoch1,
        ciphersuite: impl,
      }),
      await createGroupEvent({
        message: peerSecond.commit,
        state: peerFirst.newState,
        ciphersuite: impl,
      }),
    ])) {
      results.push(result);
    }

    const invalidatedIndex = results.findIndex(
      (result) => result.kind === "stateInvalidated",
    );
    expect(invalidatedIndex).toBeGreaterThanOrEqual(0);
    const invalidated = results[invalidatedIndex];
    if (invalidated.kind !== "stateInvalidated")
      throw new Error("expected attributed invalidation");
    expect(invalidated.commitDigest).toEqual(localDigest);
    expect(
      invalidated.withdrawn?.map((notification) => notification.kind),
    ).toEqual(expect.arrayContaining(["epochAdvanced", "componentChanged"]));
    for (const notification of invalidated.withdrawn ?? []) {
      expect(notification.commitDigest).toEqual(localDigest);
      for (const peer of [peerFirst, peerSecond])
        expect(notification.commitDigest).not.toEqual(
          commitDigest(encode(mlsMessageEncoder, peer.commit)),
        );
    }
    const payloadInvalidatedIndex = results.findIndex(
      (result) => result.kind === "invalidated",
    );
    if (payloadInvalidatedIndex >= 0)
      expect(invalidatedIndex).toBeLessThan(payloadInvalidatedIndex);
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
    const appliedKey = () =>
      commitDigest(encode(mlsMessageEncoder, applied.commit));
    const winnerKey = () =>
      commitDigest(encode(mlsMessageEncoder, winner.commit));
    const selfUpdate = () =>
      createCommit({
        context: ctx,
        state: adminEpoch1,
        wireAsPublicMessage: true,
        ratchetTreeExtension: true,
        extraProposals: [],
      });
    // Re-draw BOTH sides per attempt — see the same search in "withdraws
    // exactly a superseded commit's notifications" for why varying only
    // `winner` gives a ~4% failure rate instead of 2^-25.
    for (
      let attempts = 0;
      attempts < 25 &&
      Buffer.compare(Buffer.from(appliedKey()), Buffer.from(winnerKey())) <= 0;
      attempts++
    ) {
      applied = await selfUpdate();
      winner = await selfUpdate();
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

  it("keeps a legacy removal marker when ingest reports an unattributed selfRemoved withdrawal", async () => {
    // A volatile withdrawal is not durable recovery authority. The real positive
    // removal lifecycle is covered by client/group/removal-recovery.test.ts.
    const { memberEpoch1 } = await twoMemberEpoch1Group();

    const database = memoryGroupDatabase();
    const storage = groupMetaStore(database);
    const removedMarkerKey = "removed";
    // Simulate a prior removal already realized (marker set) — exactly the
    // state `#realizeRemovalIfNeeded` leaves behind after a genuine removal.
    await storage.set(removedMarkerKey, Uint8Array.of(1));

    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const group = new MarmotGroup(memberEpoch1, {
      database,
      signer: testAccount(11).signer,
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
    group.session.ingest = async function* () {
      yield {
        kind: "stateInvalidated",
        commitDigest: new Uint8Array(32),
        forkEpoch: 1,
        withdrawn: [withdrawnSelfRemoved],
        disposition: { kind: "invalidated" },
      };
    };

    for await (const _ of group.ingest([])) void _;

    expect(await storage.get(removedMarkerKey)).toEqual(Uint8Array.of(1));
  });

  it("keeps a legacy removal marker when reconverge reports an unattributed selfRemoved withdrawal", async () => {
    const { memberEpoch1 } = await twoMemberEpoch1Group();

    const database = memoryGroupDatabase();
    const storage = groupMetaStore(database);
    const removedMarkerKey = "removed";
    await storage.set(removedMarkerKey, Uint8Array.of(1));

    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const group = new MarmotGroup(memberEpoch1, {
      database,
      signer: testAccount(11).signer,
      ciphersuite: impl,
      network: noNetwork(),
    });

    const withdrawnSelfRemoved: import("../state-notifications.js").StateNotification =
      {
        kind: "selfRemoved",
        commitDigest: new Uint8Array(32),
      };
    let reconvergeCalls = 0;
    group.session.reconverge = async () => {
      reconvergeCalls++;
      return [
        {
          kind: "stateInvalidated",
          commitDigest: new Uint8Array(32),
          forkEpoch: 1,
          withdrawn: [withdrawnSelfRemoved],
          disposition: { kind: "invalidated" },
        },
      ];
    };

    await group.reconverge();

    expect(reconvergeCalls).toBe(1);
    expect(await storage.get(removedMarkerKey)).toEqual(Uint8Array.of(1));
  });

  /**
   * CR-06, engine seam: `reconvergeFromHistory` must hand its results back
   * rather than swallowing them. Uses a real two-tip history tree so the pass
   * genuinely runs.
   */
  it("returns the results a tree-fed reconvergence pass produced instead of discarding them (CR-06)", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    // Our own tip, one commit deep.
    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);

    // A competing branch two commits deep, authored by the member, delivered
    // through the ordinary ingest path so it lands in the history tree.
    const sibA = await createCommit({
      context: ctx,
      state: memberEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sibB = await createCommit({
      context: ctx,
      state: sibA.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const ingestResults: Awaited<
      ReturnType<typeof engine.reconvergeFromHistory>
    > = [];
    for await (const result of engine.ingest([
      await createGroupEvent({
        message: sibA.commit,
        state: memberEpoch1,
        ciphersuite: impl,
      }),
      await createGroupEvent({
        message: sibB.commit,
        state: sibA.newState,
        ciphersuite: impl,
      }),
    ]))
      ingestResults.push(result);
    const applied = ingestResults.filter(
      (result) => result.kind === "appliedNotifications",
    );
    expect(applied.length).toBeGreaterThan(0);
    for (const result of applied) {
      if (result.kind !== "appliedNotifications") continue;
      expect(result.notifications.length).toBeGreaterThan(0);
      expect(
        result.notifications.every(
          (notification) =>
            bytesToHex(notification.commitDigest) ===
            bytesToHex(result.commitDigest),
        ),
      ).toBe(true);
    }
    const firstApplied = ingestResults.findIndex(
      (result) => result.kind === "appliedNotifications",
    );
    const firstWithdrawal = ingestResults.findIndex(
      (result) => result.kind === "stateInvalidated",
    );
    if (firstWithdrawal >= 0)
      expect(firstApplied).toBeLessThan(firstWithdrawal);

    // The contract that CR-06 restores: a resolved array, never `undefined`.
    const results = await engine.reconvergeFromHistory();
    expect(Array.isArray(results)).toBe(true);
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

    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([competitorEvent])) results.push(r);

    expect(results.some((r) => r.kind === "stateInvalidated")).toBe(false);
    // The canonical branch is unaffected — nothing below the retained anchor
    // can ever be withdrawn from or rewound onto.
    expect(Number(engine.state.groupContext.epoch)).toBe(4);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(tipBefore);
  });

  /**
   * CR-07 regression. `#applyForkResolution` used to diff only
   * `winnerChain.at(-1)`, so a rewind that applied N commits reported (and
   * ledger-recorded) notifications for the last one only. Every intermediate
   * commit's membership/component changes were silently lost, `epochAdvanced`
   * understated the jump, and — since `invalidatedByRewind` can only withdraw
   * what was `record()`ed — those notifications could never be withdrawn by a
   * later rewind, breaking CONV-03's stated invariant.
   *
   * The fixture builds a competing branch TWO commits deep so the winner chain
   * has two links. The member authors both (a genuinely different leaf than
   * the engine's own, so replay never hits the RFC 9420 own-commit
   * constraint), and the second is wrapped against the first's resulting
   * state, so it only decrypts once the branch builder has replayed the first
   * — the ordinary `encrypted`-candidate path.
   */
  it("reports and records notifications for EVERY commit on a multi-commit rewind, not just the tip (CR-07)", async () => {
    const { impl, ctx, adminPubkey, adminEpoch1, memberEpoch1 } =
      await twoMemberEpoch1Group();

    const engine = new MarmotGroupEngine<NostrEvent>({
      state: adminEpoch1,
      ciphersuite: impl,
      peeler: testPeeler(impl),
    });

    // Our own one-commit branch: epoch 1 -> 2.
    const sent = await engine.send({
      kind: "commit",
      actorPubkey: adminPubkey,
      extraProposals: [],
    });
    if (sent.kind !== "groupEvolution")
      throw new Error("expected groupEvolution");
    engine.confirmPublished(sent.pending);
    expect(Number(engine.state.groupContext.epoch)).toBe(2);

    // The member's competing branch, two self-update commits deep:
    // epoch 1 -> 2' -> 3'. Self-update-only so a non-admin may author them.
    const sibA = await createCommit({
      context: ctx,
      state: memberEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sibB = await createCommit({
      context: ctx,
      state: sibA.newState,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [],
    });
    const sibAEvent = await createGroupEvent({
      message: sibA.commit,
      state: memberEpoch1,
      ciphersuite: impl,
    });
    const sibBEvent = await createGroupEvent({
      message: sibB.commit,
      state: sibA.newState,
      ciphersuite: impl,
    });

    const results: IngestResult<NostrEvent>[] = [];
    for await (const r of engine.ingest([sibAEvent, sibBEvent]))
      results.push(r);

    // The two-commit branch outscores our one-commit branch on depth, so the
    // rewind really does apply both links.
    expect(Number(engine.state.groupContext.epoch)).toBe(3);
    expect(bytesToHex(engine.state.confirmationTag)).toBe(
      bytesToHex(sibB.newState.confirmationTag),
    );

    const rewound = results.find(
      (r) => r.kind === "processed" && r.notifications !== undefined,
    );
    expect(rewound).toBeDefined();
    if (rewound?.kind !== "processed")
      throw new Error("expected processed rewind");

    // Both epoch transitions are reported: 1 -> 2' from the first link and
    // 2' -> 3' from the tip. Before the fix only the second was present, so a
    // caller sitting at epoch 1 was told the group went from 2 to 3.
    const epochAdvances = (rewound.notifications ?? [])
      .filter((n) => n.kind === "epochAdvanced")
      .map((n) => [n.from, n.to]);
    expect(epochAdvances).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });
});
