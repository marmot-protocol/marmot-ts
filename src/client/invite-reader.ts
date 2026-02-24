import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core";
import {
  kinds,
  KnownEvent,
  type NostrEvent,
} from "applesauce-core/helpers/event";
import { EventEmitter } from "eventemitter3";
import { WELCOME_EVENT_KIND } from "../core/protocol.js";
import { getWelcome } from "../core/welcome.js";
import type {
  InviteStore,
  ReceivedGiftWrap,
  UnreadInvite,
} from "../store/invite-store.js";

function isGiftWrap(event: NostrEvent): event is KnownEvent<kinds.GiftWrap> {
  return event.kind === kinds.GiftWrap;
}

/**
 * Events emitted by InviteReader
 */
type InviteReaderEvents = {
  /** Emitted when a gift wrap is received and added to received store */
  ReceivedGiftWrap: (invite: ReceivedGiftWrap) => void;

  /** Emitted when a new invite is successfully decrypted and added to unread */
  newInvite: (invite: UnreadInvite) => void;

  /** Emitted when an invite is marked as read and removed from unread */
  inviteRead: (inviteId: string) => void;

  /** Emitted when a received invite is removed (decrypted or failed) */
  receivedProcessed: (inviteId: string) => void;

  /** Emitted when an event fails to decrypt or parse */
  error: (error: Error, eventId: string) => void;
};

export interface InviteReaderOptions {
  /** Signer for decrypting gift wraps */
  signer: EventSigner;

  /** Storage backend for invite states */
  store: InviteStore;
}

/**
 * InviteReader orchestrates the lifecycle of reading Welcome invites.
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
 * @example
 * ```typescript
 * const inviteReader = new InviteReader({
 *   signer: mySigner,
 *   store: myInviteStore,
 * });
 *
 * // 1. Ingest gift wraps from relay sync
 * await inviteReader.ingestEvents(giftWraps);
 *
 * // 2. Process received invites (prompts user for decryption)
 * await inviteReader.decryptGiftWraps();
 *
 * // 3. Consume unread invites
 * const unread = await inviteReader.getUnread();
 * for (const invite of unread) {
 *   await client.joinGroupFromWelcome({ welcomeRumor: invite });
 *   await inviteReader.markAsRead(invite.id);
 * }
 * ```
 */
export class InviteReader extends EventEmitter<InviteReaderEvents> {
  private signer: EventSigner;
  private store: InviteStore;

  constructor(options: InviteReaderOptions) {
    super();
    this.signer = options.signer;
    this.store = options.store;
  }

