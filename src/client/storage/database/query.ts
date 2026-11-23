/** @module @category Storage */
import type { Filter } from "applesauce-core/helpers/filter";
import type { GroupRecord, GroupRecordUpdate, MessageRow } from "./types.js";

/** Newest first, then id ascending. */
export function compareMessages(
  a: Pick<MessageRow, "createdAt" | "id">,
  b: Pick<MessageRow, "createdAt" | "id">,
): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** NIP-01 indexes single-letter tags (`a`–`z`, `A`–`Z`). */
const INDEXABLE_TAG = /^[a-zA-Z]$/;

/** The indexable tag keys of a message: `"<letter>:<value>"`, deduplicated. */
export function indexTags(tags: readonly (readonly string[])[]): string[] {
  const keys = new Set<string>();
  for (const tag of tags)
    if (tag.length >= 2 && INDEXABLE_TAG.test(tag[0]!))
      keys.add(`${tag[0]}:${tag[1]}`);
  return [...keys];
}

/**
 * A Nostr filter normalized for planning and matching message rows. Tag
 * clauses are expressed as {@link indexTags} keys.
 */
export interface MessageFilterPlan {
  /** False when no message can match (an empty `ids`, `kinds` or `authors`, `limit: 0`, …). */
  possible: boolean;
  ids?: readonly string[];
  kinds?: readonly number[];
  authors?: readonly string[];
  /** Inclusive lower bound on `createdAt`. */
  since?: number;
  /** Inclusive upper bound on `createdAt`. */
  until?: number;
  limit?: number;
  /** Tag keys every message must carry (NIP-91 `&` clauses). */
  allTags: string[];
  /** Tag clauses (`#`); a message must carry at least one key of each. */
  anyTags: string[][];
  /** Lowercased NIP-50 search text, matched as a substring of the content. */
  search?: string;
}

/**
 * Normalizes a NIP-01 filter for message rows, with the semantics of
 * applesauce's `matchFilter`: `&` (NIP-91) values must all be present, `#`
 * values also listed under `&` are dropped from the `#` clause, and a clause
 * left empty is ignored. Only single-letter tags are indexed, so a non-empty
 * clause on any other tag name matches nothing. Unlike `matchFilter`, a
 * `since` or `until` of `0` is a bound, and `search` (NIP-50) is a
 * case-insensitive substring match on the content. Unknown keys are ignored.
 */
export function compileMessageFilter(filter: Filter): MessageFilterPlan {
  const plan: MessageFilterPlan = { possible: true, allTags: [], anyTags: [] };
  const all = new Map<string, readonly string[]>();
  const any = new Map<string, readonly string[]>();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (key[0] === "&") all.set(key.slice(1), value as string[]);
    else if (key[0] === "#") any.set(key.slice(1), value as string[]);
  }
  for (const [name, values] of all) {
    if (!values.length) continue;
    if (!INDEXABLE_TAG.test(name)) plan.possible = false;
    for (const value of new Set(values)) plan.allTags.push(`${name}:${value}`);
  }
  for (const [name, values] of any) {
    const required = all.get(name) ?? [];
    const alternatives = [...new Set(values)].filter(
      (value) => !required.includes(value),
    );
    if (!alternatives.length) continue;
    if (!INDEXABLE_TAG.test(name)) plan.possible = false;
    plan.anyTags.push(alternatives.map((value) => `${name}:${value}`));
  }
  if (filter.ids) plan.ids = filter.ids;
  if (filter.kinds) plan.kinds = filter.kinds;
  if (filter.authors) plan.authors = filter.authors;
  if (filter.since !== undefined) plan.since = filter.since;
  if (filter.until !== undefined) plan.until = filter.until;
  if (filter.limit !== undefined) plan.limit = Math.max(0, filter.limit);
  if (filter.search) plan.search = filter.search.toLowerCase();
  if (
    plan.ids?.length === 0 ||
    plan.kinds?.length === 0 ||
    plan.authors?.length === 0 ||
    plan.limit === 0 ||
    (plan.since !== undefined &&
      plan.until !== undefined &&
      plan.since > plan.until)
  )
    plan.possible = false;
  return plan;
}

/** Whether a message satisfies a compiled filter (ignoring `limit`). */
export function matchesMessage(
  row: MessageRow,
  plan: MessageFilterPlan,
): boolean {
  if (!plan.possible) return false;
  if (plan.ids && !plan.ids.includes(row.id)) return false;
  if (plan.kinds && !plan.kinds.includes(row.kind)) return false;
  if (plan.authors && !plan.authors.includes(row.pubkey)) return false;
  if (plan.since !== undefined && row.createdAt < plan.since) return false;
  if (plan.until !== undefined && row.createdAt > plan.until) return false;
  if (plan.allTags.length || plan.anyTags.length) {
    const keys = new Set(indexTags(row.tags));
    if (!plan.allTags.every((key) => keys.has(key))) return false;
    for (const alternatives of plan.anyTags)
      if (!alternatives.some((key) => keys.has(key))) return false;
  }
  if (
    plan.search !== undefined &&
    !row.content.toLowerCase().includes(plan.search)
  )
    return false;
  return true;
}

/**
 * Answers a message filter over in-memory rows: matching rows, newest first
 * (then id ascending), truncated to `limit`. A reference implementation for
 * adapters that cannot index.
 */
export function selectMessages(
  rows: Iterable<MessageRow>,
  filter: Filter,
): MessageRow[] {
  const plan = compileMessageFilter(filter);
  if (!plan.possible) return [];
  const found: MessageRow[] = [];
  for (const row of rows) if (matchesMessage(row, plan)) found.push(row);
  found.sort(compareMessages);
  return plan.limit === undefined ? found : found.slice(0, plan.limit);
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
