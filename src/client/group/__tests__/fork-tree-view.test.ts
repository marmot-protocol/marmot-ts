import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  type CiphersuiteImpl,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import type { NostrNetworkInterface } from "../../nostr-interface.js";
import type { SerializedClientState } from "../../../core/client-state.js";
import { createCredential } from "../../../core/credential.js";
import { createGroupEvent } from "../../../core/group-message.js";
import { createSimpleGroup } from "../../../core/group.js";
import { generateKeyPackage } from "../../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../../extra/in-memory-key-value-store.js";
import { MarmotGroup } from "../marmot-group.js";

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

describe("MarmotGroup fork-tree customer API", () => {
  it("exposes the fork tree and a canonical-marked view, and emits historyChanged", async () => {
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

    const group = new MarmotGroup(memberE1, {
      signer: SIGNER,
      ciphersuite: impl,
      network: NETWORK,
      store: new InMemoryKeyValueStore<SerializedClientState>(),
    });

    let changes = 0;
    group.on("historyChanged", () => changes++);

    await drain(group.ingest([eventA]));
    await drain(group.ingest([eventB]));

    const rootTag = bytesToHex(memberE1.confirmationTag);
    const tipTag = bytesToHex(group.state.confirmationTag);

    // historyChanged fired for both ingests (each grew the tree).
    expect(changes).toBe(2);

    // Live tree exposes structure.
    expect(group.forkTree.size).toBe(3);
    expect(group.forkTree.childrenOf(rootTag)).toHaveLength(2);

    const view = group.forkTreeView();
    expect(view.rootTag).toBe(rootTag);
    expect(view.canonicalTip).toBe(tipTag);
    expect(view.nodes).toHaveLength(3);
    expect(new Set(view.tips)).toEqual(
      new Set(group.forkTree.childrenOf(rootTag)),
    );

    // Canonical path = root → live tip; the losing branch is not canonical.
    expect(view.canonicalPath).toEqual([rootTag, tipTag]);
    const tipNode = view.nodes.find((n) => n.tag === tipTag)!;
    expect(tipNode.canonical).toBe(true);
    expect(tipNode.isCanonicalTip).toBe(true);
    expect(tipNode.isTip).toBe(true);
    expect(tipNode.commit?.digestHex).toHaveLength(64);

    const loser = view.nodes.find((n) => n.isTip && n.tag !== tipTag)!;
    expect(loser.canonical).toBe(false);
    expect(loser.isCanonicalTip).toBe(false);

    const rootNode = view.nodes.find((n) => n.tag === rootTag)!;
    expect(rootNode.canonical).toBe(true);
    expect(rootNode.commit).toBeUndefined();
  });
});
