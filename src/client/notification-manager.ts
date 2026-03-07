/**
 * MIP-05: Push Notifications — per-group NotificationManager.
 *
 * Manages the full push notification lifecycle for a single Marmot group,
 * supporting APNs (Apple), FCM (Google), and Web Push platforms:
 * - Registering this device's push token and broadcasting kind:447
 * - Processing incoming kind:447 / kind:448 / kind:449 rumors to maintain
 *   a local token store for all group members
 * - Sending kind:446 notification triggers after messages are sent
 * - Pruning expired tokens
 *
 * Designed to be instantiated per-group by MarmotGroup when a
 * {@link NotificationStoreBackend} is provided in the group options.
 */

import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { EventSigner } from "applesauce-core/event-factory";
import { EventEmitter } from "eventemitter3";

import {
  createNotificationGiftWrap,
  createTokenRemovalRumor,
  createTokenRequestRumor,
  type EncryptedToken,
  encryptPushToken,
  type NotificationServerConfig,
  type PushSubscription,
  type TokenEntry,
} from "../core/notification.js";
import {
  MIP05_TOKEN_BATCH_LIMIT,
  MIP05_TOKEN_MAX_AGE_DAYS,
  TOKEN_LIST_RESPONSE_KIND,
  TOKEN_REMOVAL_KIND,
  TOKEN_REQUEST_KIND,
} from "../core/protocol.js";
import type { KeyValueStoreBackend } from "../utils/key-value.js";
import type { NostrNetworkInterface } from "./nostr-interface.js";
import { logger } from "../utils/debug.js";
import { unixNow } from "../utils/nostr.js";
import { base64 } from "@scure/base";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Storage backend for token entries.
 * The key is the leaf index (as a decimal string).
 * Callers must provide a concrete implementation — no default is bundled.
 */
export type NotificationStoreBackend = KeyValueStoreBackend<TokenEntry>;

/** Options passed to the {@link NotificationManager} constructor */
export type NotificationManagerOptions = {
  /** The signer for the local user's identity */
  signer: EventSigner;
  /** The Nostr network interface for publishing events */
  network: NostrNetworkInterface;
  /** Persistent storage backend for token entries */
  backend: NotificationStoreBackend;
  /** The hex group ID, used for scoped debug logging */
  groupId: string;
};

/** Events emitted by {@link NotificationManager} */
export type NotificationManagerEvents = {
  /** Emitted when this device's token is stored after registration */
  tokenRegistered: [entry: TokenEntry];
  /** Emitted when a token for a leaf index is removed */
  tokenRemoved: [leafIndex: number];
  /** Emitted after expired tokens are pruned */
  tokensPruned: [count: number];
  /**
   * Emitted when a kind:447 Token Request is received from another member.
   * The caller may choose to respond with a kind:448 Token List Response
   * (with a random 0–2s delay as specified by MIP-05).
   */
  tokenRequested: [rumor: Rumor];
};

// ---------------------------------------------------------------------------
// NotificationManager
// ---------------------------------------------------------------------------

/**
 * Manages the MIP-05 Web Push notification lifecycle for a single Marmot group.
 *
 * Intended to be created by {@link MarmotGroup} and exposed as
 * `group.notifications`. The group passes incoming kind:447/448/449 rumors
 * from its ingest pipeline to {@link ingest}.
 *
 * @example
 * ```ts
 * // Register this device (Web Push)
 * const sub = await registration.pushManager.subscribe({ ... });
 * await group.notifications!.register(
 *   { type: "web-push", endpoint: sub.endpoint, p256dh: ..., auth: ... },
 *   { platform: "web-push", pubkey: serverPubkey, relays: [...], vapidKey: "..." },
 *   myLeafIndex,
 * );
 *
 * // Register this device (APNs)
 * await group.notifications!.register(
 *   { type: "apns", deviceToken: apnsTokenBytes },
 *   { platform: "apns", pubkey: serverPubkey, relays: [...] },
 *   myLeafIndex,
 * );
 *
 * // After sending a message
 * await group.notifications!.sendNotification(serverConfig);
 * ```
 */
