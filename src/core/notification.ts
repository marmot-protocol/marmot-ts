/**
 * MIP-05: Push Notifications — core crypto helpers and rumor builders.
 *
 * Provides pure functions for:
 * - Constructing and encrypting 572-byte push notification tokens for all
 *   three MIP-05 platforms: APNs (0x01), FCM (0x02), and Web Push (0x03)
 * - Building unsigned kind:447 / kind:448 / kind:449 rumor structures
 * - Building the kind:446 notification trigger gift wrap (NIP-59)
 *
 * No network I/O, no state, no side effects.
 *
 * References
 * - MIP-05 spec: https://github.com/marmot-protocol/marmot/blob/master/05.md
 * - NIP-59 Gift Wrap: https://github.com/nostr-protocol/nips/blob/master/59.md
 * - RFC 8030 Web Push: https://www.rfc-editor.org/rfc/rfc8030
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import {
  extract as hkdf_extract,
  expand as hkdf_expand,
} from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { GiftWrapBlueprint } from "applesauce-common/blueprints/gift-wrap";
import { createEvent } from "applesauce-core/event-factory";
import { nip44 } from "applesauce-core/helpers/encryption";
import {
  getEventHash,
  type NostrEvent,
  type UnsignedEvent,
} from "applesauce-core/helpers/event";
import { base64 } from "@scure/base";

import {
  MIP05_APNS_TOKEN_SIZE,
  MIP05_ENCRYPTED_TOKEN_SIZE,
  MIP05_FCM_TOKEN_MAX_BYTES,
  MIP05_HKDF_INFO,
  MIP05_HKDF_SALT,
  MIP05_MAX_ENDPOINT_BYTES,
  MIP05_PADDED_PAYLOAD_SIZE,
  MIP05_PLATFORM_APNS,
  MIP05_PLATFORM_FCM,
  MIP05_PLATFORM_WEB_PUSH,
  MIP05_TOKEN_BATCH_LIMIT,
  NOTIFICATION_TRIGGER_KIND,
  TOKEN_LIST_RESPONSE_KIND,
  TOKEN_REMOVAL_KIND,
  TOKEN_REQUEST_KIND,
} from "./protocol.js";
import { unixNow } from "../utils/nostr.js";

// ---------------------------------------------------------------------------
// Types — subscriptions
// ---------------------------------------------------------------------------

/**
 * APNs (Apple Push Notification service) device subscription.
 *
 * The device token is the raw 32-byte binary token obtained from
 * `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
 */
export type ApnsSubscription = {
  type: "apns";
  /** 32-byte APNs device token (binary, NOT hex string) */
  deviceToken: Uint8Array;
};

/**
 * FCM (Firebase Cloud Messaging) device subscription.
 *
 * The registration token is the string returned by
 * `FirebaseMessaging.messaging().token` (or equivalent).
 */
export type FcmSubscription = {
  type: "fcm";
  /** FCM registration token (variable-length UTF-8 string, max ~509 bytes) */
  registrationToken: string;
};

/**
 * Web Push / RFC 8030 browser subscription.
 *
 * @example
 * ```ts
 * const sub = await registration.pushManager.subscribe({
 *   userVisibleOnly: true,
 *   applicationServerKey,
 * });
 * const json = sub.toJSON();
 * const subscription: WebPushSubscription = {
 *   type: "web-push",
 *   endpoint: json.endpoint!,
 *   p256dh: base64url.decode(json.keys!.p256dh),
 *   auth: base64url.decode(json.keys!.auth),
 * };
 * ```
 */
export type WebPushSubscription = {
  type: "web-push";
  /** RFC 8030 push endpoint URL (max 428 bytes UTF-8) */
  endpoint: string;
  /** Uncompressed P-256 public key from the browser (65 bytes) */
  p256dh: Uint8Array;
  /** 16-byte auth secret from the browser */
  auth: Uint8Array;
};

/** Union of all supported MIP-05 push subscription types */
export type PushSubscription =
  | ApnsSubscription
  | FcmSubscription
  | WebPushSubscription;

// ---------------------------------------------------------------------------
// Types — server configuration (per-platform discriminated union)
// ---------------------------------------------------------------------------

/** Fields shared by all notification server configurations */
type BaseNotificationServerConfig = {
  /** Hex-encoded Nostr public key of the notification server */
  pubkey: string;
  /** Inbox relay URLs from the server's kind:10050 `relay` tags */
  relays: string[];
};

/**
 * Server configuration for APNs notifications.
 * Derived from a kind:10050 event that does NOT include a `vapid` tag.
 */
