import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { logger } from "../../utils/debug.js";
import { normalizeRelayUrl } from "../../utils/relay-url.js";
import type { GroupMetaStore } from "./database/group-batch.js";
import type { GroupMetaKey } from "./database/types.js";

import { groupKeys } from "./storage-keys.js";

const log = logger.extend("GroupBackfill");

/**
 * Events dated further than this into the future never advance the cursor
 * (seconds). A single skewed or hostile `created_at` must not push the cursor
 * past events that have not been published yet.
 */
export const BACKFILL_FUTURE_SKEW_SECONDS = 5 * 60;
const CURSOR_FORMAT_VERSION = 1;

/**
 * Key segment for a relay: its normalised URL (so `wss://r` and `wss://r/`
 * share records), hashed so arbitrary URLs make well-formed keys.
 */
function relayKey(relay: string): string {
  let url = relay;
  try {
    url = normalizeRelayUrl(relay);
  } catch {
    // Not a parseable URL: key it as given.
  }
  return bytesToHex(sha256(utf8ToBytes(url)));
}

/**
 * Group-database meta key of a relay's backfill cursor (one record per group
 * relay), removed with the rest of the group's database.
 */
export function backfillCursorKey(relay: string): GroupMetaKey {
  return groupKeys.backfillCursor(relayKey(relay));
}

/** Encodes a cursor (unix seconds) as a version byte + big-endian uint32. */
export function encodeBackfillCursor(createdAt: number): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = CURSOR_FORMAT_VERSION;
  new DataView(bytes.buffer).setUint32(1, createdAt);
  return bytes;
}

/** Decodes a stored cursor; returns `undefined` for missing or malformed bytes. */
export function decodeBackfillCursor(
  bytes: Uint8Array | null | undefined,
): number | undefined {
  if (!bytes || bytes.length !== 5 || bytes[0] !== CURSOR_FORMAT_VERSION)
    return undefined;
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(1);
}

/**
 * Reads a relay's backfill cursor for a group. A malformed cursor, or one
 * dated implausibly far in the future, is ignored so the caller falls back to
 * a full (paged) backfill of that relay rather than skipping history.
 */
export async function readBackfillCursor(
  store: GroupMetaStore,
  relay: string,
  nowSeconds: number,
): Promise<number | undefined> {
  const cursor = decodeBackfillCursor(
    await store.get(backfillCursorKey(relay)),
  );
  if (cursor === undefined) return undefined;
  if (cursor > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS) {
    log("ignoring future-dated cursor %d for relay %s", cursor, relay);
    return undefined;
  }
  return cursor;
}

/**
 * Key of a relay's resumable paging progress for a group (bounded: one record
 * per group relay). Lives under the group's ingest-state prefix, like the
 * cursor.
 */
export function backfillProgressKey(relay: string): GroupMetaKey {
  return groupKeys.backfillProgress(relayKey(relay));
}

/**
 * Resumable paging progress of one relay: every event the relay held dated in
 * `[from, to]` (inclusive, whole seconds) was fetched and durably ingested by an earlier,
 * page-capped backfill. Recorded only while that relay's backfill is
 * incomplete, and removed once a backfill of the relay completes.
 */
export interface BackfillProgress {
  from: number;
  to: number;
}

/** Encodes progress as a version byte + two big-endian uint32s. */
export function encodeBackfillProgress(progress: BackfillProgress): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes[0] = CURSOR_FORMAT_VERSION;
  const view = new DataView(bytes.buffer);
  view.setUint32(1, progress.from);
  view.setUint32(5, progress.to);
  return bytes;
}

/** Decodes stored progress; `undefined` for missing or malformed bytes. */
export function decodeBackfillProgress(
  bytes: Uint8Array | null | undefined,
): BackfillProgress | undefined {
  if (!bytes || bytes.length !== 9 || bytes[0] !== CURSOR_FORMAT_VERSION)
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const progress = { from: view.getUint32(1), to: view.getUint32(5) };
  return progress.from <= progress.to ? progress : undefined;
}

/**
 * Reads a relay's stored paging progress for a group. Malformed progress, or
 * progress dated implausibly far in the future, is ignored (the relay is then
 * paged from its newest event as usual).
 */
export async function readBackfillProgress(
  store: GroupMetaStore,
  relay: string,
  nowSeconds: number,
): Promise<BackfillProgress | undefined> {
  const progress = decodeBackfillProgress(
    await store.get(backfillProgressKey(relay)),
  );
  if (!progress || progress.to > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS)
    return undefined;
  return progress;
}
