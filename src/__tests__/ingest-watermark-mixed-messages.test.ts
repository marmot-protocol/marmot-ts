import { describe, expect, it } from "vitest";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import {
  createCommit,
  createApplicationMessage,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  joinGroup,
} from "ts-mls";

import { MarmotGroup } from "../client/group/marmot-group.js";
import type { NostrNetworkInterface } from "../client/nostr-interface.js";
import {
  defaultMarmotClientConfig,
  SerializedClientState,
} from "../core/client-state.js";
import { createCredential } from "../core/credential.js";
import {
  createGroupEvent,
  serializeApplicationRumor,
} from "../core/group-message.js";
import { createSimpleGroup } from "../core/group.js";
import { generateKeyPackage } from "../core/key-package.js";
import { GroupStore } from "../store/group-store.js";
import type { OuterCursor } from "../utils/cursor.js";

import type { GroupHistoryStore } from "../client/group/marmot-group.js";

class MemoryBackend<T> {
  private map = new Map<string, T>();
  async getItem(key: string): Promise<T | null> {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: T): Promise<T> {
    this.map.set(key, value);
    return value;
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
  async clear(): Promise<void> {
    this.map.clear();
  }
  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}

class MemoryHistoryStore implements GroupHistoryStore {
  processed: OuterCursor | null = null;
  rumorIds: string[] = [];

  async markOuterEventProcessed(outer: OuterCursor): Promise<void> {
    if (!this.processed) {
      this.processed = outer;
      return;
    }
    if (
      this.processed.created_at < outer.created_at ||
      (this.processed.created_at === outer.created_at &&
        this.processed.id < outer.id)
    ) {
      this.processed = outer;
    }
  }

  async getResumeCursor(): Promise<OuterCursor | null> {
    return this.processed;
  }

  async addRumor(entry: { rumor: Rumor; outer: OuterCursor }): Promise<void> {
    // record (dedupe not needed for this test)
    this.rumorIds.push(entry.rumor.id);
  }

  async queryRumors(): Promise<Rumor[]> {
    throw new Error("not needed");
  }
}

describe("MarmotGroup.ingest watermark correctness", () => {
  it("advances resume cursor across mixed outer event types (commit-only then application)", async () => {
    const adminPubkey = "a".repeat(64);
    const memberPubkey = "b".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    // Build a 2-member group so that commits can be created/processed.
    const adminCredential = createCredential(adminPubkey);
    const adminKp = await generateKeyPackage({
      credential: adminCredential,
      ciphersuiteImpl: impl,
    });
    const { clientState: createdState } = await createSimpleGroup(
      adminKp,
      impl,
      "Test Group",
      { adminPubkeys: [adminPubkey], relays: [] },
    );

    const memberCredential = createCredential(memberPubkey);
    const memberKp = await generateKeyPackage({
      credential: memberCredential,
      ciphersuiteImpl: impl,
    });
    const addProposal = {
      proposalType: "add" as const,
      add: { keyPackage: memberKp.publicPackage },
    };

    const { newState: adminStateEpoch1, welcome } = await createCommit(
      { state: createdState, cipherSuite: impl },
      {
        wireAsPublicMessage: false,
        extraProposals: [addProposal],
        ratchetTreeExtension: true,
      },
    );
    if (!welcome) throw new Error("expected welcome");
    const memberStateEpoch1 = await joinGroup(
      welcome,
      memberKp.publicPackage,
      memberKp.privatePackage,
      { findPsk: () => undefined },
      impl,
    );

    const backend = new MemoryBackend<SerializedClientState>();
    const store = new GroupStore(backend as any, defaultMarmotClientConfig);
    await store.add(memberStateEpoch1);

    const network: NostrNetworkInterface = {
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
    const signer = { getPublicKey: async () => memberPubkey } as EventSigner;
    const history = new MemoryHistoryStore();

    const group = new MarmotGroup(memberStateEpoch1, {
      store,
      signer,
      ciphersuite: impl,
      network,
      history,
    });

    // Outer event 1: commit (no rumor)
    const { commit: commitMsg } = await createCommit(
      { state: adminStateEpoch1, cipherSuite: impl },
      { wireAsPublicMessage: false, ratchetTreeExtension: true },
    );
    const commitEvent = await createGroupEvent({
      message: commitMsg,
      state: adminStateEpoch1,
      ciphersuite: impl,
    });
    commitEvent.created_at = 10;
    commitEvent.id = "a".repeat(64);

    for await (const _ of group.ingest([commitEvent])) {
      // drain
    }
    expect(await history.getResumeCursor()).toEqual({
      created_at: 10,
      id: "a".repeat(64),
    });

    // Outer event 2: application message
    const rumor: Rumor = {
      id: "r".repeat(64),
      kind: 1,
      content: "Hello",
      tags: [],
      created_at: 100,
      pubkey: memberPubkey,
    };
    const applicationData = serializeApplicationRumor(rumor);
    const { privateMessage } = await createApplicationMessage(
      group.state,
      applicationData,
      impl,
    );
    const appMls = {
      version: group.state.groupContext.version,
      wireformat: "mls_private_message" as const,
      privateMessage,
    };
    const appEvent = await createGroupEvent({
      message: appMls,
      state: group.state,
      ciphersuite: impl,
    });
    appEvent.created_at = 11;
    appEvent.id = "b".repeat(64);

    for await (const _ of group.ingest([appEvent])) {
      // drain
    }
    expect(history.rumorIds.length).toBe(1);
    expect(await history.getResumeCursor()).toEqual({
      created_at: 11,
      id: "b".repeat(64),
    });
  });
});
