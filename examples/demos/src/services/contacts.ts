import { castUser } from "applesauce-common/casts";
import {
  Observable,
  combineLatest,
  of,
  shareReplay,
  switchMap,
  fromEvent,
  takeUntil,
} from "rxjs";
import { account$ } from "./accounts.js";
import { transport$ } from "./transport.js";
import { ContactsService } from "./internal/contacts.js";
import { mode$ } from "./mode.js";
import { publishDevelopmentProfile } from "./internal/development-identity.js";

const discovery$ = combineLatest([account$, transport$]).pipe(
  switchMap(([account, network]) => {
    const mode = mode$.getValue();
    if (!account) return of(undefined);
    return new Observable<ContactsService>((subscriber) => {
      const controller = new AbortController();
      const contacts = new ContactsService(account.pubkey, network, mode);
      subscriber.next(contacts);
      if (mode === "local") {
        void publishDevelopmentProfile(account, network, controller.signal)
          .then((profile) => {
            if (profile && !controller.signal.aborted)
              contacts.store.add(profile);
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted)
              contacts.error$.next(
                cause instanceof Error ? cause.message : String(cause),
              );
          });
      }
      return () => {
        controller.abort();
        contacts.close();
      };
    });
  }),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export type { PeerTab } from "./internal/peer-tabs.js";

/** All other local tabs, including those which have not published a key package. */
export const peers$ = discovery$.pipe(
  switchMap((contacts) => contacts?.peers$.asObservable() ?? of([])),
  shareReplay({ bufferSize: 1, refCount: true }),
);

/** Each User pairs its identity with its reactive profile$, outboxes$, etc. */
export const contacts$ = discovery$.pipe(
  switchMap((contacts) => contacts?.contacts$.asObservable() ?? of([])),
  shareReplay({ bufferSize: 1, refCount: true }),
);
export const error$ = discovery$.pipe(
  switchMap((contacts) => contacts?.error$.asObservable() ?? of(undefined)),
  shareReplay({ bufferSize: 1, refCount: true }),
);

export function profile$(pubkey: string) {
  return discovery$.pipe(
    switchMap((contacts) =>
      contacts ? castUser(pubkey, contacts.store).profile$ : of(undefined),
    ),
  );
}
