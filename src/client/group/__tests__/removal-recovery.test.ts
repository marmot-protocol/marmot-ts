import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  createCommit,
  appDataUpdateProposalType,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
  type ClientState,
} from "ts-mls";
import { describe, expect, it, vi } from "vitest";
import type { EventSigner } from "applesauce-core";
import { GroupRegistry } from "../../group-registry.js";
import { MarmotGroup } from "../marmot-group.js";
import { removalEvidenceKey } from "../../session/group-session.js";
import type { NostrNetworkInterface } from "../../nostr-interface.js";
import { testAccount } from "../../../__tests__/helpers/test-accounts.js";
import {
  deserializeClientState,
  serializeClientState,
  type SerializedClientState,
} from "../../../core/client-state.js";
import {
  commitDigest,
  selectCanonicalBranch,
  DEFAULT_CONVERGENCE_POLICY,
} from "../../../core/convergence.js";
import { createCredential } from "../../../core/credential.js";
import { createGroupEvent } from "../../../core/group-message.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { GroupHistoryTree } from "../../../engine/history-tree.js";
import { MarmotGroupEngine } from "../../../engine/group-engine.js";
import { NostrGroupPeeler } from "../nostr-peeler.js";
import { GroupSession } from "../../session/group-session.js";
import { ForkRecovery } from "../../../engine/fork-recovery.js";
import {
  createAdminCommitPolicyCallback,
  requiredComponentIdsOf,
} from "../../../engine/admin-policy.js";
import { RetainedHistoryStore } from "../../../engine/retained-store.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../../../core/components/ids.js";
import { GroupMediaService } from "../group-media-service.js";

const copy = (state: ClientState) =>
  deserializeClientState(serializeClientState(state));
const network: NostrNetworkInterface = {
  request: async () => {
    throw new Error("no network requests expected");
  },
  subscription: () => {
    throw new Error("no subscriptions expected");
  },
  publish: async () => {
    throw new Error("no publications expected");
  },
  getUserInboxRelays: async () => {
    throw new Error("no relay lookup expected");
  },
};
function registry(f: Awaited<ReturnType<typeof fixture>>, horizon = 5) {
  return new GroupRegistry({
    store: f.store,
    ingestStateStore: f.lifecycleStore,
    lifecycleStore: f.lifecycleStore,
    rewindStore: f.rewindStore,
    removedMarkerStore: f.removedMarkerStore,
    signer: { getPublicKey: async () => f.member.pubkey } as EventSigner,
    network,
    convergencePolicy: {
      ...DEFAULT_CONVERGENCE_POLICY,
      maxRewindCommits: horizon,
    },
  });
}
async function realize(f: Awaited<ReturnType<typeof fixture>>) {
  const group = new MarmotGroup(copy(f.session.state), {
    store: f.store,
    lifecycleStore: f.lifecycleStore,
    removedMarkerStore: f.removedMarkerStore,
    ciphersuite: f.impl,
    signer: { getPublicKey: async () => f.member.pubkey } as EventSigner,
    network,
  });
  const removed = vi.fn();
  group.on("removed", removed);
  await group.session.hydrateLifecycleEvidence();
  await group.realizeRemovalIfNeeded();
  expect(removed).toHaveBeenCalledOnce();
  group.dispose();
}
async function fixture(depth = 2, losing = false, highRemoval = false) {
  const admin = testAccount(6),
    member = testAccount(11),
    other = testAccount(9);
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const context = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };
  const packages = await Promise.all(
    [admin, member, other].map((account) =>
      generateKeyPackage({
        credential: createCredential(account.pubkey),
        signer: account.signer,
        ciphersuiteImpl: impl,
      }),
    ),
  );
  const created = await createSimpleGroup(packages[0], impl, "Recovery", {
    adminPubkeys: [admin.pubkey],
    relays: ["wss://relay.test"],
  });
  const added = await createCommit({
    context,
    state: created.clientState,
    wireAsPublicMessage: true,
    ratchetTreeExtension: true,
    extraProposals: packages.slice(1).map((kp) => ({
      proposalType: defaultProposalTypes.add,
      add: { keyPackage: kp.publicPackage },
    })),
  });
  const parent = await joinGroup({
    context,
    welcome: added.welcome!.welcome!,
    keyPackage: packages[1].publicPackage,
    privateKeys: packages[1].privatePackage,
    ratchetTree: undefined,
  });
  const createRemoval = () =>
    createCommit({
      context,
      state: copy(added.newState),
      wireAsPublicMessage: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: parent.privatePath.leafIndex },
        },
      ],
    });
  let removal = await createRemoval();
  if (highRemoval) {
    for (
      let attempt = 0;
      commitDigest(encode(mlsMessageEncoder, removal.commit))[0] < 128;
      attempt++
    ) {
      if (attempt > 100)
        throw new Error("could not construct high removal digest");
      removal = await createRemoval();
    }
  }
  if (losing) {
    for (
      let attempt = 0;
      commitDigest(encode(mlsMessageEncoder, removal.commit))[0] >= 128;
      attempt++
    ) {
      if (attempt > 100)
        throw new Error("could not construct bounded removal digest");
      removal = await createRemoval();
    }
  }
  const event = await createGroupEvent({
    message: removal.commit,
    state: added.newState,
    ciphersuite: impl,
  });
  const store = new InMemoryKeyValueStore<SerializedClientState>();
  const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
  const lifecycleStore = new InMemoryKeyValueStore<Uint8Array>();
  const removedMarkerStore = new InMemoryKeyValueStore<boolean>();
  const session = new GroupSession({
    state: copy(parent),
    ciphersuite: impl,
    store,
    rewindStore,
    lifecycleStore,
    removedMarkerStore,
  });
  let adminTip = copy(added.newState),
    memberTip = copy(parent);
  const tree = new GroupHistoryTree(copy(parent));
  for (let i = 0; i < depth; i++) {
    let next = await createCommit({
      context,
      state: copy(adminTip),
      wireAsPublicMessage: true,
      extraProposals: [],
    });
    if (losing) {
      const incumbentDigest = bytesToHex(
        commitDigest(encode(mlsMessageEncoder, removal.commit)),
      );
      for (
        let attempt = 0;
        bytesToHex(commitDigest(encode(mlsMessageEncoder, next.commit))) <
        incumbentDigest;
        attempt++
      ) {
        if (attempt > 100) throw new Error("could not construct losing digest");
        next = await createCommit({
          context,
          state: copy(adminTip),
          wireAsPublicMessage: true,
          extraProposals: [],
        });
      }
    }
    const applied = await processMessage({
      context,
      state: copy(memberTip),
      message: next.commit,
    });
    if (applied.kind !== "newState")
      throw new Error("expected retained member");
    tree.recordCommit(
      bytesToHex(memberTip.confirmationTag),
      next.commit,
      applied.newState,
    );
    adminTip = next.newState;
    memberTip = applied.newState;
  }
  const results = [];
  for await (const result of session.ingest([event])) results.push(result);
  const removed = results.find((result) => result.kind === "removed")!;
  // Persist the actual tombstone and reload the independent retained tree.
  await session.save(true);
  tree.bindStore(rewindStore);
  await tree.flush();
  const id = bytesToHex(parent.groupContext.groupId);
  const restartedTree = (await GroupHistoryTree.load(rewindStore, id))!;
  const engine = new MarmotGroupEngine({
    state: deserializeClientState((await store.getItem(id))!),
    ciphersuite: impl,
    peeler: new NostrGroupPeeler(impl),
    historyTree: restartedTree,
  });
  return {
    context,
    packages,
    other,
    added,
    impl,
    parent,
    session,
    engine,
    removed,
    memberTip,
    adminTip,
    tree: restartedTree,
    store,
    rewindStore,
    lifecycleStore,
    removedMarkerStore,
    member,
    id,
    removal,
    event,
  };
}

