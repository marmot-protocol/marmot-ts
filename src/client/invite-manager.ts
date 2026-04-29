/** @module @category Client - Invite Manager */
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import {
  kinds,
  KnownEvent,
  type NostrEvent,
} from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { WELCOME_EVENT_KIND } from "../core/protocol.js";
import { getWelcome } from "../core/welcome.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import { logger } from "../utils/debug.js";

/** A received gift wrap event (kind 1059) that hasn't been decrypted yet */
export interface ReceivedGiftWrap extends KnownEvent<kinds.GiftWrap> {}

/**
 * A successfully decrypted Welcome rumor (kind 444).
 * All metadata can be derived from the rumor itself.
 */
export interface UnreadInvite extends Rumor {}

/**
 * Discriminated union for entries stored in the invite store.
 */
export type StoredInviteEntry =
  | { type: "seen"; ids: string[] }
  | { type: "received"; giftwrap: ReceivedGiftWrap }
  | { type: "unread"; rumor: UnreadInvite };

const SEEN_KEY = "__seen";
const RECEIVED_PREFIX = "received:";
const UNREAD_PREFIX = "unread:";

function isGiftWrap(event: NostrEvent): event is KnownEvent<kinds.GiftWrap> {
  return event.kind === kinds.GiftWrap;
}

/**
 * Events emitted by InviteManager
 */
export type InviteManagerEvents = {
  /** Emitted when a gift wrap is ingested and stored */
  received: (invite: ReceivedGiftWrap) => void;

  /** Emitted when an invite is successfully decrypted */
  decrypted: (invite: UnreadInvite) => void;

  /** Emitted when an invite is marked as read and removed */
  read: (inviteId: string) => void;

  /** Emitted when a received gift wrap is processed (decrypted or failed) */
  processed: (inviteId: string) => void;

  /** Emitted when an event fails to decrypt or parse */
  error: (error: Error, eventId: string) => void;
};

export interface InviteManagerOptions {
  /** Signer for decrypting gift wraps */
  signer: EventSigner;

  /** Storage backend for invite entries */
  store: GenericKeyValueStore<StoredInviteEntry>;
}

/**
 * InviteManager orchestrates the lifecycle of reading Welcome invites.
 *
 * It takes gift-wrapped events from the app, handles decryption/parsing,
 * persists invites to storage, and provides interfaces for consumption.
 *
 * The app is responsible for:
 * - Syncing events from relays
 * - Passing gift wrap events (kind 1059) to ingestEvent()
 * - Calling decryptGiftWraps() to decrypt (triggers nip-44 decryption prompts)
 * - Reading unread invites via getUnread(), watchUnread(), or event listeners
 * - Marking invites as read after processing
 *
 * State lifecycle:
 * 1. RECEIVED: Gift wrap ingested, stored, awaiting decryption
 * 2. UNREAD: Decrypted and parsed, ready for app consumption
 * 3. SEEN: Event ID tracked to prevent re-processing
 * 4. (DELETED): Read invites are removed from storage
 *
 * Store layout:
 * - `__seen` key holds a serialized set of all seen event IDs
 * - `received:<eventId>` keys hold undecrypted gift wraps
 * - `unread:<rumorId>` keys hold decrypted welcome rumors
 */
export class InviteManager extends EventEmitter<InviteManagerEvents> {
  private signer: EventSigner;
  private store: GenericKeyValueStore<StoredInviteEntry>;
  private seenCache: Set<string> | null = null;

  #log = logger.extend("InviteManager");

  constructor(options: InviteManagerOptions) {
    super();
    this.signer = options.signer;
    this.store = options.store;
  }

  /** Lazily load the seen set from store into memory */
  private async getSeenSet(): Promise<Set<string>> {
    if (this.seenCache) return this.seenCache;
    const entry = await this.store.getItem(SEEN_KEY);
    if (entry && entry.type === "seen") {
      this.seenCache = new Set(entry.ids);
    } else {
      this.seenCache = new Set();
    }
    return this.seenCache;
  }

