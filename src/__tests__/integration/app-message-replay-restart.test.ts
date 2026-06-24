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
 * Documents the actual durability boundary for the m6 content-derived dedup.
 *
 * The dedup `seen`/`sent` sets are in-memory only and reset to empty on restart,
 * but they are NOT what prevents a duplicate across a restart: the persisted MLS
 * `ClientState` is. For an application message, processing advances the sender's
 * ratchet generation; that advance is persisted on save, and MLS forward secrecy
 * then deletes the consumed generation's secret. A relay replaying the same event
 * after a restart therefore cannot be decrypted (`unreadable`) and is never
 * delivered twice — even though the in-memory dedup that would have tagged it
 * `duplicate` is gone.
 */
describe("application message replay across restart (forward secrecy is the boundary)", () => {
  it("does not re-deliver a replayed application message after restart, with the in-memory dedup reset", async () => {
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
    const signer = { getPublicKey: async () => adminPubkey } as EventSigner;

    // Session 1: the admin delivers the message exactly once. Ingest persists the
    // advanced ratchet state to `store`.
    const first = new MarmotGroup(adminEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });
    const firstKinds = await collectKinds(first.ingest([event]));
    expect(firstKinds.filter((k) => k === "processed")).toHaveLength(1);
    first.dispose();

    // "Restart": rehydrate from the persisted state only. The new engine starts
    // with empty dedup sets — so anything preventing a second delivery now comes
    // purely from the persisted MLS state, not from content dedup.
    const persisted = await store.getItem(groupId);
    expect(persisted).toBeDefined();
    const reloaded = new MarmotGroup(deserializeClientState(persisted!), {
      store,
      signer,
      ciphersuite: impl,
      network: NETWORK,
    });

    // Replay the exact same event. Forward secrecy (the consumed generation's
    // secret was persisted-away) makes it unreadable; it is never delivered again.
    const replayKinds = await collectKinds(reloaded.ingest([event]));
    expect(replayKinds).not.toContain("processed");
    expect(replayKinds).toContain("unreadable");
    // The replay did not advance or corrupt canonical state.
    expect(reloaded.state.groupContext.epoch).toBe(
      adminEpoch1.groupContext.epoch,
    );
  });
});
