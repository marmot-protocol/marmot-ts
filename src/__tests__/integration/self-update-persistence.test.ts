import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import { GroupRegistry } from "../../client/group-registry.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

const RELAY = "wss://mock-relay.test";
const MEMBER = "e".repeat(64);
const ADMIN = "a".repeat(64);
const SIGNER = { getPublicKey: async () => MEMBER } as EventSigner;

/** Mock network that acks every publish and records the envelopes. */
function ackingNetwork(published: NostrEvent[] = []): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async (_relays, event) => {
      published.push(event);
      return { [RELAY]: { ok: true } as PublishResponse };
    },
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

/** Builds a 2-member group and returns the joining member's epoch-1 state. */
async function buildMemberState() {
  const impl = await getCiphersuiteImpl(
    "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
    defaultCryptoProvider,
  );
  const ctx = {
    cipherSuite: impl,
    authService: unsafeTestingAuthenticationService,
  };

  const adminKp = await generateKeyPackage({
    credential: createCredential(ADMIN),
    ciphersuiteImpl: impl,
  });
  const { clientState: created } = await createSimpleGroup(
    adminKp,
    impl,
    "Test Group",
    { adminPubkeys: [ADMIN], relays: [RELAY] },
  );
  const memberKp = await generateKeyPackage({
    credential: createCredential(MEMBER),
    ciphersuiteImpl: impl,
  });
  const { welcome } = await createCommit({
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

  return { impl, memberE1 };
}

describe("selfUpdate commit persistence (CR-09)", () => {
  /**
   * A selfUpdate IS a commit: it advances the epoch and produces a new
   * confirmation tag. Before the fix, `case "selfUpdate"` returned a pending
   * state with no `parentState`/`commitMessage`, so `confirmPublished` took
   * the tail `#setState` path and `#recordCommitNode` was never called.
   *
   * The visible consequence is at the NEXT LOAD: `GroupRegistry.#loadHistory`
   * checks `tree.hasNode(tipTag)` for the persisted tip and, finding the
   * post-selfUpdate tag absent, logs "discarding stale history tree" and
   * returns `undefined` — throwing away the entire persisted fork history and
   * the retained window rebuilt from it.
   *
   * MIP-02 tells clients to selfUpdate right after joining from a Welcome, so
   * on the normal join path the very first thing a client does destroyed its
   * own convergence persistence.
   */
  it("records the selfUpdate commit so the history tree survives a restart", async () => {
    const { impl, memberE1 } = await buildMemberState();
    const groupId = bytesToHex(memberE1.groupContext.groupId);
    const parentTag = bytesToHex(memberE1.confirmationTag);

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();

    // Session 1: join state, then selfUpdate through the real send/publish path.
    const first = new MarmotGroup(memberE1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: ackingNetwork(),
    });
    await first.save(true);
    await first.selfUpdate();

    const tipTag = bytesToHex(first.state.confirmationTag);
    const tipEpoch = Number(first.state.groupContext.epoch);
    // The selfUpdate really did advance the epoch — i.e. it is a commit.
    expect(tipEpoch).toBe(Number(memberE1.groupContext.epoch) + 1);
    expect(tipTag).not.toBe(parentTag);

    // In-process: the commit is in both the tree and the retained window.
    expect(first.session.historyTree.hasNode(tipTag)).toBe(true);
    expect(
      first.session.retainedStates().map((s) => Number(s.groupContext.epoch)),
    ).toContain(tipEpoch);

    await first.session.save();
    first.dispose();

    // Session 2: restart through the real load path.
    const registry = new GroupRegistry({
      store,
      rewindStore,
      signer: SIGNER,
      network: ackingNetwork(),
    });
    const reloaded = await registry.load(groupId);

    // The tree was NOT discarded: it still contains the post-selfUpdate tip
    // (and the parent it branched from).
    const tree = reloaded.session.historyTree;
    expect(tree.hasNode(tipTag)).toBe(true);
    expect(tree.hasNode(parentTag)).toBe(true);
    expect(tree.rootTag).toBe(parentTag);

    // ...and the rebuilt retained window covers the post-selfUpdate epoch, so
    // `resolveFork` can rebuild across a selfUpdate.
    const retainedEpochs = reloaded.session
      .retainedStates()
      .map((s) => Number(s.groupContext.epoch));
    expect(retainedEpochs).toContain(tipEpoch);
  });

  /**
   * WR-17: `case "selfUpdate"` now runs the same lifecycle gate and staging
   * bookkeeping as `case "commit"`. Two commits built off the same parent
   * would silently fork the group against itself — whichever
   * `confirmPublished` landed second overwrote the other's state.
   */
  it("refuses to prepare a selfUpdate while another commit is staged (WR-17)", async () => {
    const { impl, memberE1 } = await buildMemberState();

    const group = new MarmotGroup(memberE1, {
      store: new InMemoryKeyValueStore<SerializedClientState>(),
      signer: SIGNER,
      ciphersuite: impl,
      network: ackingNetwork(),
    });
    await group.save(true);

    const session = group.session;

    // Stage a commit through the session and leave its publish unconfirmed —
    // `session.send` builds and stages it without driving the runtime.
    await session.send({ kind: "commit", actorPubkey: MEMBER });
    expect(session.lifecycle).toBe("PendingPublish");

    // A second commit-producing seam must refuse while PendingPublish.
    await expect(session.send({ kind: "selfUpdate" })).rejects.toThrow(
      /Cannot prepare a commit while the group is PendingPublish/,
    );
  });
});