  /** Persist the in-memory seen set to the store */
  private async persistSeen(): Promise<void> {
    const seen = await this.getSeenSet();
    await this.store.setItem(SEEN_KEY, { type: "seen", ids: [...seen] });
  }

  /**
   * Ingest a gift wrap event (kind 1059).
   *
   * The event is checked against the seen index for deduplication.
   * If new, it's stored in the 'received' state awaiting decryption.
   *
   * @param event - Gift wrap event (kind 1059)
   * @returns true if event was new and stored, false if already seen
   * @throws Error if event is not kind 1059
   */
  async ingestEvent(event: NostrEvent): Promise<boolean> {
    if (!isGiftWrap(event)) {
      throw new Error(`Expected kind 1059 gift wrap, got kind ${event.kind}`);
    }

    const seen = await this.getSeenSet();
    if (seen.has(event.id)) return false;

    this.#log("ingesting gift wrap %s", event.id);

    // Write data first (crash-safe ordering)
    await this.store.setItem(`${RECEIVED_PREFIX}${event.id}`, {
      type: "received",
      giftwrap: event,
    });

    // Then update seen index
    seen.add(event.id);
    await this.persistSeen();

    this.emit("received", event);
    return true;
  }

  /**
   * Ingest multiple gift wrap events in batch.
   *
   * @param events - Array of gift wrap events
   * @returns Count of new events stored
   */
  async ingestEvents(events: NostrEvent[]): Promise<number> {
    let newCount = 0;
    for (const event of events) {
      try {
        const isNew = await this.ingestEvent(event);
        if (isNew) newCount++;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit("error", err, event.id);
      }
    }
    return newCount;
  }

