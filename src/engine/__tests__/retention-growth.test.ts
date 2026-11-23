import { bytesToHex } from "@noble/hashes/utils.js";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  createApplicationMessage,
  createCommit,
  createProposal,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  pskTypes,
  resumptionPSKUsages,
  type ClientState,
  type MlsMessage,
  type MlsFramedMessage,
  wireformats,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import { MockNetwork } from "../../__tests__/helpers/mock-network.js";
import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { marmotAuthService } from "../../core/auth-service.js";
import {
  defaultMarmotClientConfig,
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../../core/group-message.js";
import { deriveMediaEncryptionKey } from "../../core/media/crypto.js";
import {
  GroupSession,
  type GroupSessionHistory,
} from "../../client/session/group-session.js";
import { decodeDeliveredEvidence } from "../../client/storage/delivered-payload-store.js";
import { GroupRuntime } from "../../client/runtime/group-runtime.js";
import { linkPublicationRetention } from "../../client/runtime/publication-retention.js";
import { NostrWelcomeDelivery } from "../../client/transport/nostr/welcome-delivery.js";
import { NostrGroupPeeler } from "../../client/group/nostr-peeler.js";
import { memoryGroupDatabase } from "../../__tests__/helpers/database.js";
import { groupTreeStore } from "../../client/storage/database/group-batch.js";
import type { MarmotGroupDatabase } from "../../client/storage/database/types.js";
import { decodeRecord } from "../../client/storage/record-codec.js";
import { groupKeys } from "../../client/storage/storage-keys.js";

/** Physical row count of one in-memory table (test-only introspection). */
function tableSize(database: MarmotGroupDatabase, table: string): number {
  return (
    database as unknown as {
      store: { committed: Record<string, Map<string, unknown>> };
    }
  ).store.committed[table].size;
}
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";
import { GroupHistoryTree } from "../history-tree.js";
import { contentDedupId } from "../message-dedup.js";
import type { RetainedAppliedLink } from "../retained-store.js";
import type { StateNotification } from "../state-notifications.js";

const admin = testAccount(6);
const member = testAccount(11);
const copy = (state: ClientState) =>
  deserializeClientState(serializeClientState(state));
function framed(message: MlsMessage): MlsFramedMessage {
  if (
    message.wireformat !== wireformats.mls_public_message &&
    message.wireformat !== wireformats.mls_private_message
  )
    throw new Error("expected framed MLS message");
  return message;
}

const media = {
  plaintextSha256: "00".repeat(32),
  mediaType: "image/png",
  filename: "growth.png",
};

function rumor(author: string, ordinal: number) {
  const value = {
    id: "",
    pubkey: author,
    created_at: ordinal,
    kind: 9,
    tags: [],
    content: `growth-${ordinal}`,
  };
  value.id = getEventHash(value);
  return serializeApplicationRumor(value);
}

async function fixture(
  horizon: number,
  appWindow = 2,
  history?: GroupSessionHistory,
) {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const context = {
    cipherSuite: impl,
    authService: marmotAuthService,
    clientConfig: {
      ...defaultMarmotClientConfig,
      keyRetentionConfig: {
        ...defaultMarmotClientConfig.keyRetentionConfig,
        retainKeysForEpochs: 64,
      },
    },
  };
  const packages = await Promise.all(
    [admin, member].map((account) =>
      generateKeyPackage({
        credential: createCredential(account.pubkey),
        signer: account.signer,
        ciphersuiteImpl: impl,
      }),
    ),
  );
  const { clientState } = await createSimpleGroup(packages[0], impl, "Growth", {
    adminPubkeys: [admin.pubkey],
    relays: ["wss://relay.test"],
  });
  const added = await createCommit({
    context,
    state: clientState,
    extraProposals: [
      {
        proposalType: defaultProposalTypes.add,
        add: { keyPackage: packages[1].publicPackage },
      },
    ],
    ratchetTreeExtension: true,
  });
  const initial = await joinGroup({
    context,
    welcome: added.welcome!.welcome,
    keyPackage: packages[1].publicPackage,
    privateKeys: packages[1].privatePackage,
    ratchetTree: undefined,
  });
  const database = memoryGroupDatabase();
  let now = 0;
  const options = {
    ciphersuite: impl,
    database,
    history,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits: horizon,
      appPayloadPastEpochLimit: appWindow,
    },
    now: () => now,
    settlementQuiescenceMs: 1,
    scheduler: { setTimer: () => 0, clearTimer: () => {} },
  };
  const tree = new GroupHistoryTree(initial, { snapshotCacheSize: 2 });
  tree.bindStore(groupTreeStore(database));
  const session = new GroupSession({
    ...options,
    state: copy(initial),
    historyTree: tree,
  });
  const network = new MockNetwork(["wss://relay.test"]);
  const runtime = new GroupRuntime({
    welcomeDelivery: new NostrWelcomeDelivery({
      signer: member.signer,
      network,
    }),
    getNetwork: () => network,
    getRelays: () => ["wss://relay.test"],
    getGroupRef: () => bytesToHex(session.id),
    getGroupData: () => session.groupData,
    confirmPublished: (pending) => session.confirmPublished(pending),
    publishFailed: (pending) => session.publishFailed(pending),
    save: () => session.save(),
  });
  linkPublicationRetention(runtime, session);
  const settle = async () => {
    now += 100;
    for (const result of await session.driveConvergence())
      if (
        result.kind === "stateInvalidated" ||
        result.kind === "stateRevalidated"
      )
        await session.acknowledgeConvergenceEffect(result);
    await session.save(true);
  };
  const reload = async () =>
    (await GroupHistoryTree.load(
      groupTreeStore(database),
      bytesToHex(session.id),
      {
        snapshotCacheSize: 2,
      },
    ))!;
  return {
    impl,
    context,
    initial,
    sender: added.newState,
    tree,
    session,
    runtime,
    network,
    options,
    settle,
    tick: () => {
      now += 100;
    },
    reload,
    database,
  };
}

