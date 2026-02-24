import type { NostrEvent, UnsignedEvent } from "applesauce-core/helpers";
import { unixNow } from "applesauce-core/helpers";

export type Nip65RelayRole = "read" | "write";

export type Nip65RelayLists = {
  inboxes: string[];
  outboxes: string[];
};

export const NIP65_RELAY_LIST_KIND = 10002;

function normalizeRelayUrl(relay: string): string {
  const trimmed = relay.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://"))
    return trimmed;
  return `wss://${trimmed}`;
}

/**
 * Create a draft NIP-65 Relay List Metadata event (kind 10002).
 *
 * Tags use the NIP-65 shape:
 * - ["r", <relay>] for relays that are both read and write
 * - ["r", <relay>, "read"] for read-only
 * - ["r", <relay>, "write"] for write-only
 */
export function createNip65RelayListEvent(options: {
  pubkey: string;
  inboxes: string[];
  outboxes: string[];
  client?: string;
}): UnsignedEvent {
  const inboxes = options.inboxes.map(normalizeRelayUrl).filter(Boolean);
  const outboxes = options.outboxes.map(normalizeRelayUrl).filter(Boolean);

  const tags: string[][] = [];

  const inboxSet = new Set(inboxes);
  const outboxSet = new Set(outboxes);

  const allRelays = new Set<string>([...inboxSet, ...outboxSet]);
  for (const relay of allRelays) {
    const isRead = inboxSet.has(relay);
    const isWrite = outboxSet.has(relay);

    if (isRead && isWrite) tags.push(["r", relay]);
    else if (isRead) tags.push(["r", relay, "read"]);
    else if (isWrite) tags.push(["r", relay, "write"]);
  }
  if (options.client) tags.push(["client", options.client]);

  return {
    kind: NIP65_RELAY_LIST_KIND,
    pubkey: options.pubkey,
    created_at: unixNow(),
    tags,
    content: "",
  };
}

/** Extract inbox/outbox relays from a NIP-65 kind 10002 event. */
export function getNip65RelayLists(event: NostrEvent): Nip65RelayLists {
  const inboxes: string[] = [];
  const outboxes: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "r") continue;
    const relay = tag[1];
    if (!relay) continue;
    const role = tag[2] as Nip65RelayRole | undefined;
    if (role === "read") inboxes.push(relay);
    else if (role === "write") outboxes.push(relay);
    else {
      // If role is omitted, treat as both (common interpretation).
      inboxes.push(relay);
      outboxes.push(relay);
    }
  }

  return {
    inboxes: [...new Set(inboxes)],
    outboxes: [...new Set(outboxes)],
  };
}
