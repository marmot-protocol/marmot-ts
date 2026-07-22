/** @module @category Utilities */
import { NostrEvent } from "applesauce-core/helpers/event";

/** The cardinality rule for a required tag: exactly one value, or a non-empty deduplicated list. */
export type TagCardinality = "singleton" | "list";

/**
 * The #236 wire-boundary tag-cardinality table (`refs/marmot/transports/nostr.md`),
 * encoded as `(kind, tagName) -> "singleton" | "list"` data (D-10/D-11).
 *
 * This table is descriptive only — it does not itself validate anything; use
 * {@link getSingletonTagValue}/{@link getListTag} at each required-tag read site.
 */
export const TAG_CARDINALITY: Record<number, Record<string, TagCardinality>> = {
  // kind 445 group message
  445: {
    h: "singleton",
  },
  // kind 1059 welcome gift wrap
  1059: {
    p: "singleton",
  },
  // kind 444 welcome rumor
  444: {
    e: "singleton",
    relays: "list",
  },
  // kind 30443 KeyPackage
  30443: {
    d: "singleton",
    i: "singleton",
    mls_protocol_version: "singleton",
    mls_ciphersuite: "list",
    mls_extensions: "list",
    mls_proposals: "list",
    app_components: "list",
  },
};

/**
 * Strictly reads a required singleton tag: returns the value only when
 * exactly one tag named `name` exists on the event and it has exactly one
 * value slot. Rejects (returns `undefined`) when the tag is absent,
 * repeated, has no value, has extra values, or the value is empty (D-10/D-11).
 *
 * Never throws — malformed input is a typed reject, not an exception.
 *
 * @param event - The Nostr event to read the tag from
 * @param name - The tag name to look up
 * @returns The tag's single value, or `undefined` if the cardinality rule is violated
 */
export function getSingletonTagValue(
  event: NostrEvent,
  name: string,
): string | undefined {
  const matches = event.tags.filter((t) => t[0] === name);
  if (matches.length !== 1) return undefined;
  const tag = matches[0];
  if (tag.length !== 2) return undefined;
  const value = tag[1];
  if (!value) return undefined;
  return value;
}

/**
 * Strictly reads a required list tag: returns all values only when exactly
 * one tag named `name` exists on the event, it has at least one value, and
 * none of the values are empty or duplicated. Rejects (returns `undefined`)
 * when the tag is absent, repeated, empty, or contains duplicate values
 * (D-10/D-11).
 *
 * Never throws — malformed input is a typed reject, not an exception.
 *
 * @param event - The Nostr event to read the tag from
 * @param name - The tag name to look up
 * @returns The tag's values, or `undefined` if the cardinality rule is violated
 */
export function getListTag(
  event: NostrEvent,
  name: string,
): string[] | undefined {
  const matches = event.tags.filter((t) => t[0] === name);
  if (matches.length !== 1) return undefined;
  const values = matches[0].slice(1);
  if (values.length === 0) return undefined;
  if (values.some((v) => !v)) return undefined;
  if (new Set(values).size !== values.length) return undefined;
  return values;
}