async function drain(
  session: GroupSession,
  events: Parameters<GroupSession["ingest"]>[0],
) {
  const results = [];
  for await (const result of session.ingest(events)) results.push(result);
  return results;
}

/** Observe actual owner Map instances at their normal writes, without exporting diagnostics.
 * Only this test's exact authenticated identifiers select an owner; the spy is always restored.
 */
function observeOwners() {
  const numeric = new Set<Map<string, number>>();
  const heavy = new Set<Map<string, { snapshot: Uint8Array }>>();
  const outer = new Set<
    Map<string, { sourceEpoch: number; contentId: string }>
  >();
  const links = new Set<Map<number, RetainedAppliedLink>>();
  const notifications = new Set<
    Map<
      string,
      { digest: string; epoch: number; notifications: StateNotification[] }
    >
  >();
  const original = Map.prototype.set;
  const spy = vi.spyOn(Map.prototype, "set").mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown,
  ) {
    if (
      typeof key === "number" &&
      value &&
      typeof value === "object" &&
      "parentState" in value &&
      "resultingState" in value &&
      "message" in value
    )
      links.add(this as Map<number, RetainedAppliedLink>);
    if (typeof key === "string") {
      if (typeof value === "number") numeric.add(this as Map<string, number>);
      if (value && typeof value === "object" && "snapshot" in value)
        heavy.add(this as Map<string, { snapshot: Uint8Array }>);
      if (
        value &&
        typeof value === "object" &&
        "contentId" in value &&
        "sourceEpoch" in value
      )
        outer.add(
          this as Map<string, { sourceEpoch: number; contentId: string }>,
        );
      if (
        value &&
        typeof value === "object" &&
        "digest" in value &&
        "epoch" in value &&
        "notifications" in value
      )
        notifications.add(
          this as Map<
            string,
            {
              digest: string;
              epoch: number;
              notifications: StateNotification[];
            }
          >,
        );
    }
    return original.call(this, key, value);
  });
  const unique = <K, T>(maps: Set<Map<K, T>>, key: K) => {
    const found = [...maps].filter((map) => map.has(key));
    expect(found).toHaveLength(1);
    return found[0];
  };
  return { spy, numeric, heavy, outer, links, notifications, unique };
}

