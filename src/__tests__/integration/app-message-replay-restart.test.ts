import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import {
  CiphersuiteImpl,
  createApplicationMessage,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { createChatRumor } from "../../client/group/application-message.js";
import { MarmotGroup } from "../../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../../client/nostr-interface.js";
import {
  deserializeClientState,
  SerializedClientState,
} from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../../core/group-message.js";
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

async function collectKinds(gen: AsyncIterable<{ kind: string }>) {
  const kinds: string[] = [];
  for await (const r of gen) kinds.push(r.kind);
  return kinds;
}

/**
 * Pins the durable outer transport boundary: a terminally accepted verified
 * wrapper is persisted independently of MLS state and suppressed on restart.
 */
describe("application message replay across restart", () => {
  it("does not re-process a terminal wrapper when the ingest ledger is reloaded", async () => {
    const impl: CiphersuiteImpl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const adminPubkey = "a".repeat(64);
    const memberPubkey = "d".repeat(64);
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 2-member group: admin (the persisted receiver under test) + a member whose
    // raw state we drive to produce one application message.
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: adminEpoch0 } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      { adminPubkeys: [adminPubkey], relays: ["wss://relay.test"] },
    );
    const memberKp = await generateKeyPackage({
      credential: createCredential(memberPubkey),
      ciphersuiteImpl: impl,
    });
    const add = await createCommit({
      context: ctx,
      state: adminEpoch0,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: memberKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const adminEpoch1 = add.newState;
    const memberState = await joinGroup({
      context: ctx,
      welcome: add.welcome!.welcome!,
      keyPackage: memberKp.publicPackage,
      privateKeys: memberKp.privatePackage,
      ratchetTree: undefined,
    });
    const groupId = bytesToHex(adminEpoch1.groupContext.groupId);

    // One valid Marmot app rumor from the member, wrapped as a kind-445 event.
    const rumor = createChatRumor({ pubkey: memberPubkey, content: "gm" });
    const app = await createApplicationMessage({
      context: ctx,
      state: memberState,
      message: serializeApplicationRumor(rumor),
    });
    const event = await createGroupEvent({
      message: app.message,
      state: memberState,
      ciphersuite: impl,
    });

    const store = new InMemoryKeyValueStore<SerializedClientState>();
    const ingestStateStore = new InMemoryKeyValueStore<Uint8Array>();
    const signer = { getPublicKey: async () => adminPubkey } as EventSigner;

    // Session 1: the admin delivers the message exactly once. Ingest persists the
    // advanced ratchet state to `store`.
    const first = new MarmotGroup(adminEpoch1, {
      store,
      ingestStateStore,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });
    const firstKinds = await collectKinds(first.ingest([event]));
    expect(firstKinds.filter((k) => k === "processed")).toHaveLength(1);
    first.dispose();

    // "Restart": rehydrate canonical state and reuse terminal wrapper evidence.
    const persisted = await store.getItem(groupId);
    expect(persisted).toBeDefined();
    const reloaded = new MarmotGroup(deserializeClientState(persisted!), {
      store,
      ingestStateStore,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });

    // Replay the exact same event. The durable outer-wrapper ledger suppresses
    // it before MLS work, including after reconstructing the group.
    const replayKinds = await collectKinds(reloaded.ingest([event]));
    expect(replayKinds).toEqual([]);
    // The replay did not advance or corrupt canonical state.
    expect(reloaded.state.groupContext.epoch).toBe(
      adminEpoch1.groupContext.epoch,
    );
  });
});