export type ApnsServerConfig = BaseNotificationServerConfig & {
  platform: "apns";
};

/**
 * Server configuration for FCM notifications.
 * Derived from a kind:10050 event that does NOT include a `vapid` tag.
 */
export type FcmServerConfig = BaseNotificationServerConfig & {
  platform: "fcm";
};

/**
 * Server configuration for Web Push notifications.
 * Derived from a kind:10050 event that includes a `vapid` tag.
 * Clients MUST NOT attempt Web Push registration against a server without a `vapid` tag.
 */
export type WebPushServerConfig = BaseNotificationServerConfig & {
  platform: "web-push";
  /**
   * Base64url-encoded (no padding) uncompressed P-256 public key (87 chars).
   * Sourced from the `vapid` tag of the kind:10050 event.
   */
  vapidKey: string;
};

/**
 * Caller-resolved notification server configuration, derived from a kind:10050 event.
 *
 * The caller is responsible for fetching and validating the server's kind:10050
 * event and constructing the appropriate platform-specific config before
 * passing it to {@link NotificationManager} or any helper here.
 */
export type NotificationServerConfig =
  | ApnsServerConfig
  | FcmServerConfig
  | WebPushServerConfig;

// ---------------------------------------------------------------------------
// Types — token storage
// ---------------------------------------------------------------------------

/**
 * A 572-byte encrypted token blob ready to be stored and distributed.
 *
 * Layout: `ephemeral_pubkey (32) || nonce (12) || ciphertext (528)`
 * where ciphertext = ChaCha20-Poly1305(plaintext=512-byte-payload, tag=16 bytes).
 */
export type EncryptedToken = Uint8Array;

/**
 * A token entry stored locally per MLS leaf index.
 * One entry exists per active group member that has registered for notifications.
 */