describe("sustained recovery-safe retention", () => {
  for (const horizon of [3, Infinity])
    it(`measures every retained owner under fixed traffic and bounded periodic forks: ${horizon}`, async () => {
      const f = await fixture(horizon);
      const observation = observeOwners();
      let sender = f.sender;
      let sentOwner: Map<string, number> | undefined;
      let seenOwner: Map<string, number> | undefined;
      let outerOwner:
        Map<string, { sourceEpoch: number; contentId: string }> | undefined;
      let heavyOwner: Map<string, { snapshot: Uint8Array }> | undefined;
      let linkOwner: Map<number, RetainedAppliedLink> | undefined;
      let notificationOwner:
        | Map<
            string,
            {
              digest: string;
              epoch: number;
              notifications: StateNotification[];
            }
          >
        | undefined;
      const samples: number[][] = [];
      const parents: ClientState[] = [];
      const senders: ClientState[] = [];
      const old: {
        staleMessage?: MlsMessage;
        incomingMessage?: MlsMessage;
        ownMessage?: MlsMessage;
        branch?: string;
        child?: string;
        parent?: string;
        outgoing?: string;
        incoming?: string;
        notificationKey?: string;
        media?: Awaited<ReturnType<typeof deriveMediaEncryptionKey>>;
      } = {};
      try {
        for (let step = 0; step < 28; step++) {
          const parentState = copy(f.session.state);
          parents.push(parentState);
          senders.push(copy(sender));
          const outgoing = (
            await f.session.send({
              kind: "applicationMessage",
              payload: rumor(member.pubkey, step * 2 + 1),
            })
          ).publish[0];
          const peeled = await new NostrGroupPeeler(f.impl).peelGroupMessages(
            [outgoing.envelope],
            f.session.state,
          );
          const sentId = contentDedupId(peeled.read[0].message);
          await f.runtime.publishApplication(outgoing.envelope);
          const incoming = await createApplicationMessage({
            context: f.context,
            state: sender,
            message: rumor(admin.pubkey, step * 2 + 2),
          });
          sender = incoming.newState;
          const incomingId = contentDedupId(incoming.message);
          const event = await createGroupEvent({
            message: incoming.message,
            state: sender,
            ciphersuite: f.impl,
          });
          if (step === 0) {
            old.incomingMessage = incoming.message;
            old.ownMessage = peeled.read[0].message;
            const fresh = await createApplicationMessage({
              context: f.context,
              state: copy(sender),
              message: rumor(admin.pubkey, 9001),
            });
            old.staleMessage = fresh.message;
          }
          expect(
            (await drain(f.session, [event])).some(
              (result) => result.kind === "processed",
            ),
          ).toBe(true);
          sentOwner ??= observation.unique(observation.numeric, sentId);
          seenOwner ??= observation.unique(observation.numeric, incomingId);
          // Both session maps write the record, but only the sent-event owner still
          // contains an acknowledged publication. Select after the real relay ack.
          outerOwner ??= observation.unique(
            observation.outer,
            outgoing.envelope.id,
          );
          if (step >= 2 && step % 2 === 0) {
            // Fixed two-edge fanout stays below the advancing canonical depth,
            // so measuring topology does not silently change the sender branch.
            const branchParent = parents[step - 2];
            const branchParentTag = bytesToHex(branchParent.confirmationTag);
            const sibling = await createCommit({
              context: f.context,
              state: copy(senders[step - 2]),
              extraProposals: [],
              wireAsPublicMessage: true,
            });
            const appliedBranch = await processMessage({
              context: f.context,
              state: copy(branchParent),
              message: sibling.commit,
            });
            if (appliedBranch.kind !== "newState")
              throw new Error("expected sibling recipient");
            const branch = f.tree.recordCommit(
              branchParentTag,
              sibling.commit,
              appliedBranch.newState,
            );
            const descendant = await createCommit({
              context: f.context,
              state: copy(sibling.newState),
              extraProposals: [],
              wireAsPublicMessage: true,
            });
            const appliedChild = await processMessage({
              context: f.context,
              state: appliedBranch.newState,
              message: descendant.commit,
            });
            if (appliedChild.kind !== "newState")
              throw new Error("expected grandchild recipient");
            f.tree.recordCommit(
              branch,
              descendant.commit,
              appliedChild.newState,
            );
            if (step === 2) {
              old.branch = branch;
              old.parent = branchParentTag;
              old.media = await deriveMediaEncryptionKey(
                appliedBranch.newState,
                f.impl,
                media,
              );
            }
          }
          const update = (await f.session.send({ kind: "selfUpdate" }))
            .publish[0];
          if (update.kind !== "selfUpdate")
            throw new Error("expected own update");
          const applied = await processMessage({
            context: f.context,
            state: sender,
            message: framed(update.pending.commitMessage!),
          });
          if (applied.kind !== "newState")
            throw new Error("expected sender advancement");
          sender = applied.newState;
          f.session.confirmPublished(update.pending);
          const childTag = bytesToHex(f.session.state.confirmationTag);
          const notificationKey = `${bytesToHex(f.tree.node(childTag)!.edge!.commitDigest)}:${f.session.state.groupContext.epoch}`;
          linkOwner ??= observation.unique(
            observation.links,
            Number(update.pending.parentState!.groupContext.epoch),
          );
          notificationOwner ??= observation.unique(
            observation.notifications,
            notificationKey,
          );
          await f.runtime.publishApplication(update.envelope);
          if (step === 0) {
            old.notificationKey = notificationKey;
            old.child = bytesToHex(f.session.state.confirmationTag);
            old.outgoing = sentId;
            old.incoming = incomingId;
          }
          heavyOwner ??= observation.unique(
            observation.heavy,
            bytesToHex(f.session.state.confirmationTag),
          );
          await f.settle();
          const nodeRows = tableSize(f.database, "treeNodes");
          const loaded = await f.reload();
          expect(loaded.tags()).toEqual(f.tree.tags());
          let receivers = 0;
          for (const tag of loaded.tags())
            receivers += (await loaded.stateAt(tag))!.historicalReceiverData
              .size;
          const canonical = f.session.retainedStates();
          const evidence = decodeDeliveredEvidence(
            (await f.database.meta.get(groupKeys.delivered))!,
            loaded,
          );
          const effects = await f.database.meta.get(groupKeys.effects);
          const effectCount = effects
            ? Object.keys(decodeRecord<object>(effects)).length
            : 0;
          samples.push([
            f.tree.size,
            heavyOwner.size,
            // One node row now holds what were edge, state and commit keys.
            nodeRows,
            nodeRows,
            nodeRows,
            canonical.length,
            sentOwner.size,
            seenOwner.size,
            outerOwner.size,
            evidence.entries.length,
            tableSize(f.database, "wrappers"),
            effectCount,
            receivers,
            canonical.reduce(
              (sum, state) => sum + state.historicalReceiverData.size,
              0,
            ),
            linkOwner.size,
            notificationOwner.size,
            [...notificationOwner.values()].reduce(
              (sum, entry) => sum + entry.notifications.length,
              0,
            ),
          ]);
          expect(
            (await loaded.stateAt(bytesToHex(f.session.state.confirmationTag)))!
              .historicalReceiverData.size,
          ).toBeLessThanOrEqual(2);
          expect(heavyOwner.size).toBeLessThanOrEqual(2);
        }
        // Compare maxima of equal-length blocks with the same fork parity after
        // warmup. This is a fixed-workload plateau, not a traffic-independent cap.
        const maxima = (block: number[][]) =>
          block[0].map((_, column) =>
            Math.max(...block.map((row) => row[column])),
          );
        if (horizon !== Infinity) {
          expect(maxima(samples.slice(8, 18))).toEqual(
            maxima(samples.slice(18, 28)),
          );
          expect(await f.tree.stateAt(old.parent!)).toBeUndefined();
          expect(sentOwner!.has(old.outgoing!)).toBe(false);
          expect(seenOwner!.has(old.incoming!)).toBe(false);
          expect(notificationOwner!.has(old.notificationKey!)).toBe(false);
        } else {
          const loaded = await f.reload();
          const parent = (await loaded.stateAt(old.parent!))!;
          const replay = await processMessage({
            context: f.context,
            state: parent,
            message: framed((await loaded.commitMessageOf(old.branch!))!),
          });
          expect(replay.kind).toBe("newState");
          if (replay.kind === "newState")
            expect(bytesToHex(replay.newState.confirmationTag)).toBe(
              old.branch,
            );
          expect(await loaded.commitBytesOf(old.branch!)).toBeDefined();
          expect(await loaded.ownCommitStampOf(old.child!)).toMatchObject({
            committer: member.pubkey,
          });
          expect(
            await deriveMediaEncryptionKey(
              (await loaded.stateAt(old.branch!))!,
              f.impl,
              media,
            ),
          ).toEqual(old.media);
          expect(sentOwner!.has(old.outgoing!)).toBe(true);
          expect(seenOwner!.has(old.incoming!)).toBe(true);
          expect(
            notificationOwner!.get(old.notificationKey!)!.notifications,
          ).toContainEqual({
            kind: "epochAdvanced",
            commitDigest: loaded.node(old.child!)!.edge!.commitDigest,
            from: 1,
            to: 2,
          });
          const rewrapped = await Promise.all(
            [old.incomingMessage!, old.ownMessage!].map((message) =>
              createGroupEvent({
                message,
                state: f.session.state,
                ciphersuite: f.impl,
              }),
            ),
          );
          const duplicates = await drain(f.session, rewrapped);
          expect(
            duplicates.some(
              (result) =>
                result.kind === "skipped" && result.reason === "duplicate",
            ),
          ).toBe(true);
          expect(
            duplicates.some(
              (result) =>
                result.kind === "skipped" && result.reason === "self-echo",
            ),
          ).toBe(true);
          const staleEvent = await createGroupEvent({
            message: old.staleMessage!,
            state: f.session.state,
            ciphersuite: f.impl,
          });
          const liveBefore = serializeClientState(f.session.state);
          const sourceBefore = await f.tree.snapshotOf(old.parent!);
          const staleResults = await drain(f.session, [staleEvent]);
          expect(
            staleResults.some(
              (result) =>
                result.kind === "skipped" && result.reason === "past-epoch",
            ),
          ).toBe(true);
          expect(serializeClientState(f.session.state)).toEqual(liveBefore);
          expect(await f.tree.snapshotOf(old.parent!)).toEqual(sourceBefore);
          if (!("privateMessage" in old.staleMessage!))
            throw new Error("expected private application");
          const ciphertext =
            old.staleMessage!.privateMessage.ciphertext.slice();
          ciphertext[0] ^= 1;
          const forged = {
            ...old.staleMessage!,
            privateMessage: { ...old.staleMessage!.privateMessage, ciphertext },
          };
          const forgedEvent = await createGroupEvent({
            message: forged,
            state: f.session.state,
            ciphersuite: f.impl,
          });
          const unauthenticated = await drain(f.session, [forgedEvent]);
          expect(
            unauthenticated.some(
              (result) =>
                result.kind === "processed" ||
                (result.kind === "skipped" && result.reason === "past-epoch"),
            ),
          ).toBe(false);
          expect(serializeClientState(f.session.state)).toEqual(liveBefore);
          expect(await f.tree.snapshotOf(old.parent!)).toEqual(sourceBefore);
          expect(
            (await loaded.stateAt(
              bytesToHex(f.session.state.confirmationTag),
            ))!.historicalReceiverData.has(1n),
          ).toBe(false);
          expect(samples.at(-1)![0]).toBeGreaterThan(samples[8][0]);
          expect(samples.at(-1)![9]).toBeGreaterThan(samples[8][9]);
        }
      } finally {
        observation.spy.mockRestore();
        f.session.dispose();
      }
    }, 30_000);

  it("keeps a genuine publication source usable in a restarted reader until its original owner receives relay acknowledgement", async () => {
    const f = await fixture(1, 0);
    try {
      const source = bytesToHex(f.session.state.confirmationTag);
      const mediaBefore = await deriveMediaEncryptionKey(
        f.session.state,
        f.impl,
        media,
      );
      const work = (
        await f.session.send({
          kind: "applicationMessage",
          payload: rumor(member.pubkey, 99),
        })
      ).publish[0];
      for (let step = 0; step < 8; step++) {
        const next = (await f.session.send({ kind: "selfUpdate" })).publish[0];
        if (next.kind !== "selfUpdate") throw new Error("expected update");
        f.session.confirmPublished(next.pending);
        await f.runtime.publishApplication(next.envelope);
        await f.settle();
      }
      expect(f.tree.size).toBe(9);
      for (let restart = 0; restart < 2; restart++) {
        const loaded = await f.reload();
        const state = (await loaded.stateAt(source))!;
        expect(await deriveMediaEncryptionKey(state, f.impl, media)).toEqual(
          mediaBefore,
        );
        expect(
          (
            await new NostrGroupPeeler(f.impl).peelGroupMessages(
              [work.envelope],
              state,
            )
          ).read,
        ).toHaveLength(1);
      }
      // Publication ownership is process-lifetime; a reader restart does not
      // invent a durable outbound journal or transfer the original runtime's ack.
      await f.runtime.publishApplication(work.envelope);
      await f.settle();
      expect(f.tree.size).toBe(2);
      expect((await f.reload()).hasNode(source)).toBe(false);
    } finally {
      f.session.dispose();
    }
  });

  it("pins an actual fork-invalidated delivery across two session restarts until its real history retraction succeeds", async () => {
    let fail = true;
    const removed: string[] = [];
    const history = {
      saveMessage: async () => {},
      removeMessage: async (id: string) => {
        if (fail) throw new Error("retraction unavailable");
        removed.push(id);
      },
      purgeMessages: async () => {
        throw new Error("no application purge");
      },
    };
    const f = await fixture(1, 0, history);
    let session = f.session;
    try {
      const update = (await session.send({ kind: "selfUpdate" })).publish[0];
      if (update.kind !== "selfUpdate") throw new Error("expected update");
      session.confirmPublished(update.pending);
      await f.runtime.publishApplication(update.envelope);
      const payload = rumor(member.pubkey, 301);
      const work = (await session.send({ kind: "applicationMessage", payload }))
        .publish[0];
      await f.runtime.publishApplication(work.envelope);
      const source = bytesToHex(session.state.confirmationTag);
      const alternate = await createCommit({
        context: f.context,
        state: copy(f.sender),
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const descendant = await createCommit({
        context: f.context,
        state: copy(alternate.newState),
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const events = await Promise.all(
        [
          [alternate.commit, f.sender],
          [descendant.commit, alternate.newState],
        ].map(async ([message, state]) =>
          createGroupEvent({
            message: message as typeof alternate.commit,
            state: state as ClientState,
            ciphersuite: f.impl,
          }),
        ),
      );
      const results = await drain(session, events);
      expect(results.some((result) => result.kind === "invalidated")).toBe(
        true,
      );
      for (const result of results)
        if (
          result.kind === "stateInvalidated" ||
          result.kind === "stateRevalidated"
        )
          await session.acknowledgeConvergenceEffect(result);
      for (let step = 0; step < 6; step++) {
        const next = (await session.send({ kind: "selfUpdate" })).publish[0];
        if (next.kind !== "selfUpdate") throw new Error("expected update");
        session.confirmPublished(next.pending);
        await f.runtime.publishApplication(next.envelope);
        await f.settle();
      }
      const key = groupKeys.delivered;
      expect(
        decodeDeliveredEvidence((await f.database.meta.get(key))!, f.tree)
          .pending,
      ).toHaveLength(1);
      session.dispose();
      for (let restart = 0; restart < 2; restart++) {
        session = new GroupSession({
          ...f.options,
          state: deserializeClientState(
            (await f.database.meta.get(groupKeys.state))!,
          ),
          historyTree: await f.reload(),
        });
        await drain(session, []);
        await session.save(true);
        const evidence = decodeDeliveredEvidence(
          (await f.database.meta.get(key))!,
          session.historyTree,
        );
        expect(evidence.pending).toHaveLength(1);
        expect(evidence.pending[0].payload).toEqual(payload);
        expect(session.historyTree.hasNode(source)).toBe(true);
        if (restart === 0) session.dispose();
      }
      fail = false;
      await drain(session, []);
      f.tick();
      for (const result of await session.driveConvergence())
        if (
          result.kind === "stateInvalidated" ||
          result.kind === "stateRevalidated"
        )
          await session.acknowledgeConvergenceEffect(result);
      await session.save(true);
      expect(removed).toHaveLength(1);
      expect(
        decodeDeliveredEvidence(
          (await f.database.meta.get(key))!,
          session.historyTree,
        ).pending,
      ).toEqual([]);
      expect(session.historyTree.hasNode(source)).toBe(false);
      expect(session.historyTree.size).toBe(2);
    } finally {
      session.dispose();
      f.session.dispose();
    }
  });

  it("keeps a real staged historical resumption PSK through restart until its selectable source expires", async () => {
    const f = await fixture(Infinity, Infinity);
    try {
      let sender = f.sender;
      // Preserve receiver material until the real proposal is staged.
      for (let step = 0; step < 6; step++) {
        const result = await createCommit({
          context: f.context,
          state: sender,
          extraProposals: [],
          wireAsPublicMessage: true,
        });
        const event = await createGroupEvent({
          message: result.commit,
          state: sender,
          ciphersuite: f.impl,
        });
        await drain(f.session, [event]);
        sender = result.newState;
      }
      const tip = bytesToHex(f.session.state.confirmationTag);
      const proposal = await createProposal({
        context: f.context,
        state: sender,
        wireAsPublicMessage: true,
        proposal: {
          proposalType: defaultProposalTypes.psk,
          psk: {
            preSharedKeyId: {
              psktype: pskTypes.resumption,
              usage: resumptionPSKUsages.application,
              pskGroupId: f.session.id,
              pskEpoch: 3n,
              pskNonce: new Uint8Array(32),
            },
          },
        },
      });
      const staged = await processMessage({
        context: f.context,
        state: f.session.state,
        message: proposal.message,
      });
      if (staged.kind !== "newState")
        throw new Error("expected staged resumption");
      f.tree.updateSnapshot(tip, staged.newState);
      const options = {
        canonicalTipTag: tip,
        maxRewindCommits: 2,
        appPayloadPastEpochLimit: 0,
      };
      await f.tree.publishRetention(await f.tree.prepareRetention(options));
      await f.tree.resumeRetentionCleanup();
      const loaded = await f.reload();
      const pinned = (await loaded.stateAt(tip))!;
      expect([...pinned.historicalReceiverData.keys()]).toEqual([3n]);
      const completed = await createCommit({
        context: f.context,
        state: pinned,
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const child = loaded.recordCommit(
        tip,
        completed.commit,
        completed.newState,
      );
      await loaded.publishRetention(
        await loaded.prepareRetention({ ...options, canonicalTipTag: child }),
      );
      await loaded.resumeRetentionCleanup();
      const released = await f.reload();
      expect(
        (await released.stateAt(tip))!.historicalReceiverData.has(3n),
      ).toBe(true);
      expect((await released.stateAt(child))!.historicalReceiverData.size).toBe(
        0,
      );
      expect(await released.commitMessageOf(child)).toBeDefined();
      expect(
        await deriveMediaEncryptionKey(
          (await released.stateAt(tip))!,
          f.impl,
          media,
        ),
      ).toEqual(await deriveMediaEncryptionKey(pinned, f.impl, media));
      let currentTag = child;
      for (let step = 0; step < 3; step++) {
        const next = await createCommit({
          context: f.context,
          state: (await released.stateAt(currentTag))!,
          extraProposals: [],
          wireAsPublicMessage: true,
        });
        currentTag = released.recordCommit(
          currentTag,
          next.commit,
          next.newState,
        );
        await released.publishRetention(
          await released.prepareRetention({
            ...options,
            canonicalTipTag: currentTag,
          }),
        );
        await released.resumeRetentionCleanup();
        if (step >= 1) {
          expect(released.hasNode(tip)).toBe(false);
          expect(released.size).toBe(3);
          for (const tag of released.tags())
            expect(
              (await released.stateAt(tag))!.historicalReceiverData.has(3n),
            ).toBe(false);
        }
      }
    } finally {
      f.session.dispose();
    }
  });
});