describe("authenticated retained-anchor removal recovery", () => {
  it.each([false, true])(
    "uses normal authenticated committer ordering (illegal descendant: %s)",
    async (illegalDescendant) => {
      const f = await fixture(0);
      const otherParent = await joinGroup({
        context: f.context,
        welcome: f.added.welcome!.welcome!,
        keyPackage: f.packages[2].publicPackage,
        privateKeys: f.packages[2].privatePackage,
        ratchetTree: undefined,
      });
      const create = (state: ClientState) =>
        createCommit({
          context: f.context,
          state: copy(state),
          wireAsPublicMessage: true,
          extraProposals: [],
        });
      const adminFirst = await create(f.added.newState);
      let adminTip = await create(adminFirst.newState);
      for (
        let attempt = 0;
        commitDigest(encode(mlsMessageEncoder, adminTip.commit))[0] < 128;
        attempt++
      ) {
        if (attempt > 100) throw new Error("high tip digest bound");
        adminTip = await create(adminFirst.newState);
      }
      const otherFirst = await create(otherParent);
      let otherTip = await create(otherFirst.newState);
      for (
        let attempt = 0;
        commitDigest(encode(mlsMessageEncoder, otherTip.commit))[0] >= 128;
        attempt++
      ) {
        if (attempt > 100) throw new Error("low tip digest bound");
        otherTip = await create(otherFirst.newState);
      }
      const apply = async (commits: (typeof adminFirst.commit)[]) => {
        let receiver = copy(f.parent);
        for (const commit of commits) {
          const applied = await processMessage({
            context: f.context,
            state: copy(receiver),
            message: commit,
          });
          if (applied.kind !== "newState")
            throw new Error("expected genuine MLS child");
          f.engine.history.recordCommit(
            bytesToHex(receiver.confirmationTag),
            commit,
            applied.newState,
          );
          receiver = applied.newState;
        }
        return receiver;
      };
      const adminReceiver = await apply([adminFirst.commit, adminTip.commit]);
      let otherCommits = [otherFirst.commit, otherTip.commit];
      if (illegalDescendant) {
        const invalid = await createCommit({
          context: f.context,
          state: copy(otherTip.newState),
          wireAsPublicMessage: true,
          extraProposals: [
            {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
                operation: "remove",
              },
            },
          ],
        });
        otherCommits.push(invalid.commit);
      }
      await apply(otherCommits);
      const normal = await new ForkRecovery(
        f.impl,
        new NostrGroupPeeler(f.impl),
      ).resolveFork({
        forkEpoch: Number(f.parent.groupContext.epoch),
        pool: [adminFirst.commit, adminTip.commit, ...otherCommits],
        currentState: copy(f.parent),
        retained: new RetainedHistoryStore(copy(f.parent)),
        adminCallbackFor: (parent) =>
          createAdminCommitPolicyCallback({
            ratchetTree: parent.ratchetTree,
            adminPubkeys: [testAccount(6).pubkey],
            ciphersuiteId: f.impl.id,
            requiredIds: requiredComponentIdsOf(parent),
          }),
      });
      expect(testAccount(6).pubkey < f.other.pubkey).toBe(true);
      expect(
        bytesToHex(commitDigest(encode(mlsMessageEncoder, otherTip.commit))) <
          bytesToHex(commitDigest(encode(mlsMessageEncoder, adminTip.commit))),
      ).toBe(true);
      expect(normal.outcome).toBe("recovered");
      if (normal.outcome !== "recovered")
        throw new Error("normal branch failed");
      expect(bytesToHex(normal.winnerTip.confirmationTag)).toBe(
        bytesToHex(adminReceiver.confirmationTag),
      );
      expect(
        (await f.engine.recoverRemovedFromAnchor(f.removed.removalAttribution!))
          ?.selectedTip,
      ).toBe(bytesToHex(adminReceiver.confirmationTag));
      f.session.dispose();
      f.engine.dispose();
    },
  );

  it("preserves the removing committer when the equal-depth digest favors a retained competitor", async () => {
    const f = await fixture(0, false, true);
    const otherParent = await joinGroup({
      context: f.context,
      welcome: f.added.welcome!.welcome!,
      keyPackage: f.packages[2].publicPackage,
      privateKeys: f.packages[2].privatePackage,
      ratchetTree: undefined,
    });
    const create = () =>
      createCommit({
        context: f.context,
        state: copy(otherParent),
        wireAsPublicMessage: true,
        extraProposals: [],
      });
    let competitor = await create();
    for (
      let attempt = 0;
      commitDigest(encode(mlsMessageEncoder, competitor.commit))[0] >= 128;
      attempt++
    ) {
      if (attempt > 100)
        throw new Error("low incumbent competitor digest bound");
      competitor = await create();
    }
    const applied = await processMessage({
      context: f.context,
      state: copy(f.parent),
      message: competitor.commit,
    });
    if (applied.kind !== "newState")
      throw new Error("expected genuine MLS child");
    f.engine.history.recordCommit(
      bytesToHex(f.parent.confirmationTag),
      competitor.commit,
      applied.newState,
    );
    expect(f.session.removalEvidence).toMatchObject({
      version: 2,
      removingCommitter: testAccount(6).pubkey,
    });
    // A removal tombstone is not a tree child. Compare its authenticated
    // source edge with the competitor using the ordinary score contract.
    const candidates = [
      { id: "removal", message: f.removal.commit, account: testAccount(6) },
      { id: "competitor", message: competitor.commit, account: f.other },
    ].map(({ id, message, account }) => ({
      id,
      forkEpoch: Number(f.parent.groupContext.epoch),
      tipEpoch: Number(f.parent.groupContext.epoch) + 1,
      tipDigest: commitDigest(encode(mlsMessageEncoder, message)),
      tipCommitter: hexToBytes(account.pubkey),
      appWitnesses: [],
    }));
    expect(
      selectCanonicalBranch(
        candidates[0].tipEpoch,
        candidates,
        DEFAULT_CONVERGENCE_POLICY,
      )?.id,
    ).toBe("removal");
    expect(
      await f.engine.recoverRemovedFromAnchor(f.removed.removalAttribution!),
    ).toBeUndefined();
    expect(f.engine.state.groupActiveState.kind).toBe("removedFromGroup");
    f.session.dispose();
    f.engine.dispose();
  });

  it("reads legacy attribution conservatively while allowing a strictly deeper winner", async () => {
    const one = await fixture(1);
    const legacy = { ...one.removed.removalAttribution!, version: 1 as const };
    delete legacy.removingCommitter;
    await one.lifecycleStore.setItem(
      removalEvidenceKey(one.id),
      new TextEncoder().encode(
        JSON.stringify({ ...legacy, notificationState: "delivered" }),
      ),
    );
    const loaded = registry(one);
    expect((await loaded.get(one.id)).status).toBe("removed");
    loaded.untrack(one.id);
    const deeper = await fixture(2);
    expect(
      await deeper.engine.recoverRemovedFromAnchor({
        ...deeper.removed.removalAttribution!,
        version: 1,
        removingCommitter: undefined,
      }),
    ).toBeDefined();
    one.session.dispose();
    one.engine.dispose();
    deeper.session.dispose();
    deeper.engine.dispose();
  });
  it("captures exact active-parent removal provenance", async () => {
    const f = await fixture();
    expect(f.session.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(bytesToHex(f.session.state.confirmationTag)).toBe(
      bytesToHex(f.parent.confirmationTag),
    );
    expect(f.session.state.groupContext.epoch).toBe(
      f.parent.groupContext.epoch,
    );
    expect(f.removed.removalAttribution).toMatchObject({
      version: 2,
      removingCommitter: testAccount(6).pubkey,
      removingPriority: "privileged",
      removalDigest: bytesToHex(
        commitDigest(encode(mlsMessageEncoder, f.removal.commit)),
      ),
      parentTag: bytesToHex(f.parent.confirmationTag),
      parentEpoch: Number(f.parent.groupContext.epoch),
      groupId: f.id,
      localIdentity: f.member.pubkey,
      localLeaf: Number(f.parent.privatePath.leafIndex),
    });
  });
  it("recovers a real persisted tombstone only through its winning retained anchor", async () => {
    const f = await fixture();
    const result = await f.engine.recoverRemovedFromAnchor(
      f.removed.removalAttribution!,
    );
    expect(result).toMatchObject({
      parentTag: bytesToHex(f.parent.confirmationTag),
      selectedTip: bytesToHex(f.memberTip.confirmationTag),
    });
    expect(f.engine.state.groupActiveState.kind).toBe("active");
    expect(f.tree.tips()).toEqual([bytesToHex(f.memberTip.confirmationTag)]);
    expect(
      f.tree.childrenOf(bytesToHex(f.parent.confirmationTag)),
    ).toHaveLength(1);
  });
  it("keeps removal when the retained candidate loses normal digest scoring", async () => {
    const f = await fixture(1, true);
    expect(
      await f.engine.recoverRemovedFromAnchor(f.removed.removalAttribution!),
    ).toBeUndefined();
    expect(f.engine.state.groupActiveState.kind).toBe("removedFromGroup");
  });
  it("rejects mismatched group, parent, epoch, leaf and local identity provenance", async () => {
    const f = await fixture();
    const attribution = f.removed.removalAttribution!;
    for (const change of [
      { groupId: "00".repeat(32) },
      { parentTag: "00".repeat(32) },
      { parentEpoch: attribution.parentEpoch + 1 },
      { localLeaf: attribution.localLeaf + 1 },
      { localIdentity: testAccount(9).pubkey },
    ]) {
      expect(
        await f.engine.recoverRemovedFromAnchor({ ...attribution, ...change }),
      ).toBeUndefined();
      expect(f.engine.state.groupActiveState.kind).toBe("removedFromGroup");
    }
  });
  it("cannot recover without the retained active parent", async () => {
    const f = await fixture();
    const noAnchor = new MarmotGroupEngine({
      state: copy(f.session.state),
      ciphersuite: f.impl,
      peeler: new NostrGroupPeeler(f.impl),
    });
    expect(
      await noAnchor.recoverRemovedFromAnchor(f.removed.removalAttribution!),
    ).toBeUndefined();
  });
});

