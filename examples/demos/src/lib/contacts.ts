import { EventStore } from "applesauce-core";
import { castUser, type User } from "applesauce-common/casts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subscription,
  catchError,
  distinctUntilChanged,
  map,
  switchMap,
  tap,
} from "rxjs";
import { DemoRelay } from "./demo-relay.js";
import { LOOKUP_RELAYS } from "./live-transport.js";
import type { DemoTransport } from "./transport.js";

/** One contacts list for the current account and transport session. */
export class ContactsService {
  readonly contacts$ = new BehaviorSubject<User[]>([]);
  readonly error$ = new BehaviorSubject<string | undefined>(undefined);
  readonly #subscriptions = new Subscription();

  constructor(pubkey: string, transport: DemoTransport, store: EventStore) {
    if (transport instanceof DemoRelay) {
      this.#subscriptions.add(
        transport
          .network("contacts")
          .subscription(transport.relays, {
            kinds: [0],
          })
          .subscribe({ next: (event) => store.add(event) }),
      );
      const update = () => {
        const keys = [...new Set(transport.peers.map((peer) => peer.pubkey))]
          .filter((key) => key !== pubkey)
          .sort();
        if (
          keys.join() !== this.contacts$.value.map((user) => user.pubkey).join()
        )
          this.contacts$.next(keys.map((key) => castUser(key, store)));
      };
      this.#subscriptions.add(transport.onChange(update));
      update();
      return;
    }

    const network = transport.network("contacts");
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
          map((relays) => (relays?.length ? relays : transport.relays)),
          distinctUntilChanged((a, b) => a.join() === b.join()),
          switchMap((relays) =>
            load(relays, { kinds: [3, 0], authors: [pubkey] }),
          ),
        )
        .subscribe(),
    );
    this.#subscriptions.add(
      account.contacts$.subscribe({
        next: (contacts) => this.contacts$.next(contacts ?? []),
        error: (cause: unknown) => this.error$.next(String(cause)),
      }),
    );
    this.#subscriptions.add(
      this.contacts$
        .pipe(
          map((contacts) => contacts.map((user) => user.pubkey)),
          distinctUntilChanged((a, b) => a.join() === b.join()),
          switchMap((authors) =>
            authors.length
              ? load(LOOKUP_RELAYS, { kinds: [0], authors })
              : EMPTY,
          ),
        )
        .subscribe(),
    );
  }

  close() {
    this.#subscriptions.unsubscribe();
    this.contacts$.complete();
    this.error$.complete();
  }
}
