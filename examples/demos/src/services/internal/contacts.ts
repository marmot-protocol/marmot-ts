import { EventStore } from "applesauce-core";
import { castUser, type User } from "applesauce-common/casts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subscription,
  catchError,
  combineLatest,
  distinctUntilChanged,
  map,
  merge,
  of,
  switchMap,
  tap,
} from "rxjs";
import { LOOKUP_RELAYS, LIVE_RELAYS } from "./relays.js";
import { DEMO_RELAY_URL } from "./relay/demo-relay.js";
import type { TransportMode } from "../mode.js";
import { peerTabs$, type PeerTab } from "./peer-tabs.js";

/** One contacts list for the current account and transport session. */
export class ContactsService {
  readonly contacts$ = new BehaviorSubject<User[]>([]);
  readonly error$ = new BehaviorSubject<string | undefined>(undefined);
  readonly peers$ = new BehaviorSubject<PeerTab[]>([]);
  readonly store = new EventStore();
  readonly #subscriptions = new Subscription();

  constructor(
    pubkey: string,
    network: NostrNetworkInterface,
    mode: TransportMode,
  ) {
    const store = this.store;
    const local = mode === "local";
    const relays = local ? [DEMO_RELAY_URL] : LIVE_RELAYS;
    const candidates$ = new BehaviorSubject<User[]>([]);
    const load = (relays: string[], filters: Filter) =>
      new Observable<NostrEvent>((observer) =>
        network.subscription(relays, filters).subscribe(observer),
      ).pipe(
        tap((event) => store.add(event)),
        catchError((cause: unknown) => {
          this.error$.next(
            cause instanceof Error ? cause.message : String(cause),
          );
          return EMPTY;
        }),
      );
    this.#subscriptions.add(() => candidates$.complete());
    this.#subscriptions.add(
      candidates$
        .pipe(
          switchMap((users) =>
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
                ).pipe(
                  map((users) => users.filter((user) => user !== undefined)),
                )
              : of([]),
          ),
        )
        .subscribe((users) => this.contacts$.next(users)),
    );
    this.#subscriptions.add(
      candidates$
        .pipe(
          switchMap((users) =>
            merge(
              ...users.map((user) =>
                merge(
                  load(local ? relays : LOOKUP_RELAYS, {
                    kinds: [0, 10002],
                    authors: [user.pubkey],
                  }),
                  user.outboxes$.pipe(
                    map((outboxes) =>
                      local
                        ? relays
                        : [...new Set([...(outboxes ?? []), ...relays])],
                    ),
                    distinctUntilChanged((a, b) => a.join() === b.join()),
                    switchMap((relays) =>
                      load(relays, {
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
        )
        .subscribe(),
    );

    if (local) {
      this.#subscriptions.add(
        peerTabs$(pubkey).subscribe({
          next: (peers) => {
            this.peers$.next(peers);
            const keys = [...new Set(peers.map((peer) => peer.pubkey))]
              .filter((key) => key !== pubkey)
              .sort();
            if (
              keys.join() !==
              candidates$.value.map((user) => user.pubkey).join()
            )
              candidates$.next(keys.map((key) => castUser(key, store)));
          },
          error: (cause: unknown) => this.error$.next(String(cause)),
        }),
      );
      return;
    }

    const account = castUser(pubkey, store);
    // Bootstrap NIP-65, then follow the account's declared write relays.
    this.#subscriptions.add(
      load(LOOKUP_RELAYS, {
        kinds: [10002],
        authors: [pubkey],
      }).subscribe(),
    );
    this.#subscriptions.add(
      account.outboxes$
        .pipe(
          map((outboxes) => (outboxes?.length ? outboxes : relays)),
          distinctUntilChanged((a, b) => a.join() === b.join()),
          switchMap((relays) =>
            load(relays, { kinds: [3, 0], authors: [pubkey] }),
          ),
        )
        .subscribe(),
    );
    this.#subscriptions.add(
      account.contacts$.subscribe({
        next: (contacts) => candidates$.next(contacts ?? []),
        error: (cause: unknown) => this.error$.next(String(cause)),
      }),
    );
  }

  close() {
    this.#subscriptions.unsubscribe();
    this.contacts$.complete();
    this.error$.complete();
    this.peers$.complete();
    this.store.dispose();
  }
}
