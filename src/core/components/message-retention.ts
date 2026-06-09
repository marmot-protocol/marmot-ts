/** @module @category Core - App Components */
import { BinaryReader, BinaryWriter } from "../binary.js";

/**
 * Codec for `marmot.group.message-retention.v1` (`0x8005`) — the disappearing
 * message timer. Replaces the `disappearing_message_secs` field of the legacy
 * `marmot_group_data` monolith.
 *
 * Wire (Marmot binary profile):
 *   uint64 disappearing_message_secs;   // fixed 8-byte big-endian, NO length prefix
 *
 * A value of `0` disables disappearing messages.
 *
 * @see darkmatter `crates/marmot-app/src/groups.rs` `AppGroupMessageRetentionComponent`
 * @see Marmot v2 spec: `app-components/message-retention-v1.md`
 */

/** Encodes a disappearing-message timer (seconds) to component `data` bytes. */
export function encodeMessageRetentionV1(
  disappearingMessageSecs: number | bigint,
): Uint8Array {
  return new BinaryWriter().uint64(disappearingMessageSecs).build();
}

/** Decodes `marmot.group.message-retention.v1` component `data` bytes. */
export function decodeMessageRetentionV1(data: Uint8Array): bigint {
  const reader = new BinaryReader(data);
  const secs = reader.uint64();
  reader.end();
  return secs;
}
