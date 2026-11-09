/** @module @category Client - Invite Manager */
import { watchCurrent } from "../utils/watch-current.js";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/factories";
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
import { getSingletonTagValue } from "../utils/tag-cardinality.js";
import type {
  NostrNetworkInterface,
  Unsubscribable,
} from "./nostr-interface.js";
import {
  defaultVerifyEvent,
  type RejectReason,
  safeVerifyEvent,
  type VerifyEventMethod,
} from "./verify.js";

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
  | {
      type: "received";
      giftwrap: ReceivedGiftWrap;
      /** Written before prompting; automatic listening never retries an attempt. */
      attempted?: boolean;
      /** Validated transition journal; survives a failed unread write or cleanup. */
      rumor?: UnreadInvite;
      /** Permanently invalid plaintext; only source cleanup remains. */
      invalid?: boolean;
    }
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

  /** Emitted when a received gift wrap is retired or permanently quarantined */
  processed: (inviteId: string) => void;

  /** Emitted when an event fails to decrypt or parse */
  error: (error: Error, eventId: string) => void;

  /**
   * Emitted when an inbound kind-1059 gift wrap is rejected at the trust
   * boundary — before it is stored or decrypted — for an invalid outer
   * signature (SEC-01) or a repeated/absent/empty required `p` tag
   * (WIRE-02). Client/manager scope: no group context applies here.
   */
  rejected: (event: NostrEvent, reason: RejectReason) => void;
};

export interface InviteManagerOptions {
  /** Signer for decrypting gift wraps */
  signer: EventSigner;

  /** Storage backend for invite entries */
  store: GenericKeyValueStore<StoredInviteEntry>;

  /** The nostr relay pool, used by {@link InviteManager.listen}. */
  network: NostrNetworkInterface;

  /**
   * Injectable Nostr event verifier gating the outer kind-1059 gift wrap
   * before it is stored or decrypted (SEC-01). Defaults to applesauce's
   * `verifyEvent`. `unlockGiftWrap` only verifies the inner seal — this gate
   * closes that gap by verifying the outer event itself.
   */
  verifyEvent?: VerifyEventMethod;
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
 * - `received:<eventId>` keys hold gift wraps and optional retry/transition state
 * - `unread:<rumorId>` keys hold decrypted welcome rumors
 */
export class InviteManager extends EventEmitter<InviteManagerEvents> {
  private signer: EventSigner;
  private store: GenericKeyValueStore<StoredInviteEntry>;
  private network: NostrNetworkInterface;
  private seenCache: Set<string> | null = null;
  // Snapshot invalidation is separate from the public, non-replayed delivery event.
  private readonly unreadRecovery = new EventEmitter<{ changed: () => void }>();
  // Serialize transitions and reads' acknowledgement within this manager. The
  // store interface has no compare-and-swap; sharing a store between managers
  // still requires external serialization.
  private processing: Promise<unknown> = Promise.resolve();
  /** The injectable event verifier gating the 1059 outer event (SEC-01). */
  readonly #verifyEvent: VerifyEventMethod;

  #log = logger.extend("InviteManager");

  constructor(options: InviteManagerOptions) {
    super();
    this.signer = options.signer;
    this.store = options.store;
    this.network = options.network;
    this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
  }

