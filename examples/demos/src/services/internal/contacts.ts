import type { EventStore } from "applesauce-core";
import { castUser } from "applesauce-common/casts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import {
  EMPTY,
  Observable,
  catchError,
  combineLatest,
  distinctUntilChanged,
  ignoreElements,
  map,
  merge,
  of,
  switchMap,
  tap,
} from "rxjs";
import { LOOKUP_RELAYS, LIVE_RELAYS } from "./relays.js";
import { DEMO_RELAY_URL } from "./relay/demo-relay.js";
import type { TransportMode } from "../mode.js";
import type { PeerTab } from "./peer-tabs.js";

/** Discover contacts and load their profiles into the session's event store. */
export function discoverContacts$(
  pubkey: string,
  network: NostrNetworkInterface,
  mode: TransportMode,
  store: EventStore,
  peers$: Observable<PeerTab[]>,
  report: (cause: unknown) => void,
) {
  const local = mode === "local";
  const relays = local ? [DEMO_RELAY_URL] : LIVE_RELAYS;
  const load$ = (relays: string[], filters: Filter) =>
    new Observable<NostrEvent>((observer) =>
      network.subscription(relays, filters).subscribe(observer),
    ).pipe(
      tap((event) => store.add(event)),
      catchError((cause: unknown) => {
        report(cause);
        return EMPTY;
      }),
      ignoreElements(),
    );
  const account = castUser(pubkey, store);
  const candidates$ = local
    ? peers$.pipe(
        map((peers) =>
          [...new Set(peers.map((peer) => peer.pubkey))]
            .filter((key) => key !== pubkey)
            .sort(),
        ),
        distinctUntilChanged((a, b) => a.join() === b.join()),
        map((keys) => keys.map((key) => castUser(key, store))),
      )
    : account.contacts$.pipe(map((contacts) => contacts ?? []));

  const contacts$ = candidates$.pipe(
    switchMap((users) =>
      merge(
        // A discovered publication is a candidate, not a validated usable package.
        users.length
          ? combineLatest(
              users.map((user) =>
                store
                  .timeline({
                    kinds: [30443],
                    authors: [user.pubkey],
                    limit: 1,
                  })
                  .pipe(
                    map((packages) => (packages.length ? user : undefined)),
                  ),
              ),
            ).pipe(map((users) => users.filter((user) => user !== undefined)))
          : of([]),
        ...users.map((user) =>
          merge(
            load$(local ? relays : LOOKUP_RELAYS, {
              kinds: [0, 10002],
              authors: [user.pubkey],
            }),
            user.outboxes$.pipe(
              map((outboxes) =>
                local ? relays : [...new Set([...(outboxes ?? []), ...relays])],
              ),
              distinctUntilChanged((a, b) => a.join() === b.join()),
              switchMap((relays) =>
                load$(relays, {
                  kinds: [30443],
                  authors: [user.pubkey],
                  limit: 1,
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  if (local) return contacts$;
  return merge(
    contacts$,
    load$(LOOKUP_RELAYS, { kinds: [10002], authors: [pubkey] }),
    account.outboxes$.pipe(
      map((outboxes) => (outboxes?.length ? outboxes : relays)),
      distinctUntilChanged((a, b) => a.join() === b.join()),
      switchMap((relays) =>
        load$(relays, { kinds: [3, 0], authors: [pubkey] }),
      ),
    ),
  );
}
