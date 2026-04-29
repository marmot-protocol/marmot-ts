/** @module @category Utilities */

/**
 * Validates a relay URL to ensure it is a valid WebSocket URL.
 *
 * @param relay - Relay URL to validate
 * @returns True if the relay URL is valid, false otherwise
 */
export function isValidRelayUrl(relay: string): boolean {
  if (!URL.canParse(relay)) return false;

  try {
    const url = new URL(relay);
    return url.protocol === "wss:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

/** Normalizes a relay URL */
export function normalizeRelayUrl(relay: string): string {
  const url = new URL(relay);
  return url.toString();
}
