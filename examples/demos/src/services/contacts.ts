import { castUser } from "applesauce-common/casts";
import { Observable, combineLatest, of, shareReplay, switchMap } from "rxjs";
import { account$ } from "./accounts.js";
import { transport$ } from "./transport.js";
import { ContactsService } from "./internal/contacts.js";
import { DemoRelay } from "./internal/relay/demo-relay.js";
import { publishDevelopmentProfile } from "./internal/development-identity.js";

const discovery$ = combineLatest([account$, transport$]).pipe(
  switchMap(([account, transport]) => {
    if (!account) return of(undefined);
    return new Observable<ContactsService>((subscriber) => {
      const controller = new AbortController();
      if (transport instanceof DemoRelay) transport.setIdentity(account.pubkey);
      const contacts = new ContactsService(
        account.pubkey,
        transport,
        transport.store,
      );
      subscriber.next(contacts);
      if (transport instanceof DemoRelay) {
        void publishDevelopmentProfile(
          account,
          transport,
          controller.signal,
        ).catch((cause: unknown) => {
          if (!controller.signal.aborted)
            contacts.error$.next(
              cause instanceof Error ? cause.message : String(cause),
            );
        });
      }
      return () => {
        controller.abort();
        contacts.close();
        if (transport instanceof DemoRelay) transport.setIdentity(undefined);
      };
    });
  }),
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
  return transport$.pipe(
    switchMap((transport) =>
      transport ? castUser(pubkey, transport.store).profile$ : of(undefined),
    ),
  );
}
