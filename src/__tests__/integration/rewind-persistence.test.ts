import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
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
import { commitDigest } from "../../core/convergence.js";
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

    // Session 1: follow the losing (higher) branch onto epoch 2, persisting both
    // the tip state and the rewind window (which retains epoch 1 + its commit).
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

    // Sanity: the rewind blob was actually written.
    expect(await rewindStore.getItem(groupId)).not.toBeNull();

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
});
