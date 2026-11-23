import { Observable, of, shareReplay, switchMap, withLatestFrom } from "rxjs";
import { client$ } from "./client.js";
import { account$ } from "./accounts.js";
import { mode$ } from "./mode.js";
import { relays$ } from "./relays.js";
import { takeInitialKeyPackagePublication } from "./internal/development-identity.js";

type PublicationState = { busy: boolean; error?: string };

/** Only freshly generated local identities publish automatically. */
export const state$: Observable<PublicationState> = client$.pipe(
  withLatestFrom(account$, mode$, relays$),
  switchMap(([client, account, mode, relays]) => {
    if (!client || !account) return of({ busy: false });
    const newlyCreated = takeInitialKeyPackagePublication(account);
    if (!newlyCreated || mode !== "local") return of({ busy: false });
    return new Observable<{ busy: boolean; error?: string }>((subscriber) => {
      subscriber.next({ busy: true });
      void client.keyPackages.ensurePublished({ relays }).then(
        () => subscriber.next({ busy: false }),
        (cause: unknown) =>
          subscriber.next({
            busy: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
      );
    });
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);
