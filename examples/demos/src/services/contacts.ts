import { castUser } from "applesauce-common/casts";
import { EventStore } from "applesauce-core";
import {
  Observable,
  BehaviorSubject,
  EMPTY,
  catchError,
  combineLatest,
  of,
  shareReplay,
  switchMap,
  fromEvent,
  takeUntil,
} from "rxjs";
import { account$ } from "./accounts.js";
import { transport$ } from "./transport.js";
import { discoverContacts$ } from "./internal/contacts.js";
import { peerTabs$, type PeerTab } from "./internal/peer-tabs.js";
import { mode$ } from "./mode.js";
import { publishDevelopmentProfile } from "./internal/development-identity.js";

const discovery$ = combineLatest([account$, transport$]).pipe(
  switchMap(([account, network]) => {
    const mode = mode$.getValue();
    if (!account) return of(undefined);
    return new Observable<{
      store: EventStore;
      contacts$: ReturnType<typeof discoverContacts$>;
      peers$: Observable<PeerTab[]>;
      error$: Observable<string | undefined>;
    }>((subscriber) => {
      const controller = new AbortController();
      const store = new EventStore();
      const errors = new BehaviorSubject<string | undefined>(undefined);
      const report = (cause: unknown) =>
        errors.next(cause instanceof Error ? cause.message : String(cause));
      const peers$ = (
        mode === "local" ? peerTabs$(account.pubkey) : of<PeerTab[]>([])
      ).pipe(
        catchError((cause: unknown) => {
          report(cause);
          return EMPTY;
        }),
        takeUntil(fromEvent(controller.signal, "abort")),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      const contacts$ = discoverContacts$(
        account.pubkey,
        network,
        mode,
        store,
        peers$,
        report,
      ).pipe(
        takeUntil(fromEvent(controller.signal, "abort")),
        shareReplay({ bufferSize: 1, refCount: true }),
      );
      // Discovery also loads profiles for consumers that only use profile$.
      const discovery = contacts$.subscribe({ error: report });
      subscriber.next({
        store,
        contacts$,
        peers$,
        error$: errors.asObservable(),
      });
      if (mode === "local") {
        void publishDevelopmentProfile(account, network, controller.signal)
          .then((profile) => {
            if (profile && !controller.signal.aborted) store.add(profile);
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted) report(cause);
          });
      }
      return () => {
        controller.abort();
        discovery.unsubscribe();
        errors.complete();
        store.dispose();
      };
    });
  }),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export type { PeerTab } from "./internal/peer-tabs.js";

/** All other local tabs, including those which have not published a key package. */
export const peers$ = discovery$.pipe(
  switchMap((contacts) => contacts?.peers$ ?? of([])),
  shareReplay({ bufferSize: 1, refCount: true }),
);

/** Each User pairs its identity with its reactive profile$, outboxes$, etc. */
export const contacts$ = discovery$.pipe(
  switchMap((contacts) => contacts?.contacts$ ?? of([])),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const error$ = discovery$.pipe(
  switchMap((contacts) => contacts?.error$ ?? of(undefined)),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export function profile$(pubkey: string) {
  return discovery$.pipe(
    switchMap((contacts) =>
      contacts ? castUser(pubkey, contacts.store).profile$ : of(undefined),
    ),
  );
}
