import { logger } from "../../utils/debug.js";
import { normalizeRelayUrl } from "../../utils/relay-url.js";
import type {
  BackfillRow,
  GroupReader,
  MarmotGroupDatabase,
} from "./database/types.js";

const log = logger.extend("GroupBackfill");

/**
 * Events dated further than this into the future never advance the cursor
 * (seconds). A single skewed or hostile `created_at` must not push the cursor
 * past events that have not been published yet.
 */
export const BACKFILL_FUTURE_SKEW_SECONDS = 5 * 60;

/** Largest storable timestamp (unix seconds, uint32). */
const MAX_SECONDS = 0xffffffff;

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

const validSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= MAX_SECONDS;

/**
 * The `backfill` row key of a relay: its normalised URL, so `wss://r` and
 * `wss://r/` share a row. A URL that does not parse is keyed as given.
 */
export function backfillRelayKey(relay: string): string {
  try {
    return normalizeRelayUrl(relay);
  } catch {
    return relay;
  }
}

/**
 * Reads a relay's backfill cursor for a group. A malformed cursor, or one
 * dated implausibly far in the future, is ignored so the caller falls back to
 * a full (paged) backfill of that relay rather than skipping history.
 */
export async function readBackfillCursor(
  db: Pick<GroupReader, "backfill">,
  relay: string,
  nowSeconds: number,
): Promise<number | undefined> {
  const cursor = (await db.backfill.get(backfillRelayKey(relay)))?.cursor;
  if (!validSeconds(cursor)) return undefined;
  if (cursor > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS) {
    log("ignoring future-dated cursor %d for relay %s", cursor, relay);
    return undefined;
  }
  return cursor;
}

/**
 * Reads a relay's stored paging progress for a group. Malformed progress, or
 * progress dated implausibly far in the future, is ignored (the relay is then
 * paged from its newest event as usual).
 */
export async function readBackfillProgress(
  db: Pick<GroupReader, "backfill">,
  relay: string,
  nowSeconds: number,
): Promise<BackfillProgress | undefined> {
  const progress = (await db.backfill.get(backfillRelayKey(relay)))?.progress;
  if (
    !progress ||
    typeof progress !== "object" ||
    !validSeconds(progress.from) ||
    !validSeconds(progress.to) ||
    progress.from > progress.to ||
    progress.to > nowSeconds + BACKFILL_FUTURE_SKEW_SECONDS
  )
    return undefined;
  return { from: progress.from, to: progress.to };
}

/** A change to one relay's backfill row: `null` removes a field, omitted keeps it. */
export interface BackfillUpdate {
  cursor?: number | null;
  progress?: BackfillProgress | null;
}

/**
 * Applies a change to a relay's backfill row in one transaction; the row is
 * deleted once it holds neither a cursor nor progress.
 */
export async function updateBackfillRecord(
  db: MarmotGroupDatabase,
  relay: string,
  update: BackfillUpdate,
): Promise<void> {
  if (update.cursor != null && !validSeconds(update.cursor))
    throw new Error("Invalid backfill cursor");
  if (
    update.progress != null &&
    (!validSeconds(update.progress.from) ||
      !validSeconds(update.progress.to) ||
      update.progress.from > update.progress.to)
  )
    throw new Error("Invalid backfill progress");
  const key = backfillRelayKey(relay);
  await db.transaction(async (tx) => {
    const row: BackfillRow = { ...(await tx.backfill.get(key)), relay: key };
    if (update.cursor === null) delete row.cursor;
    else if (update.cursor !== undefined) row.cursor = update.cursor;
    if (update.progress === null) delete row.progress;
    else if (update.progress !== undefined)
      row.progress = { from: update.progress.from, to: update.progress.to };
    if (row.cursor === undefined && row.progress === undefined)
      await tx.backfill.delete(key);
    else await tx.backfill.put(row);
  });
}
