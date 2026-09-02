import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  encode,
  getCiphersuiteImpl,
  joinGroup,
  mlsMessageEncoder,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupRegistry } from "../../client/group-registry.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  SerializedClientState,
} from "../../core/client-state.js";
import {
  commitDigest,
  DEFAULT_CONVERGENCE_POLICY,
  selectCanonicalBranch,
} from "../../core/convergence.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { buildTreeBranchSet } from "../../engine/tree-convergence.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

const NETWORK: NostrNetworkInterface = {
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

const MEMBER_PUBKEY = "e".repeat(64);
const SIGNER = { getPublicKey: async () => MEMBER_PUBKEY } as EventSigner;

/**
 * Builds a 2-member group at epoch 1, plus two competing commits from that
 * epoch-1 admin state. The member is the fork-recovery receiver. Returns the
 * member's epoch-1 state and the lower/higher commit_digest events + the
 * canonical (lower) and losing (higher) post-commit member states.
 */
async function buildForkScenario(impl: CiphersuiteImpl) {
  const adminPubkey = "a".repeat(64);
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };

  const adminKp = await generateKeyPackage({
    credential: createCredential(adminPubkey),
    ciphersuiteImpl: impl,
  });
  const { clientState: createdState } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [adminPubkey], relays: ["wss://mock-relay.test"] },
  );

  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER_PUBKEY),
    ciphersuiteImpl: impl,
  });
  const { newState: adminEpoch1, welcome } = await createCommit({
    context: ctx,
    state: createdState,
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

  const commitA = await createCommit({
    context: ctx,
    state: adminEpoch1,
    extraProposals: [],
  });
  const commitB = await createCommit({
    context: ctx,
    state: adminEpoch1,
    extraProposals: [],
  });
  const digestA = commitDigest(encode(mlsMessageEncoder, commitA.commit));
  const digestB = commitDigest(encode(mlsMessageEncoder, commitB.commit));
  const aWins = Buffer.compare(Buffer.from(digestA), Buffer.from(digestB)) < 0;
  const lower = aWins ? commitA : commitB;
  const higher = aWins ? commitB : commitA;

  const lowerEvent = await createGroupEvent({
    message: lower.commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });
  const higherEvent = await createGroupEvent({
    message: higher.commit,
    state: adminEpoch1,
    ciphersuite: impl,
  });

  // The canonical tip = the member applying the lower commit directly.
  const canonical = await processMessage({
    context: ctx,
    state: memberEpoch1,
    message: lower.commit,
  });
  if (canonical.kind !== "newState") throw new Error("expected newState");
  // The losing tip = the member applying the higher commit directly.
  const losing = await processMessage({
    context: ctx,
    state: memberEpoch1,
    message: higher.commit,
  });
  if (losing.kind !== "newState") throw new Error("expected newState");

  return {
    memberEpoch1,
    lowerEvent,
    higherEvent,
    lowerCommit: lower.commit,
    higherCommit: higher.commit,
    canonicalState: canonical.newState,
    losingState: losing.newState,
    canonicalTag: canonical.newState.confirmationTag,
    losingTag: losing.newState.confirmationTag,
  };
}

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("rewind history persistence across restart", () => {
  it("rewinds to the canonical branch after a restart when the rewind store is persisted", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { memberEpoch1, lowerEvent, higherEvent, canonicalTag } =
      await buildForkScenario(impl);
    const groupId = bytesToHex(memberEpoch1.groupContext.groupId);

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();

    // Session 1: follow the losing (higher) branch onto epoch 2, persisting the
    // tip state and the full-fork history tree (which retains epoch 1 + its
    // commit — the bounded rewind window is rebuilt from the tree on load).
    const first = new MarmotGroup(memberEpoch1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });
    await drain(first.ingest([higherEvent]));
    expect(first.state.groupContext.epoch).toBe(
      memberEpoch1.groupContext.epoch + 1n,
    );
    first.dispose();

    // Sanity: the history tree was actually persisted (per-node edge keys).
    const persistedKeys = await rewindStore.keys();
    expect(persistedKeys.some((k) => k.startsWith(`${groupId}/edge/`))).toBe(
      true,
    );

    // "Restart": rehydrate the group through the real load path.
    const registry = new GroupRegistry({
      store,
      rewindStore,
      signer: SIGNER,
      network: NETWORK,
    });
    const reloaded = await registry.load(groupId);

    // The canonical (lower) commit arrives after restart → fork recovery rewinds
    // to the retained epoch-1 state and converges onto the canonical branch.
    let recovered = false;
    for await (const res of reloaded.ingest([lowerEvent])) {
      if (res.kind === "processed") recovered = true;
    }

    expect(recovered).toBe(true);
    expect(reloaded.lifecycle).toBe("Stable");
    expect(reloaded.state.confirmationTag).toEqual(canonicalTag);
  });

  it("switches to the canonical branch on restart when both forks are persisted and no new event arrives", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const {
      memberEpoch1,
      lowerCommit,
      canonicalState,
      higherEvent,
      canonicalTag,
      losingTag,
    } = await buildForkScenario(impl);
    const groupId = bytesToHex(memberEpoch1.groupContext.groupId);

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();

    // Session 1: follow the losing (higher) branch onto epoch 2, then record the
    // competing canonical (lower) branch into the persisted fork tree WITHOUT
    // converging onto it — simulating a client that captured the rival fork but
    // stopped before the convergence pass (tree flushed, tip still the loser).
    const first = new MarmotGroup(memberEpoch1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });
    await drain(first.ingest([higherEvent]));
    expect(first.state.confirmationTag).toEqual(losingTag);
    first.forkTree.recordCommit(
      bytesToHex(memberEpoch1.confirmationTag),
      lowerCommit,
      canonicalState,
    );
    expect(first.forkTree.tips()).toHaveLength(2);
    await first.save(true);
    first.dispose();

    // "Restart" through the real load path — and ingest NOTHING afterwards.
    const registry = new GroupRegistry({
      store,
      rewindStore,
      signer: SIGNER,
      network: NETWORK,
    });
    const reloaded = await registry.get(groupId);

    // Registry activation re-scores the persisted forks straight from disk and
    // switches to the canonical (lower-digest) branch — no network redelivery.
    // `load()` itself remains hydration-only; `get()` tracks/listens first.
    expect(reloaded.state.confirmationTag).toEqual(canonicalTag);
    expect(reloaded.state.confirmationTag).not.toEqual(losingTag);
    expect(reloaded.lifecycle).toBe("Stable");
  });

  it("cannot rewind after a restart without a persisted rewind store (the gap this fixes)", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { memberEpoch1, lowerEvent, higherEvent, canonicalTag, losingTag } =
      await buildForkScenario(impl);
    const groupId = bytesToHex(memberEpoch1.groupContext.groupId);

    const store = new InMemoryKeyValueStore<SerializedClientState>();

    // Session 1: follow the losing branch (no rewind store → in-memory only).
    const first = new MarmotGroup(memberEpoch1, {
      store,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });
    await drain(first.ingest([higherEvent]));
    first.dispose();

    // "Restart" from the persisted tip only — retained history is gone.
    const reloaded = new MarmotGroup(
      deserializeClientState((await store.getItem(groupId))!),
      { store, signer: SIGNER, ciphersuite: impl, network: NETWORK },
    );

    await drain(reloaded.ingest([lowerEvent]));

    // The late canonical commit is dropped as beyond-anchor: the client stays on
    // the losing branch and never converges (documents the pre-fix behavior).
    expect(reloaded.state.confirmationTag).toEqual(losingTag);
    expect(reloaded.state.confirmationTag).not.toEqual(canonicalTag);
  });

  it("holds a competing-branch app message silently, then reveals it on switch", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const {
      memberEpoch1,
      lowerEvent,
      higherEvent,
      canonicalState,
      canonicalTag,
      losingTag,
    } = await buildForkScenario(impl);

    // An application message published on the canonical (lower) branch — it
    // decrypts only against that branch's epoch-2 secret.
    const appMessage = await createApplicationMessage({
      context: {
        cipherSuite: impl,
        authService: unsafeTestingAuthenticationService,
      },
      state: canonicalState,
      message: new TextEncoder().encode("on-the-canonical-branch"),
    });
    const appEvent = await createGroupEvent({
      message: appMessage.message,
      state: canonicalState,
      ciphersuite: impl,
    });

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const group = new MarmotGroup(memberEpoch1, {
      store,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });

    // Follow the losing (higher) branch first.
    await drain(group.ingest([higherEvent]));
    expect(group.state.confirmationTag).toEqual(losingTag);

    // The canonical-branch app message arrives BEFORE its branch is known. It
    // cannot decrypt on our losing tip, so it is held silently in the pool —
    // never surfaced as `invalidated`, never delivered — instead of being
    // retracted.
    const held: string[] = [];
    for await (const res of group.ingest([appEvent])) held.push(res.kind);
    expect(held).not.toContain("invalidated");
    expect(group.state.confirmationTag).toEqual(losingTag); // unchanged
    expect(group.pendingEvents().length).toBe(1); // retained silently

    // When the canonical commit arrives we converge onto it and act on the held
    // message against the now-canonical branch — releasing it from the pool,
    // still never retracting it as `invalidated`.
    const after: string[] = [];
    for await (const res of group.ingest([lowerEvent])) after.push(res.kind);
    expect(group.state.confirmationTag).toEqual(canonicalTag); // switched
    expect(after).not.toContain("invalidated");
    expect(group.pendingEvents().length).toBe(0); // released on switch
  });
});

