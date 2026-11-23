import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type CiphersuiteImpl,
  type ClientConfig,
  createCommit,
  createApplicationMessage,
  createProposal,
  defaultKeyRetentionConfig,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  pskTypes,
  resumptionPSKUsages,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import { testAccount } from "../../__tests__/helpers/test-accounts.js";
import { createCredential } from "../../core/credential.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../../core/client-state.js";
import { isAppPayloadExpired } from "../../core/retained-history.js";
import { deriveMediaEncryptionKey } from "../../core/media/crypto.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { memoryTreeStore } from "../../__tests__/helpers/database.js";
import { BinaryReader, BinaryWriter } from "../../core/binary.js";
import {
  emptyTreeWrite,
  type HistoryTreeWrite,
} from "../history-tree-store.js";
import { GroupHistoryTree } from "../history-tree.js";
import { retentionFloor } from "../retention.js";
import { buildTreeBranchSet } from "../tree-convergence.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../../core/convergence.js";

const ADMIN_ACCOUNT = testAccount(6);
const MEMBER_ACCOUNT = testAccount(11);
const ADMIN = ADMIN_ACCOUNT.pubkey;
const MEMBER = MEMBER_ACCOUNT.pubkey;

/**
 * Builds a member state at epoch 1 plus two competing commits from the epoch-1
 * admin state (a fork): the member applying either yields two distinct epoch-2
 * states sharing the epoch-1 parent.
 */
