import { EventSigner } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  CiphersuiteImpl,
  type ClientState,
  createCommit,
  defaultCryptoProvider,
  defaultProposalTypes,
  getCiphersuiteImpl,
  joinGroup,
  type ProposalRemove,
  unsafeTestingAuthenticationService,
} from "ts-mls";
import { describe, expect, it } from "vitest";

import { MarmotGroup } from "../../client/group/marmot-group.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "../../client/nostr-interface.js";
import { SerializedClientState } from "../../core/client-state.js";
import { createCredential } from "../../core/credential.js";
import { createGroupEvent } from "../../core/group-message.js";
import { createSimpleGroup } from "../../core/group.js";
import { generateKeyPackage } from "../../core/key-package.js";
import { InMemoryKeyValueStore } from "../../extra/in-memory-key-value-store";

const RELAY = "wss://relay.test";

/** A mock network that records every published event and acks it. */
function recordingNetwork(published: NostrEvent[]): NostrNetworkInterface {
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

function marmotGroup(
  state: ClientState,
  pubkey: string,
  impl: CiphersuiteImpl,
  published: NostrEvent[],
  store = new InMemoryKeyValueStore<SerializedClientState>(),
) {
  return new MarmotGroup(state, {
    store,
    signer: { getPublicKey: async () => pubkey } as EventSigner,
    ciphersuite: impl,
    network: recordingNetwork(published),
  });
}

describe("involuntary removal signal", () => {
  it("emits `removed` and keeps the tombstone when an admin's commit removes us", async () => {
    const adminPubkey = "a".repeat(64);
    const dPubkey = "d".repeat(64);
    const ePubkey = "e".repeat(64);
    const impl = await getCiphersuiteImpl(
      "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
      defaultCryptoProvider,
    );
    const ctx = {
      cipherSuite: impl,
      authService: unsafeTestingAuthenticationService,
    };

    // 3-member group: admin "a" (leaf 0), "d" (leaf 1), "e" (leaf 2).
    const adminKp = await generateKeyPackage({
      credential: createCredential(adminPubkey),
      ciphersuiteImpl: impl,
    });
    const { clientState: created } = await createSimpleGroup(
      adminKp,
      impl,
      "Group",
      { adminPubkeys: [adminPubkey], relays: [RELAY] },
    );
    const dKp = await generateKeyPackage({
      credential: createCredential(dPubkey),
      ciphersuiteImpl: impl,
    });
    const eKp = await generateKeyPackage({
      credential: createCredential(ePubkey),
      ciphersuiteImpl: impl,
    });
    const { newState: adminEpoch1, welcome } = await createCommit({
      context: ctx,
      state: created,
      wireAsPublicMessage: false,
      extraProposals: [
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: dKp.publicPackage },
        },
        {
          proposalType: defaultProposalTypes.add,
          add: { keyPackage: eKp.publicPackage },
        },
      ],
      ratchetTreeExtension: true,
    });
    const welcomeMsg = welcome!.welcome ?? (welcome as never);
    const eEpoch1 = await joinGroup({
      context: ctx,
      welcome: welcomeMsg,
      keyPackage: eKp.publicPackage,
      privateKeys: eKp.privatePackage,
      ratchetTree: undefined,
    });

    // Admin "a" commits a Remove targeting "e" (leaf 2) — an involuntary removal.
    const removeE: ProposalRemove = {
      proposalType: defaultProposalTypes.remove,
      remove: { removed: eEpoch1.privatePath.leafIndex },
    };
    const { commit } = await createCommit({
      context: ctx,
      state: adminEpoch1,
      wireAsPublicMessage: true,
      ratchetTreeExtension: true,
      extraProposals: [removeE],
    });
    const removeCommitEvent = await createGroupEvent({
      message: commit,
      state: adminEpoch1,
      ciphersuite: impl,
    });

    // "e" ingests the commit that removes it.
    const ePublished: NostrEvent[] = [];
    const eStore = new InMemoryKeyValueStore<SerializedClientState>();
    const eGroup = marmotGroup(eEpoch1, ePubkey, impl, ePublished, eStore);
    await eGroup.save(true); // persist initial state so we can assert it survives

    let removedEmitted = false;
    eGroup.on("removed", () => (removedEmitted = true));

    const kinds: string[] = [];
    for await (const r of eGroup.ingest([removeCommitEvent]))
      kinds.push(r.kind);

    // The ingest surfaced a `removed` result and fired the event.
    expect(kinds).toContain("removed");
    expect(removedEmitted).toBe(true);

    // State is the tombstone, and it was NOT auto-destroyed: the store still
    // holds the (now removed) group state.
    expect(eGroup.state.groupActiveState.kind).toBe("removedFromGroup");
    expect(await eStore.getItem(eGroup.idStr)).not.toBeNull();
  });
});
