import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
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
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
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

const MEMBER = "e".repeat(64);
const SIGNER = { getPublicKey: async () => MEMBER } as EventSigner;

async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("history tree persistence across restart", () => {
  it("retains both fork branches in the tree and reloads them after a restart", async () => {
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    const adminKp = await generateKeyPackage({
      credential: createCredential("a".repeat(64)),
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      { adminPubkeys: ["a".repeat(64)], relays: ["wss://mock-relay.test"] },
    );
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
    const groupId = bytesToHex(memberE1.groupContext.groupId);

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
    const eventA = await createGroupEvent({
      message: commitA.commit,
      state: adminE1,
      ciphersuite: impl,
    });
    const eventB = await createGroupEvent({
      message: commitB.commit,
      state: adminE1,
      ciphersuite: impl,
    });

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const rewindStore = new InMemoryKeyValueStore<Uint8Array>();
    const rootTag = bytesToHex(memberE1.confirmationTag);

    // Session 1: ingest both competing commits → the tree retains the fork.
    const first = new MarmotGroup(memberE1, {
      store,
      rewindStore,
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
    });
    await drain(first.ingest([eventA]));
    await drain(first.ingest([eventB]));
    expect(first.session.historyTree.childrenOf(rootTag)).toHaveLength(2);
    await first.session.save();
    first.dispose();

    // The tree's edge keys were written under the group prefix.
    const keys = await rewindStore.keys();
    expect(keys.some((k) => k.startsWith(`${groupId}/edge/`))).toBe(true);

    // Restart through the real load path.
    const registry = new GroupRegistry({
      store,
      rewindStore,
      signer: SIGNER,
      network: NETWORK,
    });
    const reloaded = await registry.load(groupId);

    const tree = reloaded.session.historyTree;
    expect(tree.rootTag).toBe(rootTag);
    expect(tree.size).toBe(3);
    expect(tree.childrenOf(rootTag)).toHaveLength(2);

    // Heavy snapshots lazily reload from the store for both retained branches.
    for (const child of tree.childrenOf(rootTag)) {
      const state = await tree.stateAt(child);
      expect(state).toBeDefined();
      expect(bytesToHex(state!.confirmationTag)).toBe(child);
    }
  });
});
