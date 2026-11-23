/** @module @category Storage */
import type {
  GroupRecord,
  GroupRecordUpdate,
  MessageQuery,
  MessageRow,
} from "./types.js";

/** Newest first, then id ascending. */
export function compareMessages(
  a: Pick<MessageRow, "createdAt" | "id">,
  b: Pick<MessageRow, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The indexable tag keys of a message: `"<name>:<value>"` for single-letter tags. */
export function indexTags(tags: readonly (readonly string[])[]): string[] {
  const keys = new Set<string>();
  for (const tag of tags)
    if (tag.length >= 2 && tag[0]!.length === 1)
      keys.add(`${tag[0]}:${tag[1]}`);
  return [...keys];
}

/** The index keys a {@link MessageQuery} tag clause accepts, one list per tag name. */
export function queryTagKeys(query: MessageQuery): string[][] {
  return Object.entries(query.tags ?? {}).map(([name, values]) =>
    values.map((value) => `${name}:${value}`),
  );
}

/** Whether a message satisfies a {@link MessageQuery} (ignoring `limit`). */
export function matchesMessageQuery(
  row: MessageRow,
  query: MessageQuery,
): boolean {
  if (query.ids && !query.ids.includes(row.id)) return false;
  if (query.kinds && !query.kinds.includes(row.kind)) return false;
  if (query.authors && !query.authors.includes(row.pubkey)) return false;
  if (query.since !== undefined && row.createdAt < query.since) return false;
  if (query.until !== undefined && row.createdAt > query.until) return false;
  if (query.tags) {
    const keys = new Set(indexTags(row.tags));
    for (const alternatives of queryTagKeys(query))
      if (!alternatives.some((key) => keys.has(key))) return false;
  }
  return true;
}

/** Applies a {@link GroupRecordUpdate}: `null` deletes, `undefined` keeps. */
export function applyGroupUpdate(
  record: GroupRecord,
  update: GroupRecordUpdate,
): GroupRecord {
  const next: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as GroupRecord;
}