async function buildFork(impl: CiphersuiteImpl) {
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };

  const adminKp = await generateKeyPackage({
    credential: createCredential(ADMIN),
    signer: ADMIN_ACCOUNT.signer,
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(adminKp, impl, "T", {
    adminPubkeys: [ADMIN],
    relays: ["wss://mock.test"],
  });

  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER),
    signer: MEMBER_ACCOUNT.signer,
    ciphersuiteImpl: impl,
  });
  const { newState: adminE1, welcome } = await createCommit({
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
  const memberE1 = await joinGroup({
    context: ctx,
    welcome: welcome!.welcome ?? (welcome as never),
    keyPackage: memberKp.publicPackage,
    privateKeys: memberKp.privatePackage,
    ratchetTree: undefined,
  });

  const commitA = await createCommit({
    context: ctx,
    state: adminE1,
    extraProposals: [],
  });
  const commitB = await createCommit({
    context: ctx,
    state: adminE1,
    extraProposals: [],
  });

  const applyA = await processMessage({
    context: ctx,
    state: memberE1,
    message: commitA.commit,
  });
  const applyB = await processMessage({
    context: ctx,
    state: memberE1,
    message: commitB.commit,
  });
  if (applyA.kind !== "newState" || applyB.kind !== "newState")
    throw new Error("expected newState");

  return {
    memberE1,
    adminE2: commitA.newState,
    commitA: commitA.commit,
    commitB: commitB.commit,
    childA: applyA.newState,
    childB: applyB.newState,
  };
}

describe("GroupHistoryTree", () => {
  let impl: CiphersuiteImpl;
  beforeAll(async () => {
    impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
  });

  async function extendedFork() {
    const fork = await buildFork(impl);
    const tree = new GroupHistoryTree(fork.memberE1);
    const tags = [tree.rootTag!];
    tags.push(tree.recordCommit(tags[0], fork.commitA, fork.childA));
    const oldForkTag = tree.recordCommit(tags[0], fork.commitB, fork.childB);
    const context = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
      clientConfig: {
        keyRetentionConfig: {
          ...defaultKeyRetentionConfig,
          retainKeysForEpochs: 32,
        },
      } as ClientConfig,
    };
    let adminState = fork.adminE2;
    const senderStates = new Map([[tags[1], serializeClientState(adminState)]]);
    for (let i = 0; i < 6; i++) {
      const state = (await tree.stateAt(tags.at(-1)!))!;
      const result = await createCommit({
        context,
        state: deserializeClientState(serializeClientState(adminState)),
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      const applied = await processMessage({
        context,
        state,
        message: result.commit,
      });
      if (applied.kind !== "newState")
        throw new Error("expected receiver commit advancement");
      adminState = result.newState;
      tags.push(
        tree.recordCommit(tags.at(-1)!, result.commit, applied.newState),
      );
      senderStates.set(tags.at(-1)!, serializeClientState(adminState));
    }
    return { tree, tags, oldForkTag, context, senderStates };
  }

  it("keeps genuine forks diverging at the inclusive boundary and their future descendants", async () => {
    const { tree, tags, oldForkTag, context } = await extendedFork();
    const atBoundary = tags[4]; // epoch 5; canonical tip epoch 8
    const other = await createCommit({
      context,
      state: (await tree.stateAt(atBoundary))!,
      extraProposals: [],
      wireAsPublicMessage: true,
    });
    const sibling = tree.recordCommit(atBoundary, other.commit, other.newState);
    let future = sibling;
    for (let i = 0; i < 4; i++) {
      const next = await createCommit({
        context,
        state: (await tree.stateAt(future))!,
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      future = tree.recordCommit(future, next.commit, next.newState);
    }
    const plan = await tree.prepareRetention({
      canonicalTipTag: tags.at(-1)!,
      maxRewindCommits: 3,
      appPayloadPastEpochLimit: 0,
    });
    expect(plan.retainedTags).toContain(sibling);
    expect(plan.retainedTags).toContain(future);
    expect(plan.excludedTags).toContain(oldForkTag);
    expect(plan.logicalRootTag).toBe(atBoundary);
  });

  it("pins exact old topology and producing evidence until release, then keeps below/equal/above boundary adjacency", async () => {
    const { tree, tags, oldForkTag } = await extendedFork();
    const store = memoryTreeStore();
    tree.bindStore(store);
    const options = {
      canonicalTipTag: tags.at(-1)!,
      maxRewindCommits: 3,
      appPayloadPastEpochLimit: 0,
    };
    const originalDigest = tree.node(tags[4])!.edge!.commitDigest;
    const pinned = await tree.prepareRetention({
      ...options,
      pins: [{ stateTag: oldForkTag, reason: "retraction" }],
    });
    expect(pinned.logicalRootTag).toBe(tags[0]);
    expect(pinned.retainedTags).toContain(oldForkTag);
    await tree.publishRetention(pinned);
    await tree.resumeRetentionCleanup();
    expect(await tree.commitMessageOf(oldForkTag)).toBeDefined();
    const released = await tree.prepareRetention(options);
    expect(released.excludedTags).toContain(tags[3]); // below, epoch 4
    expect(released.retainedTags).toContain(tags[4]); // equal, epoch 5
    expect(released.retainedTags).toContain(tags[5]); // above, epoch 6
    await tree.publishRetention(released);
    await tree.resumeRetentionCleanup();
    const loaded = (await GroupHistoryTree.load(
      store,
      bytesToHex((await tree.stateAt(tags[4]))!.groupContext.groupId),
    ))!;
    expect(loaded.node(tags[4])!.edge!.commitDigest).toEqual(originalDigest);
    expect(loaded.parentOf(tags[4])).toBeUndefined();
    expect(loaded.hasNode(tags[3])).toBe(false);
    expect(loaded.tips()).toEqual([tags.at(-1)!]);
    expect(await loaded.commitMessageOf(tags[4])).toBeDefined();
  });

  it("preserves equal-epoch sibling order and comparator inputs independently of adapter key enumeration", async () => {
    const { memberE1, commitA, commitB, childA, childB } =
      await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = tree.rootTag!;
    const a = tree.recordCommit(rootTag, commitA, childA);
    const b = tree.recordCommit(rootTag, commitB, childB);
    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.flush();
    const gid = bytesToHex(memberE1.groupContext.groupId);
    // Child order comes from the checkpoint's member order, not the adapter.
    const first = (await GroupHistoryTree.load(store, gid))!;
    const second = (await GroupHistoryTree.load(store, gid))!;
    expect(first.childrenOf(rootTag)).toEqual(second.childrenOf(rootTag));
    const before = buildTreeBranchSet(first, a, DEFAULT_CONVERGENCE_POLICY);
    await first.publishRetention(
      await first.prepareRetention({
        canonicalTipTag: a,
        maxRewindCommits: 1,
        appPayloadPastEpochLimit: 0,
      }),
    );
    const loaded = (await GroupHistoryTree.load(store, gid))!;
    expect(loaded.childrenOf(rootTag)).toEqual(first.childrenOf(rootTag));
    expect(buildTreeBranchSet(loaded, a, DEFAULT_CONVERGENCE_POLICY)).toEqual(
      before,
    );
    expect(loaded.nodesAtEpoch(2).sort()).toEqual([a, b].sort());
  });

  it("treats empty and single-node inputs safely and rejects unsafe horizon arithmetic", async () => {
    const empty = new GroupHistoryTree();
    const emptyPlan = await empty.prepareRetention({
      canonicalTipTag: "",
      maxRewindCommits: 5,
      appPayloadPastEpochLimit: 5,
    });
    expect(emptyPlan.retainedTags).toEqual([]);
    await empty.publishRetention(emptyPlan);
    const { memberE1 } = await buildFork(impl);
    const single = new GroupHistoryTree(memberE1);
    const store = memoryTreeStore();
    single.bindStore(store);
    const plan = await single.prepareRetention({
      canonicalTipTag: single.rootTag!,
      maxRewindCommits: 0,
      appPayloadPastEpochLimit: 0,
    });
    expect(plan.excludedTags).toEqual([]);
    await single.publishRetention(plan);
    await single.resumeRetentionCleanup();
    expect(
      (await GroupHistoryTree.load(
        store,
        bytesToHex(memberE1.groupContext.groupId),
      ))!.size,
    ).toBe(1);
    for (const invalid of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => retentionFloor(8, invalid)).toThrow();
    expect(retentionFloor(Number.MAX_SAFE_INTEGER, Infinity)).toBe(0);
  });

  it("preserves full history and stamps under Infinity while independently filtering obsolete receiver epochs", async () => {
    const { tree, tags, oldForkTag, context } = await extendedFork();
    const parent = tags.at(-1)!;
    const result = await createCommit({
      context,
      state: (await tree.stateAt(parent))!,
      extraProposals: [],
      wireAsPublicMessage: true,
    });
    const stamp = {
      committer: MEMBER,
      priority: "privileged" as const,
      consumedProposalRefs: [],
    };
    const tip = tree.recordCommit(
      parent,
      result.commit,
      result.newState,
      undefined,
      stamp,
    );
    const all = tree.tags();
    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tip,
        maxRewindCommits: Infinity,
        appPayloadPastEpochLimit: 1,
      }),
    );
    await tree.resumeRetentionCleanup();
    const loaded = (await GroupHistoryTree.load(
      store,
      bytesToHex(result.newState.groupContext.groupId),
      { snapshotCacheSize: 0 },
    ))!;
    expect(loaded.tags()).toEqual(all);
    expect(await loaded.stateAt(tags[0])).toBeDefined();
    expect(await loaded.commitMessageOf(oldForkTag)).toBeDefined();
    expect(await loaded.ownCommitStampOf(tip)).toEqual(stamp);
    expect([
      ...(await loaded.stateAt(tip))!.historicalReceiverData.keys(),
    ]).toEqual([8n]);
    expect(isAppPayloadExpired(7, 9, 1)).toBe(true);
    expect(isAppPayloadExpired(8, 9, 1)).toBe(false);
  });

  it("keeps equality application decrypt and current-epoch commit replay and media exporter after lazy projection reload", async () => {
    const { tree, tags, context, senderStates } = await extendedFork();
    const sourceTag = tags[5]; // epoch 6, equality for tip 8 / limit 2
    const source = (await tree.stateAt(sourceTag))!;
    const payload = new TextEncoder().encode("retained application payload");
    const message = await createApplicationMessage({
      context,
      state: deserializeClientState(serializeClientState(source)),
      message: payload,
    });
    const attachment = {
      plaintextSha256: "00".repeat(32),
      mediaType: "image/png",
      filename: "test.png",
    };
    // Exporter comparisons use a real source-epoch media derivation.
    const mediaBefore = await deriveMediaEncryptionKey(
      source,
      impl,
      attachment,
    );
    const future = await createCommit({
      context,
      state: deserializeClientState(senderStates.get(sourceTag)!),
      extraProposals: [],
      wireAsPublicMessage: true,
    });
    const tip = (await tree.stateAt(tags.at(-1)!))!;
    const live = serializeClientState(tip);
    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        maxRewindCommits: 1,
        appPayloadPastEpochLimit: 2,
      }),
    );
    await tree.resumeRetentionCleanup();
    const loaded = (await GroupHistoryTree.load(
      store,
      bytesToHex(source.groupContext.groupId),
      { snapshotCacheSize: 0 },
    ))!;
    expect(loaded.hasNode(sourceTag)).toBe(true);
    const projectedTip = (await loaded.stateAt(tags.at(-1)!))!;
    expect([...projectedTip.historicalReceiverData.keys()]).toEqual([6n, 7n]);
    const decrypted = await processMessage({
      context,
      state: projectedTip,
      message: message.message,
    });
    expect(decrypted.kind).toBe("applicationMessage");
    if (decrypted.kind === "applicationMessage")
      expect(decrypted.message).toEqual(payload);
    const projectedParent = (await loaded.stateAt(sourceTag))!;
    const advanced = await processMessage({
      context,
      state: deserializeClientState(serializeClientState(projectedParent)),
      message: future.commit,
    });
    expect(advanced.kind).toBe("newState");
    expect(
      await deriveMediaEncryptionKey(projectedParent, impl, attachment),
    ).toEqual(mediaBefore);
    expect(serializeClientState(tip)).toEqual(live);
    expect(isAppPayloadExpired(5, 8, 2)).toBe(true);
  });

  it("keeps an exact historical resumption PSK across reload and releases it after genuine completion", async () => {
    const { tree, tags, context } = await extendedFork();
    const tipTag = tags.at(-1)!;
    const tip = (await tree.stateAt(tipTag))!;
    const sourceEpoch = 3;
    const store = memoryTreeStore();
    tree.bindStore(store);
    const options = {
      canonicalTipTag: tipTag,
      maxRewindCommits: 2,
      appPayloadPastEpochLimit: 0,
    };
    await tree.publishRetention(
      await tree.prepareRetention({
        ...options,
        pins: [
          {
            stateTag: tipTag,
            receiverEpoch: sourceEpoch,
            reason: "resumption",
          },
        ],
      }),
    );
    await tree.resumeRetentionCleanup();
    const loaded = (await GroupHistoryTree.load(
      store,
      bytesToHex(tip.groupContext.groupId),
      { snapshotCacheSize: 0 },
    ))!;
    const receiver = (await loaded.stateAt(tipTag))!;
    expect([...receiver.historicalReceiverData.keys()]).toEqual([3n]);
    const commit = await createCommit({
      context,
      state: receiver,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.psk,
          psk: {
            preSharedKeyId: {
              psktype: pskTypes.resumption,
              usage: resumptionPSKUsages.application,
              pskGroupId: tip.groupContext.groupId,
              pskEpoch: 3n,
              pskNonce: new Uint8Array(32),
            },
          },
        },
      ],
      wireAsPublicMessage: true,
    });
    const nextTag = loaded.recordCommit(tipTag, commit.commit, commit.newState);
    await loaded.publishRetention(
      await loaded.prepareRetention({ ...options, canonicalTipTag: nextTag }),
    );
    await loaded.resumeRetentionCleanup();
    const completed = (await GroupHistoryTree.load(
      store,
      bytesToHex(tip.groupContext.groupId),
      { snapshotCacheSize: 0 },
    ))!;
    expect(
      (await completed.stateAt(tipTag))!.historicalReceiverData.has(3n),
    ).toBe(false);
    expect(
      (await completed.stateAt(nextTag))!.historicalReceiverData.size,
    ).toBe(0);
    expect(await completed.commitMessageOf(nextTag)).toBeDefined();
  });

  it("postpones an unresolved receiver rewrite and refuses missing exact dependencies", async () => {
    const { tree, tags } = await extendedFork();
    const tipTag = tags.at(-1)!;
    const options = {
      canonicalTipTag: tipTag,
      maxRewindCommits: 2,
      appPayloadPastEpochLimit: 0,
    };
    const bytes = await tree.snapshotOf(tipTag);
    const postponed = await tree.prepareRetention({
      ...options,
      pins: [
        {
          stateTag: tipTag,
          reason: "resumption",
          unresolvedReceiverDependency: true,
        },
      ],
    });
    expect(postponed.snapshots.get(tipTag)).toEqual(bytes);
    expect(postponed.receiverEpochs.get(tipTag)).toBeUndefined();
    await expect(
      tree.prepareRetention({
        ...options,
        pins: [{ stateTag: tipTag, reason: "resumption", receiverEpoch: 0 }],
      }),
    ).rejects.toThrow("required receiver dependency absent");
  });

  it("retains a staged by-reference resumption dependency until its source leaves the selectable window", async () => {
    const { tree, tags, context, senderStates } = await extendedFork();
    const tipTag = tags.at(-1)!;
    const tip = (await tree.stateAt(tipTag))!;
    const sender = deserializeClientState(senderStates.get(tipTag)!);
    const proposed = await createProposal({
      context,
      state: sender,
      wireAsPublicMessage: true,
      proposal: {
        proposalType: defaultProposalTypes.psk,
        psk: {
          preSharedKeyId: {
            psktype: pskTypes.resumption,
            usage: resumptionPSKUsages.application,
            pskGroupId: tip.groupContext.groupId,
            pskEpoch: 3n,
            pskNonce: new Uint8Array(32),
          },
        },
      },
    });
    const staged = await processMessage({
      context,
      state: tip,
      message: proposed.message,
    });
    if (staged.kind !== "newState")
      throw new Error("expected staged PSK proposal");
    tree.updateSnapshot(tipTag, staged.newState);
    const options = {
      canonicalTipTag: tipTag,
      maxRewindCommits: 2,
      appPayloadPastEpochLimit: 0,
    };
    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.publishRetention(await tree.prepareRetention(options));
    await tree.resumeRetentionCleanup();
    const loaded = (await GroupHistoryTree.load(
      store,
      bytesToHex(tip.groupContext.groupId),
      { snapshotCacheSize: 0 },
    ))!;
    expect([
      ...(await loaded.stateAt(tipTag))!.historicalReceiverData.keys(),
    ]).toEqual([3n]);
    const completed = await createCommit({
      context,
      state: (await loaded.stateAt(tipTag))!,
      extraProposals: [],
      wireAsPublicMessage: true,
    });
    const nextTag = loaded.recordCommit(
      tipTag,
      completed.commit,
      completed.newState,
    );
    await loaded.publishRetention(
      await loaded.prepareRetention({ ...options, canonicalTipTag: nextTag }),
    );
    await loaded.resumeRetentionCleanup();
    expect((await loaded.stateAt(tipTag))!.historicalReceiverData.has(3n)).toBe(
      true,
    );
    expect((await loaded.stateAt(nextTag))!.historicalReceiverData.size).toBe(
      0,
    );
    let currentTag = nextTag;
    for (let step = 0; step < 2; step++) {
      const next = await createCommit({
        context,
        state: (await loaded.stateAt(currentTag))!,
        extraProposals: [],
        wireAsPublicMessage: true,
      });
      currentTag = loaded.recordCommit(currentTag, next.commit, next.newState);
      await loaded.publishRetention(
        await loaded.prepareRetention({
          ...options,
          canonicalTipTag: currentTag,
        }),
      );
      await loaded.resumeRetentionCleanup();
    }
    expect(loaded.hasNode(tipTag)).toBe(false);
    expect(loaded.size).toBe(3);
    for (const tag of loaded.tags())
      expect((await loaded.stateAt(tag))!.historicalReceiverData.has(3n)).toBe(
        false,
      );
  });

  it("fails closed on corrupt authoritative closure, boundary, receiver allowlists and required commit bytes", async () => {
    const { tree, tags } = await extendedFork();
    const gid = bytesToHex((await tree.stateAt(tags[0]))!.groupContext.groupId);
    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.publishRetention(
      await tree.prepareRetention({
        canonicalTipTag: tags.at(-1)!,
        maxRewindCommits: 3,
        appPayloadPastEpochLimit: 0,
      }),
    );
    await tree.resumeRetentionCleanup();
    const original = (await store.meta())!;
    const setMeta = (meta: Uint8Array) =>
      store.commit({ ...emptyTreeWrite(), meta });
    type CheckpointFixture = {
      boundary: { digest: string };
      garbage: string[];
      members: string[];
      receivers: Record<string, number[]>;
    };
    const corruptions = [
      (value: CheckpointFixture) => {
        value.boundary.digest = "00".repeat(32);
      },
      (value: CheckpointFixture) => {
        value.garbage.push(value.members[0]);
      },
      (value: CheckpointFixture) => {
        value.receivers[value.members.at(-1)!] = [0];
      },
      (value: CheckpointFixture) => {
        const tag = value.members[1];
        value.members.splice(1, 1);
        delete value.receivers[tag];
      },
    ];
    for (const corrupt of corruptions) {
      const value = JSON.parse(new TextDecoder().decode(original.subarray(1)));
      corrupt(value);
      const json = new TextEncoder().encode(JSON.stringify(value));
      const bytes = new Uint8Array(json.length + 1);
      bytes[0] = 2;
      bytes.set(json, 1);
      await setMeta(bytes);
      await expect(GroupHistoryTree.load(store, gid)).rejects.toThrow();
    }
    await setMeta(original);
    // Replace only the node's commit bytes with garbage.
    const record = new BinaryReader((await store.node(tags[5]))!);
    const version = record.uint8();
    const edge = record.opaque();
    const snapshot = record.opaque();
    const corrupt = new BinaryWriter()
      .uint8(version)
      .opaque(edge)
      .opaque(snapshot)
      .uint8(1)
      .opaque(Uint8Array.of(1))
      .build();
    await store.commit({
      ...emptyTreeWrite(),
      puts: new Map([[tags[5], corrupt]]),
    });
    await expect(GroupHistoryTree.load(store, gid)).rejects.toThrow();
  });

  it("fences tree mutation throughout publication and retains failed dirty writes for retry", async () => {
    const { tree, tags } = await extendedFork();
    const store = memoryTreeStore();
    tree.bindStore(store);
    const plan = await tree.prepareRetention({
      canonicalTipTag: tags.at(-1)!,
      maxRewindCommits: 3,
      appPayloadPastEpochLimit: 0,
    });
    const state = (await tree.stateAt(tags.at(-1)!))!;
    // The pre-publication flush commits as one write; fail that write.
    const original = store.commit.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    store.commit = async (write: HistoryTreeWrite) => {
      if (first) {
        first = false;
        entered();
        await blocked;
        throw new Error("write failed");
      }
      return original(write);
    };
    const publication = tree.publishRetention(plan);
    await waiting;
    expect(() => tree.updateSnapshot(tags.at(-1)!, state)).toThrow(
      "in progress",
    );
    release();
    await expect(publication).rejects.toThrow("write failed");
    expect(tree.isDirty).toBe(true);
    store.commit = original;
    await tree.flush();
    expect(tree.isDirty).toBe(false);
    tree.updateSnapshot(tags.at(-1)!, state);
    await expect(tree.publishRetention(plan)).rejects.toThrow("became stale");
  });

  it("keeps a snapshot generation dirtied during an awaited flush retryable", async () => {
    const { memberE1 } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const store = memoryTreeStore();
    tree.bindStore(store);
    // Block the flush's atomic write while it carries a snapshot write.
    const original = store.commit.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    store.commit = async (write: HistoryTreeWrite) => {
      if (first && write.puts.size > 0) {
        first = false;
        entered();
        await blocked;
      }
      return original(write);
    };
    const flushing = tree.flush();
    await waiting;
    const changed = (await tree.stateAt(tree.rootTag!))!;
    changed.signaturePrivateKey = changed.signaturePrivateKey.slice();
    changed.signaturePrivateKey[0] ^= 1;
    tree.updateSnapshot(tree.rootTag!, changed);
    release();
    await flushing;
    expect(tree.isDirty).toBe(true);
    await tree.flush();
    const reloaded = (await GroupHistoryTree.load(
      store,
      bytesToHex(memberE1.groupContext.groupId),
    ))!;
    expect(await reloaded.snapshotOf(tree.rootTag!)).toEqual(
      serializeClientState(changed),
    );
    expect(tree.isDirty).toBe(false);
  });

  it("seeds a root and reports it as the sole tip", async () => {
    const { memberE1 } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);

    expect(tree.size).toBe(1);
    expect(tree.rootTag).toBe(rootTag);
    expect(tree.tips()).toEqual([rootTag]);
    expect(tree.node(rootTag)?.parentTag).toBeUndefined();
    expect(tree.node(rootTag)?.edge).toBeUndefined();
  });

  it("records a fork: one parent with two children", async () => {
    const { memberE1, commitA, commitB, childA, childB } =
      await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);

    const tagA = tree.recordCommit(rootTag, commitA, childA);
    const tagB = tree.recordCommit(rootTag, commitB, childB);

    expect(tagA).not.toBe(tagB);
    expect(tree.size).toBe(3);
    expect(new Set(tree.childrenOf(rootTag))).toEqual(new Set([tagA, tagB]));
    expect(new Set(tree.tips())).toEqual(new Set([tagA, tagB]));
    expect(tree.isTip(rootTag)).toBe(false);
    expect(tree.epochOf(tagA)).toBe(2);
    expect(tree.node(tagA)?.parentTag).toBe(rootTag);
    expect(tree.node(tagA)?.edge?.commitDigest).toHaveLength(32);
    expect(tree.lowestCommonAncestor(tagA, tagB)).toBe(rootTag);
    expect(tree.nodesAtEpoch(2).sort()).toEqual([tagA, tagB].sort());
  });

  it("recordCommit is idempotent on the child tag", async () => {
    const { memberE1, commitA, childA } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);

    const first = tree.recordCommit(rootTag, commitA, childA);
    const second = tree.recordCommit(rootTag, commitA, childA);

    expect(first).toBe(second);
    expect(tree.size).toBe(2);
    expect(tree.childrenOf(rootTag)).toEqual([first]);
  });

  it("upgrades a previously observed bare edge with confirmation-time own-commit evidence", async () => {
    const { memberE1, commitA, childA } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);
    const childTag = tree.recordCommit(rootTag, commitA, childA);
    const stamp = {
      committer: ADMIN,
      priority: "privileged" as const,
      consumedProposalRefs: [Uint8Array.of(2), Uint8Array.of(1)],
    };

    expect(await tree.ownCommitStampOf(childTag)).toBeUndefined();
    expect(tree.recordCommit(rootTag, commitA, childA, undefined, stamp)).toBe(
      childTag,
    );

    const store = memoryTreeStore();
    tree.bindStore(store);
    await tree.flush();
    const restored = (await GroupHistoryTree.load(
      store,
      bytesToHex(memberE1.groupContext.groupId),
    ))!;
    expect(await restored.ownCommitStampOf(childTag)).toEqual({
      ...stamp,
      consumedProposalRefs: [Uint8Array.of(1), Uint8Array.of(2)],
    });
  });

  it("rehydrates a fresh, independent state per stateAt call", async () => {
    const { memberE1, commitA, childA } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);
    const tagA = tree.recordCommit(rootTag, commitA, childA);

    const s1 = (await tree.stateAt(tagA))!;
    const s2 = (await tree.stateAt(tagA))!;
    expect(s1).not.toBe(s2);
    expect(bytesToHex(s1.confirmationTag)).toBe(tagA);
    expect(bytesToHex(s2.confirmationTag)).toBe(tagA);
    expect(Number(s1.groupContext.epoch)).toBe(2);

    // The retained commit message round-trips.
    expect(await tree.commitMessageOf(tagA)).toBeDefined();
    expect(await tree.commitBytesOf(tagA)).toBeDefined();
  });

  it("flushes incrementally and reloads structure + lazy snapshots from a store", async () => {
    const { memberE1, commitA, commitB, childA, childB } =
      await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    const rootTag = bytesToHex(memberE1.confirmationTag);
    const tagA = tree.recordCommit(rootTag, commitA, childA);
    const tagB = tree.recordCommit(rootTag, commitB, childB);

    const store = memoryTreeStore();
    tree.bindStore(store);
    expect(tree.isDirty).toBe(true);
    await tree.flush();
    expect(tree.isDirty).toBe(false);

    const restored = (await GroupHistoryTree.load(
      store,
      bytesToHex(memberE1.groupContext.groupId),
    ))!;

    expect(restored.rootTag).toBe(rootTag);
    expect(restored.size).toBe(3);
    expect(new Set(restored.childrenOf(rootTag))).toEqual(
      new Set([tagA, tagB]),
    );
    expect(new Set(restored.tips())).toEqual(new Set([tagA, tagB]));
    expect(restored.epochOf(tagB)).toBe(2);
    expect(restored.node(tagA)?.edge?.commitDigest).toEqual(
      tree.node(tagA)?.edge?.commitDigest,
    );
    // Heavy material is lazy-loaded from the store on demand.
    expect(bytesToHex((await restored.stateAt(tagA))!.confirmationTag)).toBe(
      tagA,
    );
    expect(await restored.commitMessageOf(tagB)).toBeDefined();
  });

  it("throws when recording a commit from an unknown parent", async () => {
    const { memberE1, commitA, childA } = await buildFork(impl);
    const tree = new GroupHistoryTree(memberE1);
    expect(() => tree.recordCommit("deadbeef", commitA, childA)).toThrow(
      /not in tree/,
    );
  });
});
