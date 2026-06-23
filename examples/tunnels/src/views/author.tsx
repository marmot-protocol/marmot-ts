import type { FC } from "hono/jsx";

import { colorForPubkey } from "../helpers/format.js";

/**
 * A user's display name with a colored underline derived from the first 6 hex
 * chars of their pubkey ({@link colorForPubkey}). The underline makes the same
 * person visually recognizable across the app even when display names collide,
 * are missing, or change.
 */
export const Author: FC<{
  pubkey: string;
  nameFor: (pubkey: string) => string;
  /** Wrapper class — defaults to the shared `who` name styling. */
  class?: string;
}> = ({ pubkey, nameFor, class: className = "who" }) => (
  <span
    class={className}
    style={`text-decoration-color: ${colorForPubkey(pubkey)}`}
  >
    {nameFor(pubkey)}
  </span>
);
