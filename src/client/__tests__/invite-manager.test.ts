import { PrivateKeyAccount } from "applesauce-accounts/accounts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteManager } from "../invite-manager.js";
import type {
  ReceivedGiftWrap,
  StoredInviteEntry,
  UnreadInvite,
} from "../invite-manager.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { WELCOME_EVENT_KIND } from "../../core/protocol.js";

/**
 * Simple in-memory backend for testing
 */
class MemoryBackend<T> implements GenericKeyValueStore<T> {
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

/**
 * Create a mock gift wrap event (kind 1059)
 */
function createMockGiftWrap(id: string, recipientPubkey: string): NostrEvent {
  return {
    id,
    kind: 1059,
    pubkey: "sender-pubkey",
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
    content: "encrypted-content",
    sig: "signature",
  };
}

/**
 * Create a mock Welcome rumor (kind 444)
 */
function createMockWelcomeRumor(
  id: string,
  senderPubkey: string,
  keyPackageEventId = "test-key-package-id",
): Rumor {
  return {
    id,
    kind: WELCOME_EVENT_KIND,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["relays", "wss://relay1.test", "wss://relay2.test"],
      ["e", keyPackageEventId],
      ["encoding", "base64"],
    ],
    content: "base64-encoded-welcome-message",
  };
}

/** Helper to read the seen IDs from the store */
async function getSeenIds(
  store: GenericKeyValueStore<StoredInviteEntry>,
): Promise<string[]> {
  const entry = await store.getItem("__seen");
  if (entry && entry.type === "seen") return entry.ids;
  return [];
}

