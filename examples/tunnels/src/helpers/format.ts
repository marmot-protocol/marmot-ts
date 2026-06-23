import { npubEncode } from "applesauce-core/helpers/pointers";

/** Shorten a long hex/string id to `head…tail` for compact display. */
export function short(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Shorten a hex string id (alias of {@link short}). */
export function hexShort(value: string): string {
  return short(value);
}

/** Encode a pubkey as an npub and shorten it for display. */
export function npubShort(pubkey: string): string {
  try {
    return short(npubEncode(pubkey), 10, 6);
  } catch {
    return short(pubkey);
  }
}

/**
 * Derive a stable display color from a pubkey: `#` + its first 6 hex chars.
 * Pubkeys are 64-char lowercase hex, so this is always a valid CSS hex color.
 */
export function colorForPubkey(pubkey: string): string {
  return `#${pubkey.slice(0, 6)}`;
}

/** Format a unix-seconds timestamp as a local date-time string. */
export function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}
