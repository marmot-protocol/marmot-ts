import type { Unsubscribable } from "@internet-privacy/marmot-ts/client";
import { Observable, of, shareReplay, switchMap, withLatestFrom } from "rxjs";
import { client$ } from "./client.js";
import { account$ } from "./accounts.js";

/** Listen independently of whether this client has published a key package. */
export const error$ = client$.pipe(
  withLatestFrom(account$),
  switchMap(([client, account]) => {
    if (!client || !account) return of(undefined);
    return new Observable<string | undefined>((subscriber) => {
      let closed = false;
      let inbox: Unsubscribable | undefined;
      const report = (cause: unknown) =>
        subscriber.next(cause instanceof Error ? cause.message : String(cause));
      subscriber.next(undefined);
      client.invites.on("error", report);
      void client.network
        .getUserInboxRelays(account.pubkey)
        .then((relays) => (closed ? undefined : client.invites.listen(relays)))
        .then((subscription) => {
          if (closed) subscription?.unsubscribe();
          else inbox = subscription;
        })
        .catch(report);
      return () => {
        closed = true;
        inbox?.unsubscribe();
        client.invites.off("error", report);
      };
    });
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);
