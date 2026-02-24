import { Rumor } from "applesauce-common/helpers/gift-wrap";
import { getTagValue, NostrEvent } from "applesauce-core/helpers/event";
import { getEventHash } from "nostr-tools";
import { decode, encode } from "ts-mls";
import {
  welcomeDecoder,
  welcomeEncoder,
  type Welcome,
} from "ts-mls/welcome.js";
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
  keyPackageEvent?: NostrEvent;
  groupRelays: string[];
}): Rumor {
  // Serialize the welcome message according to RFC 9420
  const serializedWelcome = encode(welcomeEncoder, welcome);
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

/** Returns the key package event ID from a welcome rumor */
export function getWelcomeKeyPackageEventId(event: Rumor): string | undefined {
  return getTagValue(event, "e");
}

/** Returns the group relays from a welcome rumor */
export function getWelcomeGroupRelays(event: Rumor): string[] {
  // NOTE: The "relays" tag is a normal Nostr tag vector: ["relays", ...urls]
  // (see MIP-02 and createWelcomeRumor()).
  const tag = event.tags.find((t) => t[0] === "relays");
  if (!tag) return [];
  return tag.slice(1);
}

/**
 * Gets the Welcome message from a kind 444 event.
 *
 * @param event - The Nostr event containing the welcome message
 * @returns The decoded Welcome message
 * @throws Error if the content cannot be decoded
 */
export function getWelcome(event: NostrEvent | Rumor): Welcome {
  if (event.kind !== WELCOME_EVENT_KIND) {
    throw new Error(
      `Expected welcome event kind ${WELCOME_EVENT_KIND}, got ${event.kind}`,
    );
  }
  const encodingFormat = getEncodingTag(event);
  if (encodingFormat !== "base64") {
    throw new Error("Invalid welcome event: missing encoding=base64 tag");
  }
  const content = decodeContent(event.content, encodingFormat);
  const welcome = decode(welcomeDecoder, content);
  if (!welcome) throw new Error("Failed to decode welcome message");

  return welcome;
}