  /**
   * Subscribes for gift-wrapped invites (kind 1059) addressed to this account on
   * the given relays — the inbound counterpart the app would otherwise hand-wire.
   * Each new gift wrap is {@link ingestEvent | ingested} (de-duplicated) and then
   * {@link decryptGiftWraps | decrypted}, so `watchUnread` / the `decrypted` event
   * update on their own. Previously unattempted gift wraps are tried once on
   * start. Failed/interrupted attempts require an explicit decrypt call, even
   * after reconnect or restart; journaled transitions resume without prompting.
   * Call `.unsubscribe()` on the result to stop listening.
   *
   * `relays` should be the account's advertised kind-10050 inbox relays — where
   * inviters deliver Welcomes. Subscribing elsewhere silently misses invites.
   */
  async listen(relays: string[]): Promise<Unsubscribable> {
    const pubkey = await this.signer.getPublicKey();

    const handle = async (event: NostrEvent): Promise<void> => {
      try {
        const added = await this.ingestEvent(event);
        if (added)
          await this.serialize(() => this.processGiftWrap(event.id, true));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit("error", err, event.id);
      }
    };

    const sub = this.network
      .subscription(relays, { kinds: [kinds.GiftWrap], "#p": [pubkey] })
      .subscribe({ next: (event) => void handle(event) });

    // Decrypt anything already stored so the unread list is populated on start.
    void this.serialize(() => this.decryptStoredGiftWraps(true)).catch((err) =>
      this.#log("startup decrypt failed: %O", err),
    );

    return { unsubscribe: () => sub.unsubscribe() };
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

    // Trust boundary (SEC-01): verify the OUTER kind-1059 event before it is
    // stored or decrypted. `unlockGiftWrap` (called later, in
    // decryptGiftWrap) only verifies the inner seal — it never checks this
    // outer event's own id/signature, so this gate closes that gap.
    if (!safeVerifyEvent(this.#verifyEvent, event)) {
      this.emit("rejected", event, "invalid-signature");
      return false;
    }

    // Trust boundary (WIRE-02): the routing `p` tag must be a singleton
    // (#236 required-tag cardinality) before it is trusted or the event is
    // stored. Runs after the signature gate above (D-01 verify-before-trust).
    if (getSingletonTagValue(event, "p") === undefined) {
      this.emit("rejected", event, "tag-cardinality");
      return false;
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
   * - On success: journals the validated rumor, persists unread, then retires received.
   * - Signer/cancellation/storage failures emit 'error' and retain the source.
   * - Invalid decrypted payloads are retired (or quarantined until cleanup succeeds).
   *
   * This is an explicit retry, which may prompt the signer again. A journaled
   * rumor is resumed without prompting or emitting a duplicate 'decrypted' event.
   *
   * @param eventId - The gift wrap event ID to decrypt, or the gift wrap event itself
   * @returns A newly persisted unread rumor, or null on failure/already delivered
   * @throws Error if an event ID is not found in received storage
   */
  async decryptGiftWrap(
    eventId: string | ReceivedGiftWrap,
  ): Promise<UnreadInvite | null> {
    return this.serialize(async () => {
      // Object input must use the same durable, verified lifecycle as ID input.
      if (typeof eventId !== "string") await this.ingestEvent(eventId);
      const id = typeof eventId === "string" ? eventId : eventId.id;
      return this.processGiftWrap(id, false, typeof eventId === "string");
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.processing.then(operation);
    this.processing = result.catch(() => undefined);
    return result;
  }

  private async processGiftWrap(
    id: string,
    automatic: boolean,
    required = false,
  ): Promise<UnreadInvite | null> {
    const key = `${RECEIVED_PREFIX}${id}`;
    const stored = await this.store.getItem(key);
    if (stored?.type !== "received") {
      if (required) throw new Error(`Event ${id} not found in received store`);
      return null;
    }
    let entry = stored;
    const giftwrap = entry.giftwrap;
    const report = (error: unknown): void => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit("error", err, id);
    };

    try {
      if (entry.invalid) {
        await this.store.removeItem(key);
        return null;
      }
      if (!entry.rumor) {
        if (automatic && entry.attempted) return null;
        // Persist BEFORE touching the signer. A restart/reconnect must not turn
        // a declined prompt (or an interrupted attempt) into an automatic loop.
        entry = { ...entry, attempted: true };
        await this.store.setItem(key, entry);

        let rumor: UnreadInvite;
        let signerFailed = false;
        const nip44 = this.signer.nip44;
        if (!nip44) throw new Error("Signer does not support nip44 encryption");
        // Signers don't expose a common error taxonomy. Track the boundary,
        // not error strings: even malformed-ciphertext rejections are retained
        // for explicit retry, never automatically re-prompted.
        const signer: EventSigner = {
          ...this.signer,
          getPublicKey: () => this.signer.getPublicKey(),
          signEvent: (event) => this.signer.signEvent(event),
          nip44: {
            encrypt: (pubkey, plaintext) => nip44.encrypt(pubkey, plaintext),
            decrypt: async (pubkey, ciphertext) => {
              try {
                return await nip44.decrypt(pubkey, ciphertext);
              } catch (error) {
                signerFailed = true;
                throw error;
              }
            },
          },
        };
        try {
          rumor = await unlockGiftWrap(giftwrap, signer);
          if (rumor.kind !== WELCOME_EVENT_KIND) {
            throw new Error(
              `Expected kind ${WELCOME_EVENT_KIND} Welcome, got kind ${rumor.kind}`,
            );
          }
          getWelcome(rumor);
        } catch (error) {
          if (signerFailed) throw error;
          // Only failures AFTER successful signer calls are permanent payload
          // errors. Persist quarantine before attempting destructive cleanup.
          entry = { ...entry, invalid: true };
          await this.store.setItem(key, entry);
          report(error);
          this.emit("processed", id);
          await this.store.removeItem(key);
          return null;
        }

        entry = { ...entry, rumor };
        await this.store.setItem(key, entry);
      }
      const rumor = entry.rumor!;
      const unreadKey = `${UNREAD_PREFIX}${rumor.id}`;
      const existing = await this.store.getItem(unreadKey);
      const isNew = existing?.type !== "unread";
      if (isNew) {
        await this.store.setItem(unreadKey, { type: "unread", rumor });
        // Notify as soon as unread is durable, even if source cleanup fails.
        this.emit("decrypted", rumor);
      } else {
        // A previous write may have succeeded without acknowledging it. Refresh
        // active snapshots before cleanup, without replaying a delivery event.
        this.unreadRecovery.emit("changed");
      }

      try {
        await this.store.removeItem(key);
        this.emit("processed", giftwrap.id);
      } catch (error) {
        // Unread is already durable. Report cleanup separately without hiding
        // the successfully delivered invite from this call's result.
        report(error);
      }
      return isNew ? rumor : null;
    } catch (error) {
      report(error);
      return null;
    }
  }

  /**
   * Decrypts all received gift wraps.
   *
   * Attempts to decrypt and parse each received gift wrap.
   * - On success: moves to 'unread' state and emits 'decrypted'.
   * - On retryable failure: emits 'error' and retains received for explicit retry.
   *
   * This method prompts the user via signer for each decryption,
   * so it should be called deliberately by the app (not automatically).
   *
   * @returns Array of successfully decrypted welcome rumors
   */
  async decryptGiftWraps(): Promise<UnreadInvite[]> {
    return this.serialize(() => this.decryptStoredGiftWraps(false));
  }

  private async decryptStoredGiftWraps(
    automatic: boolean,
  ): Promise<UnreadInvite[]> {
    const allKeys = await this.store.keys();
    const receivedIds = allKeys
      .filter((k) => k.startsWith(RECEIVED_PREFIX))
      .map((k) => k.slice(RECEIVED_PREFIX.length));

    const newInvites: UnreadInvite[] = [];
    for (const id of receivedIds) {
      try {
        const rumor = await this.processGiftWrap(id, automatic);
        if (rumor) newInvites.push(rumor);
      } catch (error) {
        this.emit(
          "error",
          error instanceof Error ? error : new Error(String(error)),
          id,
        );
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
      if (entry?.type === "received" && !entry.invalid)
        invites.push(entry.giftwrap);
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
    return this.serialize(async () => {
      // A crash or failed source removal can leave both copies. Retire ALL
      // matching journals before acknowledging unread, or recovery could
      // resurrect an already-read invite. On failure unread remains available.
      for (const key of await this.store.keys()) {
        if (!key.startsWith(RECEIVED_PREFIX)) continue;
        const entry = await this.store.getItem(key);
        if (entry?.type === "received" && entry.rumor?.id === inviteId) {
          await this.store.removeItem(key);
          this.emit("processed", entry.giftwrap.id);
        }
      }
      await this.store.removeItem(`${UNREAD_PREFIX}${inviteId}`);
      this.emit("read", inviteId);
    });
  }

  /**
   * Watch for unread invites.
   *
   * Yields the current array of unread invites, then yields again
   * whenever the unread list changes or a recovery confirms persisted unread.
   *
   * This does NOT automatically mark invites as read - the app must
   * call markAsRead() after processing each invite.
   *
   * Pass an AbortSignal to stop watching. Abort, return, throw, and async
   * disposal release listeners and interrupt pending reads without another event.
   * Abandoned reads may finish internally; their results are ignored.
   */
  watchUnread(
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<UnreadInvite[]> {
    return watchCurrent({
      ...options,
      read: () => this.getUnread(),
      subscribe: (changed) => this.onUnreadChanged(changed),
    });
  }

  /**
   * Calls `changed` whenever the unread list may have changed.
   * Returns a function that removes the listeners.
   * @internal
   */
  onUnreadChanged(changed: () => void): () => void {
    this.on("decrypted", changed);
    this.on("read", changed);
    this.unreadRecovery.on("changed", changed);
    return () => {
      this.off("decrypted", changed);
      this.off("read", changed);
      this.unreadRecovery.off("changed", changed);
    };
  }

  /**
   * Watch for received (encrypted) invites.
   *
   * Yields the current list of received gift wraps, then yields again
   * whenever the received list changes (via 'received' or 'processed' events).
   *
   * Pass an AbortSignal to stop watching. Abort, return, throw, and async
   * disposal release listeners and interrupt pending reads without another event.
   * Abandoned reads may finish internally; their results are ignored.
   */
  watchReceived(
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ReceivedGiftWrap[]> {
    return watchCurrent({
      ...options,
      read: () => this.getReceived(),
      subscribe: (changed) => {
        this.on("received", changed);
        this.on("processed", changed);
        return () => {
          this.off("received", changed);
          this.off("processed", changed);
        };
      },
    });
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
