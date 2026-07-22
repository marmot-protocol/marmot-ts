/** @module @category Core - Welcome */
import { isRumor, Rumor } from "applesauce-common/helpers/gift-wrap";
import { getEventHash } from "applesauce-core/helpers/event";
import {
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type MlsWelcomeMessage,
  protocolVersions,
  type Welcome,
  wireformats,
} from "ts-mls";
import { decodeContent, encodeContent } from "../utils/encoding.js";
import { unixNow } from "../utils/nostr.js";
import { getListTag, getSingletonTagValue } from "../utils/tag-cardinality.js";
import { WELCOME_EVENT_KIND } from "./protocol.js";

/** True when `value` is a 32-byte (64-char) lowercase-or-uppercase hex string. */
function isEventId(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Creates a welcome rumor (kind 444) for a welcome message.
 *
 * @returns Welcome rumor with precomputed ID
 */
export function createWelcomeRumor({
  welcome,
  author,
  groupRelays,
  keyPackageEventId,
}: {
  /** The MLS welcome message */
  welcome: Welcome;
  /** The author's public key (hex string) */
  author: string;
  /**
   * The ID of the KeyPackage event consumed for this add. Required: the spec
   * mandates a 32-byte-hex `e` tag on every welcome rumor
   * (transports/nostr.md "Welcome delivery").
   */
  keyPackageEventId: string;
  /** Array of relay URLs for the group (becomes the non-empty `relays` tag) */
  groupRelays: string[];
}): Rumor {
  if (!isEventId(keyPackageEventId))
    throw new Error(
      "Welcome rumor requires a 32-byte hex KeyPackage event id (e tag)",
    );
  if (groupRelays.length === 0 || groupRelays.some((r) => r.length === 0))
    throw new Error(
      "Welcome rumor requires a non-empty relays tag with no empty relay URLs",
    );
  // Serialize the welcome message as a full MLSMessage (RFC 9420)
  const mlsMessage: MlsWelcomeMessage = {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_welcome,
    welcome,
  };
  const serializedWelcome = encode(mlsMessageEncoder, mlsMessage);
  const content = encodeContent(serializedWelcome, "base64");

  // No `encoding` tag: the spec forbids it and content is always standard
  // base64 (transports/nostr.md "Transport byte encoding"). The `e` tag is
  // mandatory and validated above.
  const draft = {
    kind: WELCOME_EVENT_KIND,
    pubkey: author,
    created_at: unixNow(),
    content,
    tags: [
      ["relays", ...groupRelays],
      ["e", keyPackageEventId],
    ],
  };

  // Calculate the event ID for the rumor
  const id = getEventHash(draft);

  return {
    ...draft,
    id,
  };
}

/**
 * Returns the key package event ID from a welcome rumor. Strict (#236): a
 * repeated, missing, or empty-valued `e` tag yields `undefined` rather than
 * silently resolving to the first match (WIRE-02).
 */
export function getWelcomeKeyPackageEventId(event: Rumor): string | undefined {
  return getSingletonTagValue(event, "e");
}

/**
 * Returns the group relays from a welcome rumor. Strict (#236): a repeated
 * `relays` tag, an empty/absent one, or one carrying duplicate URLs yields
 * `[]` rather than silently resolving to the first match (WIRE-02).
 *
 * NOTE: The "relays" tag is a normal Nostr tag vector: ["relays", ...urls]
 * (see transports/nostr.md "Welcome delivery" and createWelcomeRumor()).
 */
export function getWelcomeGroupRelays(event: Rumor): string[] {
  return getListTag(event, "relays") ?? [];
}

/**
 * Returns the KeyPackageRefs of the intended recipients from a Welcome message.
 *
 * Each entry in `welcome.secrets` contains a plaintext `newMember` field which
 * is the RFC 9420 KeyPackageRef (a hash of the recipient's KeyPackage). No
 * decryption is required to read these.
 *
 * @param welcome - The MLS Welcome message
 * @returns Array of KeyPackageRefs (one per recipient)
 */
export function getWelcomeKeyPackageRefs(
  welcome: Welcome | Rumor,
): Uint8Array[] {
  // Unwrap welcome rumor if provided
  if (isRumor(welcome)) welcome = getWelcome(welcome);

  return welcome.secrets.map((s) => s.newMember);
}

/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export function getWelcome(event: Rumor): Welcome {
  if (event.kind !== WELCOME_EVENT_KIND)
    throw new Error(
      `Expected welcome event kind ${WELCOME_EVENT_KIND}, got ${event.kind}`,
    );

  // Validate the transport-level rumor shape the spec mandates before decoding
  // (transports/nostr.md "Welcome delivery"): a singleton 32-byte-hex `e` tag
  // and a singleton non-empty, non-duplicate `relays` tag (#236 strict
  // cardinality — WIRE-02). getSingletonTagValue/getListTag reject repeated,
  // empty, or duplicate-valued tags instead of first-match-resolving them.
  const keyPackageEventId = getSingletonTagValue(event, "e");
  if (!isEventId(keyPackageEventId))
    throw new Error(
      "Invalid welcome event: missing or malformed e tag (expected 32-byte hex KeyPackage event id)",
    );
  const relays = getWelcomeGroupRelays(event);
  if (relays.length === 0 || relays.some((r) => r.length === 0))
    throw new Error(
      "Invalid welcome event: relays tag must contain at least one non-empty relay URL",
    );

  // Content is always standard base64; the spec forbids an `encoding` tag.
  const content = decodeContent(event.content, "base64");
  const mlsMessage = decode(mlsMessageDecoder, content);
  if (!mlsMessage) throw new Error("Failed to decode welcome message");
  if (mlsMessage.wireformat !== wireformats.mls_welcome)
    throw new Error(
      `Expected MLSMessage with mls_welcome wireformat, got wireformat ${mlsMessage.wireformat}`,
    );

  return mlsMessage.welcome;
}
