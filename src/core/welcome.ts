import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { NostrEvent } from "applesauce-core/helpers/event";
import { getEventHash } from "nostr-tools";
import { decodeWelcome, encodeWelcome, type Welcome } from "ts-mls/welcome.js";
import {
  decodeContent,
  encodeContent,
  getEncodingTag,
} from "../utils/encoding.js";
import { unixNow } from "../utils/nostr.js";
import { WELCOME_EVENT_KIND } from "./protocol.js";

/**
 * Creates a welcome rumor (kind 444) for a welcome message.
 *
 * @param welcomeMessage - The MLS welcome message
 * @param keyPackageEventId - The ID of the key package event used for the add operation
 * @param author - The author's public key (hex string)
 * @param groupRelays - Array of relay URLs for the group
 * @returns Welcome rumor with precomputed ID
 */
export function createWelcomeRumor({
  welcome,
  author,
  groupRelays,
  keyPackageEventId,
}: {
  welcome: Welcome;
  author: string;
  keyPackageEventId?: string;
  groupRelays: string[];
}): Rumor {
  // Serialize the welcome message according to RFC 9420
  const serializedWelcome = encodeWelcome(welcome);
  const content = encodeContent(serializedWelcome, "base64");

  const draft = {
    kind: WELCOME_EVENT_KIND,
    pubkey: author,
    created_at: unixNow(),
    content,
    tags: [
      ["relays", ...groupRelays],
      ["encoding", "base64"],
    ],
  };

  // Add the key package event ID if known
  if (keyPackageEventId) draft.tags.push(["e", keyPackageEventId]);

  // Calculate the event ID for the rumor
  const id = getEventHash(draft);

  return {
    ...draft,
    id,
  };
}

/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export function getWelcome(event: NostrEvent): Welcome {
  if (event.kind !== WELCOME_EVENT_KIND) {
    throw new Error(
      `Expected welcome event kind ${WELCOME_EVENT_KIND}, got ${event.kind}`,
    );
  }
  // Check for encoding tag, default to hex for backward compatibility
  const encodingFormat = getEncodingTag(event) ?? "hex";
  const content = decodeContent(event.content, encodingFormat);
  const welcome = decodeWelcome(content, 0);
  if (!welcome) throw new Error("Failed to decode welcome message");

  return welcome[0];
}