export class NotificationManager extends EventEmitter<NotificationManagerEvents> {
  #log = logger.extend("NotificationManager");
  readonly #signer: EventSigner;
  readonly #network: NostrNetworkInterface;
  readonly #backend: NotificationStoreBackend;

  constructor(options: NotificationManagerOptions) {
    super();
    this.#signer = options.signer;
    this.#network = options.network;
    this.#backend = options.backend;
    this.#log = logger.extend(
      `NotificationManager:${options.groupId.slice(0, 8)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Registers this device for push notifications.
   *
   * Constructs and encrypts a push token for the given server and platform,
   * stores it locally under this device's MLS leaf index, and returns a
   * kind:447 Token Request rumor to be broadcast into the group.
   *
   * The returned rumor must be wrapped in a kind:445 group event and published
   * by the caller using {@link MarmotGroup.sendApplicationRumor}.
   *
   * @param subscription - The platform-specific push subscription (APNs, FCM, or Web Push)
   * @param serverConfig - The resolved notification server configuration
   * @param leafIndex - The caller's current MLS leaf index
   * @returns The kind:447 rumor to be sent as a group application message
   */
  async register(
    subscription: PushSubscription,
    serverConfig: NotificationServerConfig,
    leafIndex: number,
  ): Promise<Rumor> {
    this.#log(
      "registering for %s push notifications (leaf %d)",
      subscription.type,
      leafIndex,
    );

    const pubkey = await this.#signer.getPublicKey();
    const encryptedToken = encryptPushToken(subscription, serverConfig.pubkey);

    const entry: TokenEntry = {
      encryptedToken,
      serverPubkey: serverConfig.pubkey,
      relayHint: serverConfig.relays[0] ?? "",
      leafIndex,
      addedAt: unixNow(),
      platform: subscription.type,
    };

    await this.#backend.setItem(String(leafIndex), entry);
    this.emit("tokenRegistered", entry);
    this.#log("token stored for leaf %d", leafIndex);

    const rumor = createTokenRequestRumor(pubkey, encryptedToken, serverConfig);
    return rumor;
  }

  /**
   * Unregisters this device from push notifications.
   *
   * Removes the locally stored token for the given leaf index and returns a
   * kind:449 Token Removal rumor to be broadcast into the group.
   *
   * The returned rumor must be wrapped in a kind:445 group event and published
   * by the caller using {@link MarmotGroup.sendApplicationRumor}.
   *
   * @param leafIndex - The caller's current MLS leaf index
   * @returns The kind:449 rumor to be sent as a group application message
   */
  async unregister(leafIndex: number): Promise<Rumor> {
    this.#log("unregistering (leaf %d)", leafIndex);
    const pubkey = await this.#signer.getPublicKey();

    await this.#backend.removeItem(String(leafIndex));
    this.emit("tokenRemoved", leafIndex);

    return createTokenRemovalRumor(pubkey);
  }

  // ---------------------------------------------------------------------------
  // Ingest (called by MarmotGroup)
  // ---------------------------------------------------------------------------

  /**
   * Processes an incoming kind:447, kind:448, or kind:449 rumor.
   *
   * Called by {@link MarmotGroup} as part of its application message ingest
   * pipeline. Updates the local token store accordingly:
   *
   * - **kind:447** — stores the sender's token (keyed by leafIndex) and emits
   *   `tokenRequested` so the caller can decide whether to respond with kind:448
   * - **kind:448** — bulk-upserts all token entries from the response tags
   * - **kind:449** — removes the token for the sender's leaf index
   *
   * @param rumor - The decrypted, unsigned inner rumor from a kind:445 event
   * @param senderLeafIndex - The MLS leaf index of the rumor sender
   */
  async ingest(rumor: Rumor, senderLeafIndex: number): Promise<void> {
    this.#log("ingest kind:%d from leaf:%d", rumor.kind, senderLeafIndex);

    switch (rumor.kind) {
      case TOKEN_REQUEST_KIND:
        await this.#ingestTokenRequest(rumor, senderLeafIndex);
        break;
      case TOKEN_LIST_RESPONSE_KIND:
        await this.#ingestTokenListResponse(rumor);
        break;
      case TOKEN_REMOVAL_KIND:
        await this.#ingestTokenRemoval(senderLeafIndex);
        break;
      default:
        // Not a notification rumor — ignore
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Notification trigger
  // ---------------------------------------------------------------------------

  /**
   * Sends the notification trigger gift wrap(s) to the server.
   *
   * Collects all stored tokens, injects decoys, shuffles, batches at
   * ≤{@link MIP05_TOKEN_BATCH_LIMIT} tokens per kind:446, and publishes each
   * batch as a NIP-59 gift wrap to the server's inbox relays.
   *
   * Decoy strategy per MIP-05:
   * - ~50% chance to include this device's own token
   * - 10–20% of real token count from other groups (pass via `extraDecoys`)
   * - Minimum 3 decoys total
   *
   * @param serverConfig - The resolved notification server configuration
   * @param extraDecoys - Optional encrypted tokens from other groups for decoy injection
   */
  async sendNotification(
    serverConfig: NotificationServerConfig,
    extraDecoys: EncryptedToken[] = [],
  ): Promise<void> {
    const entries = await this.getTokens();
    if (entries.length === 0 && extraDecoys.length === 0) {
      this.#log("sendNotification: no tokens, skipping");
      return;
    }

    const realTokens = entries.map((e) => e.encryptedToken);

    // Decoy injection
    const decoys: EncryptedToken[] = [];

    // ~50% chance to include own token as decoy
    if (Math.random() < 0.5) {
      const ownEntry = entries[0];
      if (ownEntry) decoys.push(ownEntry.encryptedToken);
    }

    // 10–20% of real token count from other groups (min 3 total decoys)
    const otherGroupDecoyCount = Math.max(
      3 - decoys.length,
      Math.round(realTokens.length * (0.1 + Math.random() * 0.1)),
    );
    const shuffledExtra = [...extraDecoys].sort(() => Math.random() - 0.5);
    decoys.push(...shuffledExtra.slice(0, otherGroupDecoyCount));

    // Combine and shuffle
    const allTokens = [...realTokens, ...decoys].sort(
      () => Math.random() - 0.5,
    );

    if (allTokens.length === 0) {
      this.#log("sendNotification: after decoy injection still no tokens");
      return;
    }

    // Batch at ≤50 tokens per event
    const batches: EncryptedToken[][] = [];
    for (let i = 0; i < allTokens.length; i += MIP05_TOKEN_BATCH_LIMIT) {
      batches.push(allTokens.slice(i, i + MIP05_TOKEN_BATCH_LIMIT));
    }

    this.#log(
      "sendNotification: %d real tokens, %d decoys → %d batch(es)",
      realTokens.length,
      decoys.length,
      batches.length,
    );

    for (const batch of batches) {
      const giftWrap = await createNotificationGiftWrap(batch, serverConfig);
      await this.#network.publish(serverConfig.relays, giftWrap);
    }
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  /**
   * Returns all currently stored token entries.
   */
  async getTokens(): Promise<TokenEntry[]> {
    const keys = await this.#backend.keys();
    const entries: TokenEntry[] = [];
    for (const key of keys) {
      const entry = await this.#backend.getItem(key);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Removes tokens older than {@link MIP05_TOKEN_MAX_AGE_DAYS} days.
   *
   * @returns The number of tokens removed
   */
  async pruneExpiredTokens(): Promise<number> {
    const cutoff = unixNow() - MIP05_TOKEN_MAX_AGE_DAYS * 24 * 60 * 60;
    const keys = await this.#backend.keys();
    let pruned = 0;

    for (const key of keys) {
      const entry = await this.#backend.getItem(key);
      if (entry && entry.addedAt < cutoff) {
        await this.#backend.removeItem(key);
        this.emit("tokenRemoved", entry.leafIndex);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.#log("pruned %d expired token(s)", pruned);
      this.emit("tokensPruned", pruned);
    }

    return pruned;
  }

  /**
   * Watches the token store for changes.
   *
   * Yields the current snapshot immediately (snapshot-first), then re-yields
   * on every `tokenRegistered`, `tokenRemoved`, or `tokensPruned` event.
   */
  async *watchTokens(): AsyncGenerator<TokenEntry[]> {
    let resolveNext: (() => void) | null = null;
    let pending = false;

    const signal = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      } else {
        pending = true;
      }
    };

    this.on("tokenRegistered", signal);
    this.on("tokenRemoved", signal);
    this.on("tokensPruned", signal);

    try {
      yield await this.getTokens();

      while (true) {
        await new Promise<void>((resolve) => {
          if (pending) {
            pending = false;
            resolve();
          } else {
            resolveNext = resolve;
          }
        });
        yield await this.getTokens();
      }
    } finally {
      this.off("tokenRegistered", signal);
      this.off("tokenRemoved", signal);
      this.off("tokensPruned", signal);
    }
  }

  // ---------------------------------------------------------------------------
  // Private ingest handlers
  // ---------------------------------------------------------------------------

  async #ingestTokenRequest(
    rumor: Rumor,
    senderLeafIndex: number,
  ): Promise<void> {
    // Extract the token tag: ["token", base64Token, serverPubkey, relayHint]
    const tokenTag = rumor.tags.find((t) => t[0] === "token");
    if (!tokenTag || tokenTag.length < 4) {
      this.#log("kind:447 missing or malformed token tag — ignored");
      return;
    }

    const [, tokenBase64, serverPubkey, relayHint] = tokenTag;

    let encryptedToken: EncryptedToken;
    try {
      encryptedToken = base64.decode(tokenBase64);
    } catch {
      this.#log("kind:447 failed to decode token — ignored");
      return;
    }

    const entry: TokenEntry = {
      encryptedToken,
      serverPubkey,
      relayHint: relayHint ?? "",
      leafIndex: senderLeafIndex,
      addedAt: unixNow(),
    };

    await this.#backend.setItem(String(senderLeafIndex), entry);
    this.#log("kind:447 stored token for leaf %d", senderLeafIndex);

    // Emit so the caller can decide whether to respond with kind:448
    this.emit("tokenRequested", rumor);
  }

  async #ingestTokenListResponse(rumor: Rumor): Promise<void> {
    // Each token tag: ["token", base64Token, serverPubkey, relayHint, leafIndex]
    const tokenTags = rumor.tags.filter((t) => t[0] === "token");

    let upserted = 0;
    for (const tag of tokenTags) {
      if (tag.length < 5) continue;

      const [, tokenBase64, serverPubkey, relayHint, leafIndexStr] = tag;
      const leafIndex = parseInt(leafIndexStr, 10);
      if (isNaN(leafIndex)) continue;

      let encryptedToken: EncryptedToken;
      try {
        encryptedToken = base64.decode(tokenBase64);
      } catch {
        continue;
      }

      const entry: TokenEntry = {
        encryptedToken,
        serverPubkey,
        relayHint: relayHint ?? "",
        leafIndex,
        addedAt: unixNow(),
      };

      await this.#backend.setItem(String(leafIndex), entry);
      upserted++;
    }

    this.#log("kind:448 upserted %d token(s)", upserted);
  }

  async #ingestTokenRemoval(senderLeafIndex: number): Promise<void> {
    await this.#backend.removeItem(String(senderLeafIndex));
    this.emit("tokenRemoved", senderLeafIndex);
    this.#log("kind:449 removed token for leaf %d", senderLeafIndex);
  }
}