describe("buildTreeBranchSet", () => {
  it("returns undefined for a single-branch tree (no competing tip)", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const { memberEpoch1 } = await buildForkScenario(impl);
    const tree = new GroupHistoryTree(memberEpoch1);
    const rootTag = bytesToHex(memberEpoch1.confirmationTag);

    expect(
      buildTreeBranchSet(tree, rootTag, DEFAULT_CONVERGENCE_POLICY),
    ).toBeUndefined();
  });

  it("enumerates both fork tips from the shared root and selects the lower-digest winner", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const {
      memberEpoch1,
      lowerCommit,
      higherCommit,
      canonicalState,
      losingState,
    } = await buildForkScenario(impl);

    const tree = new GroupHistoryTree(memberEpoch1);
    const rootTag = bytesToHex(memberEpoch1.confirmationTag);
    tree.recordCommit(rootTag, lowerCommit, canonicalState);
    tree.recordCommit(rootTag, higherCommit, losingState);

    const canonicalTagHex = bytesToHex(canonicalState.confirmationTag);
    const losingTagHex = bytesToHex(losingState.confirmationTag);

    // Re-converge from the perspective of a client sitting on the losing tip.
    const set = buildTreeBranchSet(
      tree,
      losingTagHex,
      DEFAULT_CONVERGENCE_POLICY,
    );
    expect(set).toBeDefined();
    expect(set!.rootTag).toBe(rootTag);
    // Both fork tips are candidates, the current (losing) tip included.
    expect(new Set(set!.candidates.map((c) => c.id))).toEqual(
      new Set([canonicalTagHex, losingTagHex]),
    );
    expect(set!.candidates.every((c) => c.forkEpoch === 1)).toBe(true);

    // The lower-digest branch wins the same-depth tie.
    const winner = selectCanonicalBranch(
      Number(losingState.groupContext.epoch),
      set!.candidates,
      DEFAULT_CONVERGENCE_POLICY,
    );
    expect(winner?.id).toBe(canonicalTagHex);
  });

  it("excludes a fork beyond the rollback horizon", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const {
      memberEpoch1,
      lowerCommit,
      higherCommit,
      canonicalState,
      losingState,
    } = await buildForkScenario(impl);

    const tree = new GroupHistoryTree(memberEpoch1);
    const rootTag = bytesToHex(memberEpoch1.confirmationTag);
    tree.recordCommit(rootTag, lowerCommit, canonicalState);
    tree.recordCommit(rootTag, higherCommit, losingState);

    // A zero-commit horizon makes the epoch-1 fork (one commit back from the
    // epoch-2 tip) ineligible — nothing to switch to.
    const set = buildTreeBranchSet(
      tree,
      bytesToHex(losingState.confirmationTag),
      {
        ...DEFAULT_CONVERGENCE_POLICY,
        maxRewindCommits: 0,
      },
    );
    expect(set).toBeUndefined();
  });
});
