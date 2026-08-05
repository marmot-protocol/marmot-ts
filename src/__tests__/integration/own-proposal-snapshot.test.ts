import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  type LeafIndex,
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
import { getPubkeyLeafNodeIndexes } from "../../core/group-members.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { framedCommitProposals } from "../../engine/wire-format.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store.js";

const RELAY = "wss://mock-relay.test";
const ADMIN = "a".repeat(64);
const MEMBER = "d".repeat(64);
const SIGNER = { getPublicKey: async () => ADMIN } as EventSigner;

function ackingNetwork(): NostrNetworkInterface {
  return {
    request: async () => {
      throw new Error("not used");
    },
    subscription: () => {
      throw new Error("not used");
    },
    publish: async (_relays: string[], _event: NostrEvent) => ({
      [RELAY]: { ok: true } as PublishResponse,
    }),
    getUserInboxRelays: async () => {
      throw new Error("not used");
    },
  };
}

/** A 2-member group at epoch 1: admin ADMIN (us, leaf 0) and non-admin MEMBER. */
async function buildAdminState() {
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
  const { newState: adminE1 } = await createCommit({
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

  return { impl, adminE1 };
}

describe("own staged proposals in the history-tree snapshot (CR-08)", () => {
  /**
   * CR-08 root cause: `confirmPublished` wrote our own staged proposal into
   * canonical state via `#setState` but never into the history-tree node
   * snapshot — `recordProposalStaged` was wired only for INBOUND proposals
   * (`ingest.ts`). A tree node's snapshot is captured when its commit is
   * recorded and `recordCommit` never refreshes the parent, so a proposal
   * staged after that commit was invisible to the persisted tree.
   *
   * After a restart `GroupRegistry.#retainedFromTree` rebuilds
   * `RetainedHistoryStore` purely from those snapshots, so
   * `retained.stateAt(forkEpoch).unappliedProposals` came back empty. A commit
   * that bundled the proposal BY REFERENCE (which `createCommit` always does)
   * then could not have its proposal set reconstructed:
   * `framedCommitProposals` returned `undefined`, the CONV-04 known-state
   * short-circuit fell through to replay, and replaying OUR OWN commit throws
   * (RFC 9420: an `UpdatePath` never encrypts a path secret to the committer's
   * own leaf). The candidate — our own canonical branch — was dropped
   * entirely, so `selectCanonicalBranch` scored only the competitors and the
   * engine rewound off its own deeper branch onto a shallower one.
   *
   * This asserts the seam that actually gates that behaviour: after a restart,
   * `framedCommitProposals` can still reconstruct our commit's proposals from
   * the reloaded parent snapshot.
   */
  it("keeps our own staged proposal reconstructable from the tree after a restart", async () => {
    const { impl, adminE1 } = await buildAdminState();
    const groupId = bytesToHex(adminE1.groupContext.groupId);

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();

    const group = new MarmotGroup(adminE1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: ackingNetwork(),
    });
    await group.save(true);

    // 1. A first commit, so the tree already holds a node for the tip the
    //    proposal will be staged against. (Without a prior commit the tree is
    //    seeded by `setRoot(parentState)` at commit time, which would capture
    //    the proposal incidentally and hide the defect.)
    await group.selfUpdate();
    const parentTag = bytesToHex(group.state.confirmationTag);
    expect(group.session.historyTree.hasNode(parentTag)).toBe(true);

    // 2. Stage OUR OWN proposal: remove the non-admin member. Staging does not
    //    advance the epoch, so the tip tag is unchanged — it is that node's
    //    snapshot that must be refreshed.
    const [memberLeaf] = getPubkeyLeafNodeIndexes(group.state, MEMBER);
    expect(memberLeaf).toBeDefined();
    await group.sendProposal({
      proposalType: defaultProposalTypes.remove,
      remove: { removed: memberLeaf as LeafIndex },
    });
    expect(Object.keys(group.state.unappliedProposals)).toHaveLength(1);
    expect(bytesToHex(group.state.confirmationTag)).toBe(parentTag);

    // 3. Commit. `createCommit` bundles the staged proposal BY REFERENCE, so
    //    the wire commit carries a ProposalRef, not the proposal itself.
    await group.submitIntent({ kind: "commit", actorPubkey: ADMIN });
    const childTag = bytesToHex(group.state.confirmationTag);
    expect(childTag).not.toBe(parentTag);

    await group.session.save();
    group.dispose();

    // 4. Restart through the real load path.
    const registry = new GroupRegistry({
      store,
      rewindStore,
      signer: SIGNER,
      network: ackingNetwork(),
    });
    const reloaded = await registry.load(groupId);
    const tree = reloaded.session.historyTree;

    const reloadedParent = await tree.stateAt(parentTag);
    const commitMessage = await tree.commitMessageOf(childTag);
    expect(reloadedParent).toBeDefined();
    expect(commitMessage).toBeDefined();

    // The persisted parent snapshot carries the proposal we staged...
    expect(Object.keys(reloadedParent!.unappliedProposals)).toHaveLength(1);

    // ...so the ProposalRef resolves and the CONV-04 short-circuit stays
    // available. `undefined` here is exactly the CR-08 fall-through that
    // dropped our own branch.
    const proposals = framedCommitProposals(commitMessage!, reloadedParent!);
    expect(proposals).toBeDefined();
    expect(proposals).toHaveLength(1);
    expect(proposals![0].proposalType).toBe(defaultProposalTypes.remove);
  });
});