describe("durable removal recovery activation", () => {
  it("checkpoints exact pending removal lineage before releasing recovery authority", async () => {
    const f = await fixture(7);
    const ancientMedia = new GroupMediaService({
      media: undefined,
      getState: () => f.parent,
      getCiphersuite: () => f.impl,
    });
    const plaintext = Uint8Array.of(0, 255, 128, 17);
    const { encrypted, attachment, expectedParent } =
      await ancientMedia.encryptMedia(
        new Blob([plaintext], { type: "application/octet-stream" }),
        { filename: "pinned-parent.bin" },
      );
    await realize(f);
    const r = registry(f);
    const loaded = await r.load(f.id);
    const fault = vi
      .spyOn(f.removedMarkerStore, "removeItem")
      .mockRejectedValueOnce(new Error("marker pending"));
    await expect(loaded.session.finishRemovalRecovery()).rejects.toThrow(
      "marker pending",
    );
    fault.mockRestore();
    expect(loaded.session.removalBlocked).toBe(true);
    await loaded.session.save(true);
    expect((await f.rewindStore.getItem(`${f.id}/meta`))![0] === 2).toBe(true);
    expect(
      await loaded.session.historyTree.stateAt(
        bytesToHex(f.parent.confirmationTag),
      ),
    ).toBeDefined();
    expect(
      loaded.session
        .retainedStates()
        .map((state) => Number(state.groupContext.epoch)),
    ).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    for (let restart = 0; restart < 2; restart++) {
      const restored = await registry(f).load(f.id);
      expect(restored.session.removalBlocked).toBe(true);
      expect(
        restored.session
          .retainedStates()
          .map((state) => Number(state.groupContext.epoch)),
      ).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      for (const pristine of restored.session.retainedStates()) {
        const durable = (await restored.session.historyTree.stateAt(
          bytesToHex(pristine.confirmationTag),
        ))!;
        expect(pristine.keySchedule.exporterSecret).toEqual(
          durable.keySchedule.exporterSecret,
        );
      }
      const receiver = new GroupMediaService({
        media: undefined,
        getState: () => restored.state,
        getCiphersuite: () => f.impl,
        getRetainedStates: () => restored.session.retainedStates(),
      });
      expect(
        (await receiver.decryptMedia(encrypted, attachment, expectedParent))
          .data,
      ).toEqual(plaintext);
      await restored.session.save(true);
      restored.dispose();
    }
    await loaded.session.finishRemovalRecovery();
    await loaded.session.save(true);
    expect(
      loaded.session
        .retainedStates()
        .map((state) => Number(state.groupContext.epoch)),
    ).toEqual([8, 7, 6, 5, 4, 3]);
    const releasedParent = bytesToHex(f.parent.confirmationTag);
    expect(loaded.session.historyTree.hasNode(releasedParent)).toBe(false);
    const counts: number[] = [];
    for (let epoch = 0; epoch < 8; epoch++) {
      const work = (await loaded.session.send({ kind: "selfUpdate" }))
        .publish[0];
      if (work.kind !== "selfUpdate") throw new Error("expected update");
      loaded.session.confirmPublished(work.pending);
      await loaded.session.save(true);
      counts.push(loaded.session.historyTree.size);
    }
    expect(counts).toEqual(Array(8).fill(6));
    loaded.dispose();
    f.session.dispose();
    f.engine.dispose();
  });
  it("preserves the complete recovered lineage with explicit Infinity across two restarts", async () => {
    const f = await fixture(7);
    await realize(f);
    for (let restart = 0; restart < 2; restart++) {
      const r = registry(f, Infinity);
      const loaded = await r.get(f.id);
      await loaded.session.save(true);
      expect(
        loaded.session
          .retainedStates()
          .map((state) => Number(state.groupContext.epoch)),
      ).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(
        await loaded.session.historyTree.stateAt(
          bytesToHex(f.parent.confirmationTag),
        ),
      ).toBeDefined();
      r.untrack(f.id);
    }
    f.session.dispose();
    f.engine.dispose();
  });
  for (const boundary of ["canonical", "marker", "attribution"] as const)
    for (const forward of [false, true])
      it(`preserves genuine finite removal recovery across two restarts at ${boundary} forwarding=${forward}`, async () => {
        const f = await fixture(7);
        await realize(f);
        const loaded = await registry(f).load(f.id);
        let armed = true;
        async function fault<T>(write: () => Promise<T>): Promise<T> {
          if (!armed) return write();
          armed = false;
          if (forward) await write();
          throw new Error("recovery interruption");
        }
        const stateWrite = f.store.setItem.bind(f.store);
        const markerDelete = f.removedMarkerStore.removeItem.bind(
          f.removedMarkerStore,
        );
        const attributionDelete = f.lifecycleStore.removeItem.bind(
          f.lifecycleStore,
        );
        if (boundary === "canonical")
          f.store.setItem = async (key, bytes) => {
            return fault(() => stateWrite(key, bytes));
          };
        if (boundary === "marker")
          f.removedMarkerStore.removeItem = async (key) => {
            await fault(() => markerDelete(key));
          };
        if (boundary === "attribution")
          f.lifecycleStore.removeItem = async (key) => {
            if (key === removalEvidenceKey(f.id))
              await fault(() => attributionDelete(key));
            else await attributionDelete(key);
          };
        await expect(loaded.session.finishRemovalRecovery()).rejects.toThrow(
          "recovery interruption",
        );
        expect(armed).toBe(false);
        expect(loaded.session.removalBlocked).toBe(true);
        expect(
          await loaded.session.historyTree.stateAt(
            bytesToHex(f.parent.confirmationTag),
          ),
        ).toBeDefined();
        loaded.dispose();
        f.store.setItem = stateWrite;
        f.removedMarkerStore.removeItem = markerDelete;
        f.lifecycleStore.removeItem = attributionDelete;
        for (let restart = 0; restart < 2; restart++) {
          const restored = await registry(f).load(f.id);
          await restored.session.finishRemovalRecovery();
          expect(restored.session.removalBlocked).toBe(false);
          expect(bytesToHex(restored.state.confirmationTag)).toBe(
            bytesToHex(f.memberTip.confirmationTag),
          );
          for (const pristine of restored.session.retainedStates()) {
            const durable = (await restored.session.historyTree.stateAt(
              bytesToHex(pristine.confirmationTag),
            ))!;
            expect(pristine.keySchedule.exporterSecret).toEqual(
              durable.keySchedule.exporterSecret,
            );
          }
          await restored.session.save(true);
          expect(
            restored.session
              .retainedStates()
              .map((state) => Number(state.groupContext.epoch)),
          ).toEqual([8, 7, 6, 5, 4, 3]);
          expect(
            await f.lifecycleStore.getItem(removalEvidenceKey(f.id)),
          ).toBeNull();
          expect(
            await f.removedMarkerStore.getItem(`${f.id}/removed`),
          ).toBeNull();
          restored.dispose();
        }
        f.session.dispose();
        f.engine.dispose();
      });
  it("decrypts recovered intermediate-epoch media immediately without reloading", async () => {
    const f = await fixture(2);
    await realize(f);
    const sourceTag = f.tree.childrenOf(
      bytesToHex(f.parent.confirmationTag),
    )[0]!;
    const source = (await f.tree.stateAt(sourceTag))!;
    const sender = new GroupMediaService({
      media: undefined,
      getState: () => source,
      getCiphersuite: () => f.impl,
    });
    const plaintext = new Uint8Array([9, 8, 7]);
    const { encrypted, attachment, expectedParent } = await sender.encryptMedia(
      new Blob([plaintext], { type: "application/octet-stream" }),
      { filename: "intermediate.bin" },
    );
    const r = registry(f);
    try {
      const loaded = await r.get(f.id);
      expect(loaded.status).toBe("active");
      expect(loaded.state.groupContext.epoch).toBe(
        source.groupContext.epoch + 1n,
      );
      const retained = loaded.session.retainedStates();
      expect(retained.map((state) => Number(state.groupContext.epoch))).toEqual(
        [3, 2, 1],
      );
      const restored = retained.find(
        (state) => state.groupContext.epoch === source.groupContext.epoch,
      )!;
      expect(restored.keySchedule.exporterSecret).toEqual(
        source.keySchedule.exporterSecret,
      );
      expect(
        restored.keySchedule.exporterSecret.some((value) => value !== 0),
      ).toBe(true);
      const receiver = new GroupMediaService({
        media: undefined,
        getState: () => loaded.state,
        getCiphersuite: () => f.impl,
        getRetainedStates: () => loaded.session.retainedStates(),
      });
      expect(
        (await receiver.decryptMedia(encrypted, attachment, expectedParent))
          .data,
      ).toEqual(plaintext);
    } finally {
      r.untrack(f.id);
      f.session.dispose();
      f.engine.dispose();
    }
  });

  it("bounds the pristine recovered epoch window with the existing rewind policy", async () => {
    const f = await fixture(7);
    expect(
      await f.engine.recoverRemovedFromAnchor(f.removed.removalAttribution!),
    ).toBeDefined();
    expect(
      f.engine
        .retainedStates()
        .map((state) => Number(state.groupContext.epoch)),
    ).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    for (const state of f.engine.retainedStates()) {
      const stored = (await f.tree.stateAt(bytesToHex(state.confirmationTag)))!;
      expect(state.keySchedule.exporterSecret).toEqual(
        stored.keySchedule.exporterSecret,
      );
      expect(
        state.keySchedule.exporterSecret.some((value) => value !== 0),
      ).toBe(true);
    }
    await realize(f);
    const r = registry(f);
    const recovered = await r.get(f.id);
    await recovered.session.save(true);
    expect(
      recovered.session
        .retainedStates()
        .map((state) => Number(state.groupContext.epoch)),
    ).toEqual([8, 7, 6, 5, 4, 3]);
    expect((await f.rewindStore.getItem(`${f.id}/meta`))![0]).toBe(2);
    expect(
      await recovered.session.historyTree.stateAt(
        bytesToHex(f.parent.confirmationTag),
      ),
    ).toBeUndefined();
    r.untrack(f.id);
    f.session.dispose();
    f.engine.dispose();
  });

  it.each(["malformed", "missing anchor", "wrong durable projection"])(
    "keeps invalid %s evidence conservatively fenced",
    async (fault) => {
      const f = await fixture();
      await realize(f);
      if (fault === "wrong durable projection") {
        const write = f.store.setItem.bind(f.store);
        const corrupt = vi
          .spyOn(f.store, "setItem")
          .mockImplementation(async (key, bytes) => {
            const saved = deserializeClientState(bytes);
            if (saved.groupActiveState.kind === "active")
              saved.privatePath.leafIndex =
                0 as typeof saved.privatePath.leafIndex;
            return write(key, serializeClientState(saved));
          });
        const r = registry(f),
          loaded = await r.load(f.id);
        await r.track(loaded);
        expect(loaded.status).toBe("removed");
        expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(
          true,
        );
        expect(
          await f.lifecycleStore.getItem(removalEvidenceKey(f.id)),
        ).not.toBeNull();
        loaded.dispose();
        corrupt.mockRestore();
      } else {
        if (fault === "malformed")
          await f.lifecycleStore.setItem(
            removalEvidenceKey(f.id),
            new TextEncoder().encode("{invalid"),
          );
        else
          await f.rewindStore.removeItem(
            `${f.id}/state/${bytesToHex(f.parent.confirmationTag)}`,
          );
        const r = registry(f),
          loaded = await r.load(f.id);
        await r.track(loaded);
        expect(loaded.status).toBe("removed");
        expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(
          true,
        );
        loaded.dispose();
      }
    },
  );

  it("rejects a retained descendant that cannot authenticate against its exact parent", async () => {
    const f = await fixture();
    await realize(f);
    const parentChild = f.tree.childrenOf(
      bytesToHex(f.parent.confirmationTag),
    )[0];
    await f.rewindStore.setItem(
      `${f.id}/commit/${parentChild}`,
      encode(mlsMessageEncoder, f.removal.commit),
    );
    const r = registry(f),
      loaded = await r.load(f.id);
    await r.track(loaded);
    expect(loaded.status).toBe("removed");
    expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(true);
    loaded.dispose();
  });
  it.each([
    "snapshot before forwarding",
    "marker before forwarding",
    "marker after forwarding",
    "attribution cleanup",
  ])(
    "restarts after failure at %s with durable authority and outbound fencing",
    async (boundary) => {
      const f = await fixture();
      await realize(f);
      const originalStateWrite = f.store.setItem.bind(f.store);
      const originalMarkerClear = f.removedMarkerStore.removeItem.bind(
        f.removedMarkerStore,
      );
      const originalCleanup = f.lifecycleStore.removeItem.bind(
        f.lifecycleStore,
      );
      let failure;
      if (boundary === "snapshot before forwarding")
        failure = vi
          .spyOn(f.store, "setItem")
          .mockImplementationOnce(async () => {
            throw new Error(boundary);
          });
      else if (boundary.startsWith("marker"))
        failure = vi
          .spyOn(f.removedMarkerStore, "removeItem")
          .mockImplementationOnce(async (key) => {
            if (boundary === "marker after forwarding")
              await originalMarkerClear(key);
            throw new Error(boundary);
          });
      else
        failure = vi
          .spyOn(f.lifecycleStore, "removeItem")
          .mockImplementation(async (key) => {
            if (key === removalEvidenceKey(f.id)) throw new Error(boundary);
            await originalCleanup(key);
          });
      const r = registry(f),
        removed = vi.fn();
      r.on("removed", removed);
      const loaded = await r.load(f.id);
      await expect(r.track(loaded)).rejects.toThrow(boundary);
      expect(loaded.status).toBe("removed");
      const persisted = deserializeClientState((await f.store.getItem(f.id))!);
      expect(persisted.groupActiveState.kind).toBe(
        boundary === "snapshot before forwarding"
          ? "removedFromGroup"
          : "active",
      );
      const authority = JSON.parse(
        new TextDecoder().decode(
          (await f.lifecycleStore.getItem(removalEvidenceKey(f.id)))!,
        ),
      );
      expect(authority).toMatchObject({
        notificationState: "delivered",
        recoveryPending: {
          parentTag: bytesToHex(f.parent.confirmationTag),
          selectedTip: bytesToHex(f.memberTip.confirmationTag),
        },
      });
      expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(
        boundary === "snapshot before forwarding" ||
          boundary === "marker before forwarding"
          ? true
          : null,
      );
      failure.mockRestore();
      // Load without activating first: the durable authority fences a saved active projection.
      const restarted = registry(f),
        restartedRemoved = vi.fn();
      restarted.on("removed", restartedRemoved);
      const pending = await restarted.load(f.id);
      await pending.session.hydrateLifecycleEvidence();
      expect(pending.status).toBe("removed");
      await expect(
        pending.submitIntent({
          kind: "applicationMessage",
          payload: new Uint8Array([1]),
        }),
      ).rejects.toThrow(/removed/i);
      await expect(
        pending.session.send({
          kind: "applicationMessage",
          payload: new Uint8Array([1]),
        }),
      ).rejects.toThrow(/removed/i);
      const order: string[] = [];
      vi.spyOn(f.store, "setItem").mockImplementation(async (key, value) => {
        order.push("snapshot");
        return originalStateWrite(key, value);
      });
      vi.spyOn(f.removedMarkerStore, "removeItem").mockImplementation(
        async (key) => {
          order.push("marker");
          await originalMarkerClear(key);
        },
      );
      vi.spyOn(f.lifecycleStore, "removeItem").mockImplementation(
        async (key) => {
          if (key === removalEvidenceKey(f.id)) order.push("cleanup");
          await originalCleanup(key);
        },
      );
      await restarted.track(pending);
      expect(pending.status).toBe("active");
      expect(order.slice(-2)).toEqual(["marker", "cleanup"]);
      expect(
        await f.lifecycleStore.getItem(removalEvidenceKey(f.id)),
      ).toBeNull();
      expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBeNull();
      expect(removed).not.toHaveBeenCalled();
      expect(restartedRemoved).not.toHaveBeenCalled();
      pending.dispose();
    },
  );

  it("retries a failed authority write while retaining the removed projection", async () => {
    const f = await fixture();
    await realize(f);
    const write = f.lifecycleStore.setItem.bind(f.lifecycleStore);
    const fault = vi
      .spyOn(f.lifecycleStore, "setItem")
      .mockImplementation(async (key, bytes) => {
        if (
          key === removalEvidenceKey(f.id) &&
          JSON.parse(new TextDecoder().decode(bytes)).recoveryPending
        )
          throw new Error("authority write failed");
        return write(key, bytes);
      });
    const first = registry(f),
      group = await first.load(f.id);
    await expect(first.track(group)).rejects.toThrow("authority write failed");
    expect(
      deserializeClientState((await f.store.getItem(f.id))!).groupActiveState
        .kind,
    ).toBe("removedFromGroup");
    fault.mockRestore();
    const restarted = registry(f),
      recovered = await restarted.load(f.id);
    await restarted.track(recovered);
    expect(recovered.status).toBe("active");
    recovered.dispose();
  });

  it("keeps legacy boolean-only removal conservative even with a winning retained branch", async () => {
    const f = await fixture();
    await realize(f);
    await f.lifecycleStore.removeItem(removalEvidenceKey(f.id));
    const r = registry(f),
      loaded = await r.load(f.id);
    await r.track(loaded);
    expect(loaded.status).toBe("removed");
    expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(true);
    await expect(loaded.submitIntent({ kind: "selfUpdate" })).rejects.toThrow(
      /removed/i,
    );
    loaded.dispose();
  });

  it("rejects mismatched pending tip authority after an active snapshot is saved", async () => {
    const f = await fixture();
    await realize(f);
    const clear = vi
      .spyOn(f.removedMarkerStore, "removeItem")
      .mockRejectedValueOnce(new Error("stop before clear"));
    const first = registry(f),
      group = await first.load(f.id);
    await expect(first.track(group)).rejects.toThrow();
    clear.mockRestore();
    const key = removalEvidenceKey(f.id),
      record = JSON.parse(
        new TextDecoder().decode((await f.lifecycleStore.getItem(key))!),
      );
    record.recoveryPending.selectedTip = bytesToHex(f.parent.confirmationTag);
    await f.lifecycleStore.setItem(
      key,
      new TextEncoder().encode(JSON.stringify(record)),
    );
    const r = registry(f),
      loaded = await r.load(f.id);
    await r.track(loaded);
    expect(loaded.status).toBe("removed");
    expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).toBe(true);
    expect(await f.lifecycleStore.getItem(key)).not.toBeNull();
    loaded.dispose();
  });

  it("notifies once for a later independent genuine removal after recovery", async () => {
    const f = await fixture();
    await realize(f);
    const r = registry(f),
      removed = vi.fn();
    r.on("removed", removed);
    const loaded = await r.load(f.id);
    await r.track(loaded);
    const next = await createCommit({
      context: f.context,
      state: copy(f.adminTip),
      wireAsPublicMessage: true,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.remove,
          remove: { removed: loaded.state.privatePath.leafIndex },
        },
      ],
    });
    const event = await createGroupEvent({
      message: next.commit,
      state: f.adminTip,
      ciphersuite: f.impl,
    });
    for await (const _ of loaded.ingest([event])) void _;
    expect(loaded.status).toBe("removed");
    expect(removed).toHaveBeenCalledOnce();
    await loaded.reconverge();
    expect(loaded.status).toBe("removed");
    expect(removed).toHaveBeenCalledOnce();
    loaded.dispose();
    const restarted = registry(f),
      again = vi.fn();
    restarted.on("removed", again);
    const tombstone = await restarted.load(f.id);
    await restarted.track(tombstone);
    expect(tombstone.status).toBe("removed");
    expect(again).not.toHaveBeenCalled();
    tombstone.dispose();
  });

  it("restores a real removed group through registry activation without redelivery", async () => {
    const f = await fixture();
    await realize(f);
    const r = registry(f),
      removed = vi.fn();
    r.on("removed", removed);
    const updated = vi.fn(),
      loadedEvent = vi.fn();
    r.on("updated", updated);
    r.on("loaded", loadedEvent);
    const order: string[] = [];
    const evidenceWrite = f.lifecycleStore.setItem.bind(f.lifecycleStore),
      snapshotWrite = f.store.setItem.bind(f.store),
      markerClear = f.removedMarkerStore.removeItem.bind(f.removedMarkerStore),
      cleanup = f.lifecycleStore.removeItem.bind(f.lifecycleStore);
    vi.spyOn(f.lifecycleStore, "setItem").mockImplementation(
      async (key, bytes) => {
        if (
          key === removalEvidenceKey(f.id) &&
          JSON.parse(new TextDecoder().decode(bytes)).recoveryPending
        )
          order.push("authority");
        return evidenceWrite(key, bytes);
      },
    );
    vi.spyOn(f.store, "setItem").mockImplementation(async (key, bytes) => {
      order.push("snapshot");
      return snapshotWrite(key, bytes);
    });
    vi.spyOn(f.removedMarkerStore, "removeItem").mockImplementation(
      async (key) => {
        order.push("marker");
        await markerClear(key);
      },
    );
    vi.spyOn(f.lifecycleStore, "removeItem").mockImplementation(async (key) => {
      if (key === removalEvidenceKey(f.id)) order.push("cleanup");
      await cleanup(key);
    });
    const loaded = await r.get(f.id);
    expect(order).toEqual(["authority", "snapshot", "marker", "cleanup"]);
    expect(updated).toHaveBeenCalledOnce();
    expect(loadedEvent).toHaveBeenCalledOnce();
    expect(await r.get(f.id)).toBe(loaded);
    expect(loadedEvent).toHaveBeenCalledOnce();
    expect(loaded.status).toBe("active");
    expect(await f.removedMarkerStore.getItem(`${f.id}/removed`)).not.toBe(
      true,
    );
    expect(await f.lifecycleStore.getItem(removalEvidenceKey(f.id))).toBeNull();
    expect(removed).not.toHaveBeenCalled();
    loaded.dispose();
  });
});