describe("InviteManager", () => {
  let store: GenericKeyValueStore<StoredInviteEntry>;
  let account: PrivateKeyAccount<any>;
  let inviteManager: InviteManager;

  beforeEach(async () => {
    store = new MemoryBackend<StoredInviteEntry>();
    account = PrivateKeyAccount.generateNew();

    inviteManager = new InviteManager({
      signer: account.signer,
      store,
    });
  });

  describe("ingestEvent", () => {
    it("should ingest a new gift wrap event", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      const isNew = await inviteManager.ingestEvent(giftWrap);

      expect(isNew).toBe(true);

      // Check it's in received state
      const received = await inviteManager.getReceived();
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(giftWrap.id);
      expect(received[0]).toEqual(giftWrap);

      // Check it's marked as seen
      const seenIds = await getSeenIds(store);
      expect(seenIds).toContain(giftWrap.id);
    });

    it("should skip duplicate events", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      // Ingest first time
      const isNew1 = await inviteManager.ingestEvent(giftWrap);
      expect(isNew1).toBe(true);

      // Ingest second time (duplicate)
      const isNew2 = await inviteManager.ingestEvent(giftWrap);
      expect(isNew2).toBe(false);

      // Should only have one received event
      const received = await inviteManager.getReceived();
      expect(received).toHaveLength(1);
    });

    it("should throw on non-gift-wrap events", async () => {
      const invalidEvent = {
        id: "test",
        pubkey: "test-pubkey",
        created_at: Math.floor(Date.now() / 1000),
        kind: 1, // Regular note, not gift wrap
        tags: [],
        content: "test",
        sig: "test",
      } as NostrEvent;

      await expect(inviteManager.ingestEvent(invalidEvent)).rejects.toThrow(
        "Expected kind 1059 gift wrap",
      );
    });
  });

  describe("ingestEvents", () => {
    it("should ingest multiple events in batch", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap1 = createMockGiftWrap("test-id-1", pubkey);
      const giftWrap2 = createMockGiftWrap("test-id-2", pubkey);

      const newCount = await inviteManager.ingestEvents([giftWrap1, giftWrap2]);

      expect(newCount).toBe(2);

      const received = await inviteManager.getReceived();
      expect(received).toHaveLength(2);
    });

    it("should handle invalid events gracefully", async () => {
      const pubkey = await account.signer.getPublicKey();
      const validGiftWrap = createMockGiftWrap("test-id-1", pubkey);

      const invalidEvent = {
        id: "invalid",
        kind: 1,
        pubkey: "test",
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: "invalid",
        sig: "sig",
      } as NostrEvent;

      let errorEmitted = false;
      inviteManager.on("error", (err, eventId) => {
        errorEmitted = true;
        expect(eventId).toBe("invalid");
      });

      const newCount = await inviteManager.ingestEvents([
        validGiftWrap,
        invalidEvent,
      ]);

      expect(newCount).toBe(1); // Only valid event counted
      expect(errorEmitted).toBe(true);
    });
  });

  describe("decryptGiftWraps", () => {
    it("should emit error on decrypt failure", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      let errorEmitted = false;
      inviteManager.on("error", (err, eventId) => {
        errorEmitted = true;
        expect(eventId).toBe("test-id-1");
      });

      const unread = await inviteManager.decryptGiftWraps();

      // Since we can't properly decrypt without full infrastructure, this will fail
      expect(unread).toHaveLength(0);
      expect(errorEmitted).toBe(true);

      // Should be removed from received even on failure
      const received = await inviteManager.getReceived();
      expect(received).toHaveLength(0);
    });
  });

  describe("getUnread", () => {
    it("should return empty array when no unread invites", async () => {
      const unread = await inviteManager.getUnread();
      expect(unread).toHaveLength(0);
    });
  });

  describe("getReceived", () => {
    it("should return all received invites", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap1 = createMockGiftWrap("test-id-1", pubkey);
      const giftWrap2 = createMockGiftWrap("test-id-2", pubkey);

      await inviteManager.ingestEvents([giftWrap1, giftWrap2]);

      const received = await inviteManager.getReceived();
      expect(received).toHaveLength(2);
    });
  });

  describe("markAsRead", () => {
    it("should remove invite from unread", async () => {
      // Manually add an unread invite to test markAsRead
      const unread: UnreadInvite = createMockWelcomeRumor("rumor-1", "sender");
      const id = "test-id-1";

      await store.setItem(`unread:${id}`, { type: "unread", rumor: unread });

      const unreadBefore = await inviteManager.getUnread();
      expect(unreadBefore).toHaveLength(1);

      await inviteManager.markAsRead(id);

      const unreadAfter = await inviteManager.getUnread();
      expect(unreadAfter).toHaveLength(0);
    });

    it("should emit read event", async () => {
      const unread: UnreadInvite = createMockWelcomeRumor("rumor-1", "sender");

      await store.setItem(`unread:${unread.id}`, {
        type: "unread",
        rumor: unread,
      });

      let eventEmitted = false;
      let emittedId = "";
      inviteManager.on("read", (inviteId) => {
        eventEmitted = true;
        emittedId = inviteId;
      });

      await inviteManager.markAsRead(unread.id);

      expect(eventEmitted).toBe(true);
      expect(emittedId).toBe("rumor-1");
    });
  });

  describe("watchUnread", () => {
    it("should yield initial unread invites", async () => {
      // Manually add an unread invite
      const unread: UnreadInvite = createMockWelcomeRumor("rumor-1", "sender");

      await store.setItem(`unread:${unread.id}`, {
        type: "unread",
        rumor: unread,
      });

      const generator = inviteManager.watchUnread();
      const { value } = await generator.next();

      expect(value).toHaveLength(1);
      expect(value![0]).toEqual(unread);
    });

    it("should yield when invite is marked as read", async () => {
      // Add an unread invite
      const unread: UnreadInvite = createMockWelcomeRumor("rumor-1", "sender");

      await store.setItem(`unread:${unread.id}`, {
        type: "unread",
        rumor: unread,
      });

      const generator = inviteManager.watchUnread();

      // Get initial state (1 invite)
      const initial = await generator.next();
      expect(initial.value).toHaveLength(1);

      // Mark as read in background
      setTimeout(async () => {
        await inviteManager.markAsRead(unread.id);
      }, 10);

      // Should yield when invite is marked as read
      const updated = await generator.next();
      expect(updated.value).toHaveLength(0);
    });
  });

  describe("watchReceived", () => {
    it("should yield initial received invites", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      const generator = inviteManager.watchReceived();
      const { value } = await generator.next();

      expect(value).toHaveLength(1);
      expect(value[0].id).toBe(giftWrap.id);
    });

    it("should yield when new gift wrap is received", async () => {
      const pubkey = await account.signer.getPublicKey();
      const generator = inviteManager.watchReceived();

      // Get initial (empty) state
      const initial = await generator.next();
      expect(initial.value).toHaveLength(0);

      // Add gift wrap in background
      setTimeout(async () => {
        const giftWrap = createMockGiftWrap("test-id-1", pubkey);
        await inviteManager.ingestEvent(giftWrap);
      }, 10);

      // Should yield when new gift wrap is received
      const updated = await generator.next();
      expect(updated.value).toHaveLength(1);
    });

    it("should yield when received invite is processed", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      const generator = inviteManager.watchReceived();

      // Get initial state (1 gift wrap)
      const initial = await generator.next();
      expect(initial.value).toHaveLength(1);

      // Process received in background (will fail to decrypt but still remove)
      setTimeout(async () => {
        await inviteManager.decryptGiftWraps();
      }, 10);

      // Should yield when gift wrap is processed (removed)
      const updated = await generator.next();
      expect(updated.value).toHaveLength(0);
    });
  });

  describe("events", () => {
    it("should emit received when gift wrap is ingested", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      let eventEmitted = false;
      let emittedInvite: any = null;

      inviteManager.on("received", (invite) => {
        eventEmitted = true;
        emittedInvite = invite;
      });

      await inviteManager.ingestEvent(giftWrap);

      expect(eventEmitted).toBe(true);
      expect(emittedInvite.id).toBe(giftWrap.id);
    });

    it("should emit processed when gift wrap is decrypted", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      let eventEmitted = false;
      let emittedId = "";

      inviteManager.on("processed", (inviteId) => {
        eventEmitted = true;
        emittedId = inviteId;
      });

      // This will fail to decrypt but should still emit processed
      await inviteManager.decryptGiftWraps();

      expect(eventEmitted).toBe(true);
      expect(emittedId).toBe(giftWrap.id);
    });
  });

  describe("clear", () => {
    it("should clear received and unread but not seen", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      const receivedBefore = await inviteManager.getReceived();
      expect(receivedBefore).toHaveLength(1);

      await inviteManager.clear();

      const receivedAfter = await inviteManager.getReceived();
      const unreadAfter = await inviteManager.getUnread();

      expect(receivedAfter).toHaveLength(0);
      expect(unreadAfter).toHaveLength(0);

      // Seen index should NOT be cleared
      const seenIds = await getSeenIds(store);
      expect(seenIds).toContain(giftWrap.id);
    });
  });

  describe("clearSeen", () => {
    it("should clear the seen index", async () => {
      const pubkey = await account.signer.getPublicKey();
      const giftWrap = createMockGiftWrap("test-id-1", pubkey);

      await inviteManager.ingestEvent(giftWrap);

      const seenBefore = await getSeenIds(store);
      expect(seenBefore).toContain(giftWrap.id);

      await inviteManager.clearSeen();

      const seenAfter = await getSeenIds(store);
      expect(seenAfter).toHaveLength(0);
    });
  });
});
