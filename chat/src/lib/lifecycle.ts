import { defined, mapEventsToStore } from "applesauce-core";
import { NostrEvent, relaySet } from "applesauce-core/helpers";
import { onlyEvents } from "applesauce-relay";
import {
  calculateKeyPackageRef,
  getKeyPackage,
  getKeyPackageRelayList,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_RELAY_LIST_KIND,
} from "marmot-ts";
import {
  combineLatest,
  defer,
  from,
  ignoreElements,
  map,
  merge,
  mergeAll,
  mergeMap,
  of,
  scan,
  shareReplay,
  switchMap,
} from "rxjs";
import { KeyPackage } from "ts-mls";

import { user$ } from "./accounts";
import { marmotClient$ } from "./marmot-client";
import { cacheRequest, eventStore, pool } from "./nostr";
import { extraRelays$ } from "./settings";

/** Observable of current user's key package relay list */
export const keyPackageRelays$ = combineLatest([user$, user$.outboxes$]).pipe(
  switchMap(([user, outboxes]) =>
    user
      ? user
          .replaceable(KEY_PACKAGE_RELAY_LIST_KIND, undefined, outboxes)
          .pipe(
            map((event) => (event ? getKeyPackageRelayList(event) : undefined)),
          )
      : of(undefined),
  ),
);

/** An observable of all relays to read key packages from */
const readKeyPackageRelays$ = combineLatest([
  user$.outboxes$,
  keyPackageRelays$,
  extraRelays$,
]).pipe(
  map((all) => relaySet(...all)),
  shareReplay(1),
);

export type PublishedKeyPackage = {
  event: NostrEvent;
  keyPackage: KeyPackage;
  keyPackageRef: Uint8Array;
};

export const publishedKeyPackages$ = combineLatest([
  user$,
  marmotClient$,
  readKeyPackageRelays$,
]).pipe(
  switchMap(([user, client]) => {
    if (!user) return of([] as PublishedKeyPackage[]);

    const filter = {
      kinds: [KEY_PACKAGE_KIND],
      authors: [user.pubkey],
    };

    // Observable to load events from relays
    const load = pool
      .subscription(readKeyPackageRelays$, filter)
      .pipe(onlyEvents());
    // Observable to load events from cache
    const cache = defer(() => cacheRequest(filter)).pipe(mergeAll());

    // Observable: all current matching events first, then live updates from the store.
    // eventStore.filters(filter) is shared with ReplaySubject(1), so late subscribers
    // only see the last event; seeding with getByFilters ensures we get the full set.
    const parseEvent = async (event: NostrEvent) => {
      try {
        const keyPackage = getKeyPackage(event);
        const keyPackageRef = await calculateKeyPackageRef(
          keyPackage,
          client?.cryptoProvider,
        );
        return { event, keyPackage, keyPackageRef } as PublishedKeyPackage;
      } catch {
        return null;
      }
    };
    const existing$ = defer(() =>
      from(eventStore.getByFilters(filter)).pipe(
        mergeMap((event) => from(parseEvent(event))),
        defined(),
      ),
    );
    const updates$ = eventStore.filters(filter).pipe(
      mergeMap((event) => from(parseEvent(event))),
      defined(),
    );
    const published = merge(existing$, updates$).pipe(
      scan((acc, curr) => {
        const seen = acc.some((p) => p.event.id === curr.event.id);
        return seen ? acc : [...acc, curr];
      }, [] as PublishedKeyPackage[]),
    );

    return merge(
      merge(load, cache).pipe(
        // Send all events to the store
        mapEventsToStore(eventStore),
        // Ingore events
        ignoreElements(),
      ),
      // Return only parsed events from the store
      published,
    );
  }),
  shareReplay(1),
);
