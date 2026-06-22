import { bytesToHex } from "@noble/hashes/utils.js";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  processMessage,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { beforeAll, describe, expect, it } from "vitest";

import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";
import { GroupHistoryTree } from "../history-tree.js";

const ADMIN = "a".repeat(64);
const MEMBER = "e".repeat(64);

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
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(adminKp, impl, "T", {
    adminPubkeys: [ADMIN],
    relays: ["wss://mock.test"],
  });

  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER),
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

    const store = new InMemoryKeyValueStore<Uint8Array>();
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
