import { useMemo } from "react";

import { castUser, type Profile, type User } from "applesauce-common/casts";
import { use$ } from "applesauce-react/hooks";

import { useController } from "./use-marmot.js";

/**
 * The applesauce {@link User} cast for a pubkey, bound to the shared
 * {@link EventStore}. Cached globally by pubkey, so this is cheap to call from
 * many rows. Its observable properties (`profile$`, `outboxes$`, …) auto-load
 * the backing events through the store's loader the moment they're subscribed.
 */
export function useUser(pubkey: string): User {
  const store = useController().eventStore;
  return useMemo(() => castUser(pubkey, store), [store, pubkey]);
}

/**
 * Reactively resolve a pubkey's kind 0 {@link Profile}. Returns `undefined`
 * while the metadata is still loading (or if the user has none). Backed by
 * `castUser(...).profile$` + `use$`, so the component re-renders when the
 * profile arrives or is updated — no manual fetching or caching required.
 */
export function useProfile(pubkey: string): Profile | undefined {
  const store = useController().eventStore;
  return use$(() => castUser(pubkey, store).profile$, [store, pubkey]);
}

/**
 * A pubkey's best display name (`display_name` → `name`), falling back to the
 * supplied label (e.g. a short npub) while the profile is missing/loading.
 */
export function useDisplayName(pubkey: string, fallback = ""): string {
  const profile = useProfile(pubkey);
  return profile?.displayName || profile?.name || fallback;
}
