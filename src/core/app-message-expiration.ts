/** @module @category Core - Group Messages */
import type { ClientState } from "ts-mls";

import { getMessageRetention } from "./components/index.js";

const U64_MAX = (1n << 64n) - 1n;

/**
 * The transport expiry for an outbound application message
 * (`app-components/message-retention-v1.md`):
 * `checked_u64(app_payload.created_at + disappearing_message_secs)`, read from
 * the message's source-epoch state.
 *
 * Returns `undefined` — no expiry hint — when retention is absent or `0`, when
 * the payload has no readable integer `created_at`, when `created_at` is not
 * exactly representable as a JS number (the spec forbids computing through an
 * inexact JSON number), or when the sum exceeds `2^64 - 1`. In every such case
 * the message itself stays valid.
 *
 * @param state - The group state the message is encrypted under (source epoch)
 * @param payload - The serialized Marmot app payload
 */
export function getAppMessageExpiration(
  state: ClientState,
  payload: Uint8Array,
): bigint | undefined {
  const retention = getMessageRetention(state.groupContext.extensions);
  if (!retention) return undefined;

  let createdAt: unknown;
  try {
    createdAt = JSON.parse(new TextDecoder().decode(payload))?.created_at;
  } catch {
    return undefined;
  }
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0
  )
    return undefined;

  const expiry = BigInt(createdAt) + retention;
  return expiry <= U64_MAX ? expiry : undefined;
}