export type TokenEntry = {
  /** The 572-byte encrypted token */
  encryptedToken: EncryptedToken;
  /** Hex-encoded Nostr public key of the notification server */
  serverPubkey: string;
  /** Relay hint for the notification server (first relay from NotificationServerConfig) */
  relayHint: string;
  /** MLS leaf index of the group member who owns this token */
  leafIndex: number;
  /** Unix timestamp (seconds) when this token was stored */
  addedAt: number;
  /** Platform identifier for this token (optional for backwards compatibility) */
  platform?: "apns" | "fcm" | "web-push";
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/**
 * Derives a 32-byte ChaCha20-Poly1305 encryption key from an ephemeral private
 * key and the server's Nostr public key using ECDH + HKDF-SHA256.
 *
 * HKDF-Extract: salt = "mip05-v1", IKM = x-only shared ECDH secret (32 bytes)
 * HKDF-Expand:  info = "mip05-token-encryption", length = 32
 */
function deriveTokenEncryptionKey(
  ephemeralPrivkey: Uint8Array,
  serverPubkeyHex: string,
): Uint8Array {
  // Nostr pubkeys are x-only (32 bytes hex). @noble/curves needs a 33-byte
  // compressed point for getSharedSecret, so we add the 0x02 prefix.
  const serverPubkeyBytes = hexToBytes(serverPubkeyHex);
  const compressedServerPubkey =
    serverPubkeyBytes.length === 32
      ? concatBytes(new Uint8Array([0x02]), serverPubkeyBytes)
      : serverPubkeyBytes;

  // ECDH returns a 33-byte compressed point; x-only is bytes [1..33]
  const sharedPoint = secp256k1.getSharedSecret(
    ephemeralPrivkey,
    compressedServerPubkey,
  );
  const sharedX = sharedPoint.slice(1); // 32 bytes

  const salt = enc.encode(MIP05_HKDF_SALT);
  const info = enc.encode(MIP05_HKDF_INFO);
  const prk = hkdf_extract(sha256, sharedX, salt);
  return hkdf_expand(sha256, prk, info, 32);
}

/**
 * Encrypts a 512-byte payload into a 572-byte token using a fresh ephemeral
 * secp256k1 keypair, ECDH + HKDF-SHA256 key derivation, and ChaCha20-Poly1305.
 *
 * Output layout: `ephemeral_pubkey (32) || nonce (12) || ciphertext (512 + 16 tag) = 572 bytes`
 */
function encryptPayload(
  payload: Uint8Array,
  serverPubkeyHex: string,
): EncryptedToken {
  const ephemeralPrivkey = secp256k1.utils.randomSecretKey();
  const ephemeralPubkey = secp256k1.getPublicKey(ephemeralPrivkey, true);
  const ephemeralPubkeyXOnly = ephemeralPubkey.slice(1); // 32 bytes

  const encryptionKey = deriveTokenEncryptionKey(
    ephemeralPrivkey,
    serverPubkeyHex,
  );
  const nonce = randomBytes(12);

  const cipher = chacha20poly1305(encryptionKey, nonce);
  const ciphertext = cipher.encrypt(payload); // 512 + 16 = 528 bytes

  const token = concatBytes(ephemeralPubkeyXOnly, nonce, ciphertext);

  if (token.length !== MIP05_ENCRYPTED_TOKEN_SIZE) {
    throw new Error(
      `Encrypted token size mismatch: expected ${MIP05_ENCRYPTED_TOKEN_SIZE}, got ${token.length}`,
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Platform-specific payload builders
// ---------------------------------------------------------------------------

/**
 * Builds the 512-byte padded APNs payload.
 *
 * Layout:
 *   platform_byte (1) || token_length (2, BE uint16) || device_token (32) || random_padding
 */
function buildApnsPayload(subscription: ApnsSubscription): Uint8Array {
  if (subscription.deviceToken.length !== MIP05_APNS_TOKEN_SIZE) {
    throw new Error(
      `APNs device token must be ${MIP05_APNS_TOKEN_SIZE} bytes, got ${subscription.deviceToken.length}`,
    );
  }

  const payload = new Uint8Array(MIP05_PADDED_PAYLOAD_SIZE);
  let offset = 0;

  payload[offset++] = MIP05_PLATFORM_APNS; // 0x01

  // token_length as big-endian uint16
  const tokenLen = subscription.deviceToken.length;
  payload[offset++] = (tokenLen >> 8) & 0xff;
  payload[offset++] = tokenLen & 0xff;

  payload.set(subscription.deviceToken, offset);
  offset += tokenLen;

  // Random padding fills the remainder
  payload.set(randomBytes(MIP05_PADDED_PAYLOAD_SIZE - offset), offset);

  return payload;
}

/**
 * Builds the 512-byte padded FCM payload.
 *
 * Layout:
 *   platform_byte (1) || token_length (2, BE uint16) || registration_token (variable) || random_padding
 */
function buildFcmPayload(subscription: FcmSubscription): Uint8Array {
  const tokenBytes = enc.encode(subscription.registrationToken);
  if (tokenBytes.length > MIP05_FCM_TOKEN_MAX_BYTES) {
    throw new Error(
      `FCM registration token exceeds ${MIP05_FCM_TOKEN_MAX_BYTES} bytes (got ${tokenBytes.length})`,
    );
  }
  if (tokenBytes.length === 0) {
    throw new Error("FCM registration token must not be empty");
  }

  const payload = new Uint8Array(MIP05_PADDED_PAYLOAD_SIZE);
  let offset = 0;

  payload[offset++] = MIP05_PLATFORM_FCM; // 0x02

  const tokenLen = tokenBytes.length;
  payload[offset++] = (tokenLen >> 8) & 0xff;
  payload[offset++] = tokenLen & 0xff;

  payload.set(tokenBytes, offset);
  offset += tokenLen;

  payload.set(randomBytes(MIP05_PADDED_PAYLOAD_SIZE - offset), offset);

  return payload;
}

/**
 * Builds the 512-byte padded Web Push payload.
 *
 * Layout:
 *   platform_byte (1) || endpoint_length (2, BE uint16) || endpoint (variable)
 *   || p256dh (65) || auth (16) || random_padding
 */
function buildWebPushPayload(subscription: WebPushSubscription): Uint8Array {
  const endpointBytes = enc.encode(subscription.endpoint);
  if (endpointBytes.length > MIP05_MAX_ENDPOINT_BYTES) {
    throw new Error(
      `Web Push endpoint URL exceeds ${MIP05_MAX_ENDPOINT_BYTES} bytes (got ${endpointBytes.length})`,
    );
  }
  if (subscription.p256dh.length !== 65) {
    throw new Error(
      `p256dh must be 65 bytes (uncompressed P-256 point), got ${subscription.p256dh.length}`,
    );
  }
  if (subscription.auth.length !== 16) {
    throw new Error(`auth must be 16 bytes, got ${subscription.auth.length}`);
  }

  const payload = new Uint8Array(MIP05_PADDED_PAYLOAD_SIZE);
  let offset = 0;

  payload[offset++] = MIP05_PLATFORM_WEB_PUSH; // 0x03

  const endpointLen = endpointBytes.length;
  payload[offset++] = (endpointLen >> 8) & 0xff;
  payload[offset++] = endpointLen & 0xff;

  payload.set(endpointBytes, offset);
  offset += endpointBytes.length;

  payload.set(subscription.p256dh, offset);
  offset += 65;

  payload.set(subscription.auth, offset);
  offset += 16;

  payload.set(randomBytes(MIP05_PADDED_PAYLOAD_SIZE - offset), offset);

  return payload;
}

// ---------------------------------------------------------------------------
// Public API — token encryption
// ---------------------------------------------------------------------------

/**
 * Constructs and encrypts a 572-byte push notification token for any
 * supported MIP-05 platform (APNs, FCM, or Web Push).
 *
 * Dispatches to the appropriate payload builder based on `subscription.type`,
 * then encrypts using a fresh ephemeral secp256k1 keypair, ECDH + HKDF-SHA256
 * key derivation, and ChaCha20-Poly1305 AEAD with empty AAD.
 *
 * Output layout:
 *   `ephemeral_pubkey (32) || nonce (12) || ciphertext (512 + 16 tag) = 572 bytes`
 *
 * @param subscription - The platform-specific push subscription
 * @param serverPubkeyHex - The notification server's hex Nostr public key (from kind:10050)
 * @returns A 572-byte {@link EncryptedToken}
 */
export function encryptPushToken(
  subscription: PushSubscription,
  serverPubkeyHex: string,
): EncryptedToken {
  let payload: Uint8Array;

  switch (subscription.type) {
    case "apns":
      payload = buildApnsPayload(subscription);
      break;
    case "fcm":
      payload = buildFcmPayload(subscription);
      break;
    case "web-push":
      payload = buildWebPushPayload(subscription);
      break;
  }

  return encryptPayload(payload, serverPubkeyHex);
}

// ---------------------------------------------------------------------------
// Public API — rumor builders (all unsigned, per MIP-03)
// ---------------------------------------------------------------------------

/**
 * Builds an unsigned kind:447 Token Request rumor.
 *
 * Sent by a group member on join, token refresh, or periodic renewal.
 * Must be transmitted as an MLS Application Message inside a kind:445 event.
 *
 * @param pubkey - The sender's hex Nostr public key
 * @param encryptedToken - The 572-byte encrypted token
 * @param serverConfig - The resolved notification server configuration
 * @returns An unsigned Nostr event (rumor) with kind 447
 */
export function createTokenRequestRumor(
  pubkey: string,
  encryptedToken: EncryptedToken,
  serverConfig: NotificationServerConfig,
): Rumor {
  const relayHint = serverConfig.relays[0] ?? "";
  const tokenBase64 = base64.encode(encryptedToken);

  const rumor: Rumor = {
    id: "",
    kind: TOKEN_REQUEST_KIND,
    pubkey,
    created_at: unixNow(),
    content: "",
    tags: [["token", tokenBase64, serverConfig.pubkey, relayHint]],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * Builds an unsigned kind:448 Token List Response rumor.
 *
 * Any group member may respond to a kind:447 with their full token view.
 * Must be transmitted as an MLS Application Message inside a kind:445 event.
 *
 * The spec recommends a random 0–2 second delay before broadcasting, and
 * skipping if another member has already responded. That orchestration is
 * the caller's responsibility.
 *
 * @param pubkey - The sender's hex Nostr public key
 * @param tokens - All token entries to include in the response
 * @param replyToEventId - The event ID of the kind:447 being responded to
 * @returns An unsigned Nostr event (rumor) with kind 448
 */
export function createTokenListResponseRumor(
  pubkey: string,
  tokens: TokenEntry[],
  replyToEventId: string,
): Rumor {
  const tokenTags: string[][] = tokens.map((t) => [
    "token",
    base64.encode(t.encryptedToken),
    t.serverPubkey,
    t.relayHint,
    String(t.leafIndex),
  ]);

  const rumor: Rumor = {
    id: "",
    kind: TOKEN_LIST_RESPONSE_KIND,
    pubkey,
    created_at: unixNow(),
    content: "",
    tags: [...tokenTags, ["e", replyToEventId]],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * Builds an unsigned kind:449 Token Removal rumor.
 *
 * Sent when a member disables notifications or before leaving a group.
 * Receivers MUST remove the token for the MLS leaf identified by the sender.
 * Must be transmitted as an MLS Application Message inside a kind:445 event.
 *
 * @param pubkey - The sender's hex Nostr public key
 * @returns An unsigned Nostr event (rumor) with kind 449 and no tags
 */
export function createTokenRemovalRumor(pubkey: string): Rumor {
  const rumor: Rumor = {
    id: "",
    kind: TOKEN_REMOVAL_KIND,
    pubkey,
    created_at: unixNow(),
    content: "",
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

// ---------------------------------------------------------------------------
// Public API — notification trigger (gift wrap)
// ---------------------------------------------------------------------------

/**
 * Builds an unsigned kind:446 notification trigger rumor with a fresh
 * ephemeral pubkey. The content is base64-encoded concatenated tokens.
 *
 * Per MIP-05: the rumor pubkey is a random ephemeral key (not the sender's
 * identity key), preventing linkability.
 *
 * @param tokens - Up to {@link MIP05_TOKEN_BATCH_LIMIT} encrypted tokens
 * @returns An unsigned rumor (kind 446) with ephemeral pubkey
 * @throws If tokens is empty or exceeds the batch limit
 */
export function createNotificationTriggerRumor(
  tokens: EncryptedToken[],
): Rumor {
  if (tokens.length === 0) {
    throw new Error("Cannot create notification trigger with zero tokens");
  }
  if (tokens.length > MIP05_TOKEN_BATCH_LIMIT) {
    throw new Error(
      `Token batch exceeds limit: ${tokens.length} > ${MIP05_TOKEN_BATCH_LIMIT}`,
    );
  }

  const ephemeralPrivkey = secp256k1.utils.randomSecretKey();
  const ephemeralPubkeyBytes = secp256k1.getPublicKey(ephemeralPrivkey, true);
  const ephemeralPubkeyHex = bytesToHex(ephemeralPubkeyBytes.slice(1));

  const concatenated = concatBytes(...tokens);
  const contentBase64 = base64.encode(concatenated);

  const rumor: Rumor = {
    id: "",
    kind: NOTIFICATION_TRIGGER_KIND,
    pubkey: ephemeralPubkeyHex,
    created_at: unixNow(),
    content: contentBase64,
    tags: [],
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

/**
 * Builds a complete NIP-59 gift-wrapped kind:446 notification trigger event,
 * ready to publish to the server's inbox relays.
 *
 * Per MIP-05: the seal (kind:13) is signed by the SAME ephemeral key as the
 * rumor pubkey, and the outer gift wrap (kind:1059) is addressed to the server.
 *
 * Callers are responsible for:
 * - Batching tokens (≤{@link MIP05_TOKEN_BATCH_LIMIT} per call)
 * - Injecting decoys (~50% own token, 10–20% from other groups, min 3 decoys)
 * - Shuffling the token list before passing it here
 *
 * @param tokens - Pre-batched, pre-shuffled list of ≤50 encrypted tokens
 * @param serverConfig - The resolved notification server configuration
 * @returns A signed kind:1059 gift wrap event ready for publishing
 */
export async function createNotificationGiftWrap(
  tokens: EncryptedToken[],
  serverConfig: NotificationServerConfig,
): Promise<NostrEvent> {
  const rumor = createNotificationTriggerRumor(tokens);

  const sealPrivkey = secp256k1.utils.randomSecretKey();
  const sealPubkeyHex = bytesToHex(
    secp256k1.getPublicKey(sealPrivkey, true).slice(1),
  );

  const ephemeralSigner = {
    getPublicKey: async (): Promise<string> => sealPubkeyHex,
    signEvent: async (
      template:
        | UnsignedEvent
        | import("applesauce-core/helpers/event").EventTemplate,
    ): Promise<NostrEvent> => {
      const unsigned = template as NostrEvent;
      const id = getEventHash(unsigned);
      const sig = bytesToHex(schnorr.sign(hexToBytes(id), sealPrivkey));
      return { ...template, id, pubkey: sealPubkeyHex, sig } as NostrEvent;
    },
    nip44: {
      encrypt: (recipientPubkey: string, plaintext: string): string => {
        const conversationKey = nip44.getConversationKey(
          sealPrivkey,
          recipientPubkey,
        );
        return nip44.encrypt(plaintext, conversationKey);
      },
      decrypt: (senderPubkey: string, ciphertext: string): string => {
        const conversationKey = nip44.getConversationKey(
          sealPrivkey,
          senderPubkey,
        );
        return nip44.decrypt(ciphertext, conversationKey);
      },
    },
  };

  const giftWrap = await createEvent(
    { signer: ephemeralSigner },
    GiftWrapBlueprint,
    serverConfig.pubkey,
    rumor,
  );

  return giftWrap;
}