  /**
   * Process a single received (undecrypted) gift wrap by event ID.
   *
   * Attempts to decrypt and parse the specified event.
   * - On success: moves to 'unread' state and emits 'newInvite' event
   * - On failure: emits 'error' event (event remains in 'seen' to prevent retry)
   *
   * This method prompts the user via signer for decryption.
   *
   * @param eventId - The gift wrap event ID to decrypt, or the gift wrap event itself
   * @returns The decrypted welcome rumor, or null if failed to decrypt
   * @throws Error if the event is not found in received store
   */
  async decryptGiftWrap(
    eventId: string | ReceivedGiftWrap,
  ): Promise<UnreadInvite | null> {
    let giftwrap: ReceivedGiftWrap | null;
    if (typeof eventId === "string") {
      const entry = await this.store.getItem(`${RECEIVED_PREFIX}${eventId}`);
      giftwrap = entry?.type === "received" ? entry.giftwrap : null;
    } else {
      giftwrap = eventId;
    }

    if (!giftwrap) {
      throw new Error(`Event ${eventId} not found in received store`);
    }

    this.#log("decrypting gift wrap %s", giftwrap.id);
    try {
      const rumor = await unlockGiftWrap(giftwrap, this.signer);

      if (rumor.kind !== WELCOME_EVENT_KIND) {
        throw new Error(
          `Expected kind ${WELCOME_EVENT_KIND} Welcome, got kind ${rumor.kind}`,
        );
      }

      // Parse and validate the Welcome message
      getWelcome(rumor);

      this.#log("decrypted gift wrap %s → rumor %s", giftwrap.id, rumor.id);

      // Move to unread state
      await this.store.setItem(`${UNREAD_PREFIX}${rumor.id}`, {
        type: "unread",
        rumor,
      });
      await this.store.removeItem(`${RECEIVED_PREFIX}${giftwrap.id}`);
      this.emit("processed", giftwrap.id);

      this.emit("decrypted", rumor);
      return rumor;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err, giftwrap.id);

      // Remove from received (failed to process)
      await this.store.removeItem(`${RECEIVED_PREFIX}${giftwrap.id}`);
      this.emit("processed", giftwrap.id);

      return null;
    }
  }

  /**
   * Decrypts all received gift wraps.
   *
   * Attempts to decrypt and parse each received gift wrap.
   * - On success: moves to 'unread' state and emits 'newInvite' event
   * - On failure: emits 'error' event (event remains in 'seen' to prevent retry)
   *
   * This method prompts the user via signer for each decryption,
   * so it should be called deliberately by the app (not automatically).
   *
   * @returns Array of successfully decrypted welcome rumors
   */
  async decryptGiftWraps(): Promise<UnreadInvite[]> {
    const allKeys = await this.store.keys();
    const receivedIds = allKeys
      .filter((k) => k.startsWith(RECEIVED_PREFIX))
      .map((k) => k.slice(RECEIVED_PREFIX.length));

    const newInvites: UnreadInvite[] = [];
    for (const id of receivedIds) {
      try {
        const rumor = await this.decryptGiftWrap(id);
        if (rumor) newInvites.push(rumor);
      } catch (error) {
        // Event not found in received store (already processed by another call)
        continue;
      }
    }

    return newInvites;
  }

  /**
   * Get all unread invites.
   *
   * @returns Array of unread welcome rumors
   */
  async getUnread(): Promise<UnreadInvite[]> {
    const allKeys = await this.store.keys();
    const invites: UnreadInvite[] = [];

    for (const key of allKeys) {
      if (!key.startsWith(UNREAD_PREFIX)) continue;
      const entry = await this.store.getItem(key);
      if (entry?.type === "unread") invites.push(entry.rumor);
    }

    return invites;
  }

  /**
   * Get all received (encrypted) invites.
   *
   * @returns Array of received invites awaiting decryption
   */
  async getReceived(): Promise<ReceivedGiftWrap[]> {
    const allKeys = await this.store.keys();
    const invites: ReceivedGiftWrap[] = [];

    for (const key of allKeys) {
      if (!key.startsWith(RECEIVED_PREFIX)) continue;
      const entry = await this.store.getItem(key);
      if (entry?.type === "received") invites.push(entry.giftwrap);
    }

    return invites;
  }

  /**
   * Mark an invite as read and remove it from storage.
   *
   * Emits 'inviteRead' event after removal.
   *
   * @param inviteId - The rumor ID (from the welcome rumor)
   */
  async markAsRead(inviteId: string): Promise<void> {
    this.#log("marking invite %s as read", inviteId);
    await this.store.removeItem(`${UNREAD_PREFIX}${inviteId}`);
    this.emit("read", inviteId);
  }

  /**
   * Watch for unread invites.
   *
   * Yields the current array of unread invites, then yields again
   * whenever the unread list changes (via 'newInvite' or 'inviteRead' events).
   *
   * This does NOT automatically mark invites as read - the app must
   * call markAsRead() after processing each invite.
   */
  async *watchUnread(): AsyncGenerator<UnreadInvite[]> {
    yield await this.getUnread();

    while (true) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          resolve();
          this.off("decrypted", handler);
          this.off("read", handler);
        };
        this.once("decrypted", handler);
        this.once("read", handler);
      });
      yield await this.getUnread();
    }
  }

  /**
   * Watch for received (encrypted) invites.
   *
   * Yields the current list of received gift wraps, then yields again
   * whenever the received list changes (via 'ReceivedGiftWrap' or 'receivedProcessed' events).
   */
  async *watchReceived(): AsyncGenerator<ReceivedGiftWrap[]> {
    yield await this.getReceived();

    while (true) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          resolve();
          this.off("received", handler);
          this.off("processed", handler);
        };
        this.once("received", handler);
        this.once("processed", handler);
      });
      yield await this.getReceived();
    }
  }

  /**
   * Clear all stored invites (received and unread).
   *
   * Note: This does NOT clear the seen index to maintain deduplication history.
   * If you need to clear seen events, use clearSeen() or create a fresh store.
   */
  async clear(): Promise<void> {
    const allKeys = await this.store.keys();
    for (const key of allKeys) {
      if (key.startsWith(RECEIVED_PREFIX) || key.startsWith(UNREAD_PREFIX)) {
        await this.store.removeItem(key);
      }
    }
  }

  /**
   * Clear the seen event IDs.
   * Warning: This will allow previously processed events to be re-ingested.
   */
  async clearSeen(): Promise<void> {
    await this.store.removeItem(SEEN_KEY);
    this.seenCache = null;
  }
}