  /**
   * Ingest a gift wrap event (kind 1059).
   *
   * The event is checked against the 'seen' store for deduplication.
   * If new, it's stored in the 'received' state awaiting decryption.
   *
   * @param event - Gift wrap event (kind 1059)
   * @returns true if event was new and stored, false if already seen
   * @throws Error if event is not kind 1059
   */
  async ingestEvent(event: NostrEvent): Promise<boolean> {
    // Validate event kind
    if (!isGiftWrap(event))
      throw new Error(`Expected kind 1059 gift wrap, got kind ${event.kind}`);

    // Check if already seen
    const isSeen = await this.store.seen.getItem(event.id);
    if (isSeen) return false; // Skip duplicate

    // Mark as seen
    await this.store.seen.setItem(event.id, true);

    // Store in received state
    await this.store.received.setItem(event.id, event);
    this.emit("ReceivedGiftWrap", event);

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
        // Emit error for invalid events but continue processing
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
   * It can be used to decrypt individual invites in parallel with processReceived().
   *
   * @param eventId - The gift wrap event ID to decrypt
   * @returns The decrypted welcome rumor, or null if event not found or failed to decrypt
   * @throws Error if the event is not found in received store
   */
  async decryptGiftWrap(
    eventId: string | ReceivedGiftWrap,
  ): Promise<UnreadInvite | null> {
    const giftwrap =
      typeof eventId === "string"
        ? await this.store.received.getItem(eventId)
        : eventId;

    if (!giftwrap)
      throw new Error(`Event ${eventId} not found in received store`);

    try {
      // Decrypt gift wrap (prompts user)
      const rumor = await unlockGiftWrap(giftwrap, this.signer);

      // Validate it's a Welcome event (kind 444)
      if (rumor.kind !== WELCOME_EVENT_KIND) {
        throw new Error(
          `Expected kind ${WELCOME_EVENT_KIND} Welcome, got kind ${rumor.kind}`,
        );
      }

      // Parse and validate the Welcome message
      // This will throw if the Welcome is malformed
      getWelcome(rumor);

      // Move to unread state (store rumor directly using rumor ID as key)
      await this.store.unread.setItem(rumor.id, rumor);
      await this.store.received.removeItem(giftwrap.id);
      this.emit("receivedProcessed", giftwrap.id);

      this.emit("newInvite", rumor);
      return rumor;
    } catch (error) {
      // Emit error but don't retry (event stays in 'seen')
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err, giftwrap.id);

      // Remove from received (failed to process)
      await this.store.received.removeItem(giftwrap.id);
      this.emit("receivedProcessed", giftwrap.id);

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
    const receivedKeys = await this.store.received.keys();
    const newInvites: UnreadInvite[] = [];

    for (const key of receivedKeys) {
      try {
        const rumor = await this.decryptGiftWrap(key);
        if (rumor) newInvites.push(rumor);
      } catch (error) {
        // Event not found in received store (already processed by another call)
        // This is expected when processing in parallel, just skip
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
    const keys = await this.store.unread.keys();
    const invites: UnreadInvite[] = [];

    for (const key of keys) {
      const invite = await this.store.unread.getItem(key);
      if (invite) invites.push(invite);
    }

    return invites;
  }

  /**
   * Get all received (encrypted) invites.
   *
   * @returns Array of received invites awaiting decryption
   */
  async getReceived(): Promise<ReceivedGiftWrap[]> {
    const keys = await this.store.received.keys();
    const invites: ReceivedGiftWrap[] = [];

    for (const key of keys) {
      const invite = await this.store.received.getItem(key);
      if (invite) invites.push(invite);
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
    await this.store.unread.removeItem(inviteId);
    this.emit("inviteRead", inviteId);
  }

  /**
   * Watch for unread invites.
   *
   * Yields the current array of unread invites, then yields again
   * whenever the unread list changes (via 'newInvite' or 'inviteRead' events).
   *
   * This does NOT automatically mark invites as read - the app must
   * call markAsRead() after processing each invite.
   *
   * @example
   * ```typescript
   * for await (const invites of inviteReader.watchUnread()) {
   *   for (const invite of invites) {
   *     await client.joinGroupFromWelcome({ welcomeRumor: invite });
   *     await inviteReader.markAsRead(invite.id);
   *   }
   * }
   * ```
   */
  async *watchUnread(): AsyncGenerator<UnreadInvite[]> {
    // Yield initial state
    yield await this.getUnread();

    // Yield whenever unread list changes (new invite or invite read)
    while (true) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          resolve();
          this.off("newInvite", handler);
          this.off("inviteRead", handler);
        };
        this.once("newInvite", handler);
        this.once("inviteRead", handler);
      });
      yield await this.getUnread();
    }
  }

  /**
   * Watch for received (undecrypted) invites.
   *
   * Yields the current list of received gift wraps, then yields again
   * whenever the received list changes (via 'ReceivedGiftWrap' or 'receivedProcessed' events).
   *
   * Useful for showing a list of pending invites that need to be decrypted.
   *
   * @example
   * ```typescript
   * for await (const received of inviteReader.watchReceived()) {
   *   console.log(`${received.length} gift wraps waiting to decrypt`);
   *   // Show "Decrypt Invites" button if received.length > 0
   * }
   * ```
   */
  async *watchReceived(): AsyncGenerator<ReceivedGiftWrap[]> {
    // Yield initial state
    yield await this.getReceived();

    // Yield whenever received list changes (new gift wrap or processed)
    while (true) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          resolve();
          this.off("ReceivedGiftWrap", handler);
          this.off("receivedProcessed", handler);
        };
        this.once("ReceivedGiftWrap", handler);
        this.once("receivedProcessed", handler);
      });
      yield await this.getReceived();
    }
  }

  /**
   * Clear all stored invites.
   * Useful for testing or complete reset.
   *
   * Note: This does NOT clear the 'seen' store to maintain deduplication history.
   * If you need to clear seen events, use clearSeen() or create a fresh store.
   */
  async clear(): Promise<void> {
    await this.store.received.clear();
    await this.store.unread.clear();
  }

  /**
   * Clear the seen event IDs.
   * Warning: This will allow previously processed events to be re-ingested.
   */
  async clearSeen(): Promise<void> {
    await this.store.seen.clear();
  }
}
