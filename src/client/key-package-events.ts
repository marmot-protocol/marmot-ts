/** @module @category Client - Key Package Manager */
import { NostrEvent } from "applesauce-core/helpers/event";

import { getKeyPackageIdentifier } from "../core/key-package-event.js";

/**
 * Computes the replaceable-event coordinate (`kind:pubkey:d`) for a kind-30443
 * key package event, or `undefined` when the event carries no slot identifier.
 */
export function getReplaceableEventKey(event: NostrEvent): string | undefined {
  const identifier = getKeyPackageIdentifier(event);
  if (identifier === undefined) return undefined;

  return `${event.kind}:${event.pubkey}:${identifier}`;
}

/**
 * Deduplicates a list of published kind-30443 events.
 *
 * Drops exact duplicate event ids, then collapses replaceable events that share
 * the same `kind:pubkey:d` coordinate down to the newest by `created_at`.
 * Non-addressable events (no slot identifier) are kept as-is.
 */
export function deduplicatePublishedEvents(events: NostrEvent[]): NostrEvent[] {
  const seenIds = new Set<string>();
  const replaceableIndexes = new Map<string, number>();
  const deduplicated: NostrEvent[] = [];

  for (const event of events) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);

    const replaceableKey = getReplaceableEventKey(event);
    if (replaceableKey === undefined) {
      deduplicated.push(event);
      continue;
    }

    const existingIndex = replaceableIndexes.get(replaceableKey);
    if (existingIndex === undefined) {
      replaceableIndexes.set(replaceableKey, deduplicated.length);
      deduplicated.push(event);
      continue;
    }

    const existing = deduplicated[existingIndex];
    if (event.created_at > existing.created_at) {
      deduplicated[existingIndex] = event;
    }
  }

  return deduplicated;
}
