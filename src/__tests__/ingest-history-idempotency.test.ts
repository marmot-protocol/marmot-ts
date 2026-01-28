import { describe, expect, it } from "vitest";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  createApplicationMessage,
  defaultCryptoProvider,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
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
  rumors = new Map<string, Rumor>();

  async markOuterEventProcessed(outer: OuterCursor): Promise<void> {
    // monotonic max by (created_at, id)
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
    // idempotent on rumor.id
    this.rumors.set(entry.rumor.id, entry.rumor);
  }
  async queryRumors(): Promise<Rumor[]> {
    return Array.from(this.rumors.values());
  }
}

describe("MarmotGroup.ingest history idempotency", () => {
  it("replaying the same outer event does not duplicate rumors; resume cursor is monotonic", async () => {
    const adminPubkey = "a".repeat(64);
    const impl = await getCiphersuiteImpl(
      getCiphersuiteFromName("MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"),
      defaultCryptoProvider,
    );

    const credential = createCredential(adminPubkey);
    const kp = await generateKeyPackage({ credential, ciphersuiteImpl: impl });
    const { clientState } = await createSimpleGroup(kp, impl, "Test Group", {
      adminPubkeys: [adminPubkey],
      relays: [],
    });

    const backend = new MemoryBackend<SerializedClientState>();
    const store = new GroupStore(backend as any, defaultMarmotClientConfig);
    await store.add(clientState);

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

    const signer = { getPublicKey: async () => adminPubkey } as EventSigner;
    const history = new MemoryHistoryStore();

    const group = new MarmotGroup(clientState, {
      store,
      signer,
      ciphersuite: impl,
      network,
      history,
    });

    const rumor: Rumor = {
      id: "r".repeat(64),
      kind: 1,
      content: "Hello",
      tags: [],
      created_at: 100,
      pubkey: adminPubkey,
    };

    const applicationData = serializeApplicationRumor(rumor);
    const { privateMessage } = await createApplicationMessage(
      group.state,
      applicationData,
      impl,
    );
    const mlsMessage = {
      version: group.state.groupContext.version,
      wireformat: "mls_private_message" as const,
      privateMessage,
    };

    const outerEvent: NostrEvent = await createGroupEvent({
      message: mlsMessage,
      state: group.state,
      ciphersuite: impl,
    });
    outerEvent.created_at = 10;
    outerEvent.id = "b".repeat(64);

    // First ingest
    for await (const _ of group.ingest([outerEvent])) {
      // drain
    }
    expect(history.rumors.size).toBe(1);
    expect(await history.getResumeCursor()).toEqual({
      created_at: 10,
      id: "b".repeat(64),
    });

    // Replay ingest (same event)
    for await (const _ of group.ingest([outerEvent])) {
      // drain
    }
    expect(history.rumors.size).toBe(1);
    expect(await history.getResumeCursor()).toEqual({
      created_at: 10,
      id: "b".repeat(64),
    });
  });
});
