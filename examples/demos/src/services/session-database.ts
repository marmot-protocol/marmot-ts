import type { MarmotDatabase } from "@internet-privacy/marmot-ts/client";
import { Observable, combineLatest, of, shareReplay, switchMap } from "rxjs";
import { account$ } from "./accounts.js";
import { clientId$ } from "./client-id.js";
import { mode$ } from "./mode.js";
import { sessionDatabase } from "./internal/session-database.js";

/** Owns the active account's database, including initialization and closing. */
export const sessionDatabase$ = combineLatest([
  account$,
  mode$,
  clientId$,
]).pipe(
  switchMap(([account, mode, clientId]) => {
    if (!account) return of(undefined);
    return new Observable<MarmotDatabase | undefined>((subscriber) => {
      let database: MarmotDatabase | undefined;
      subscriber.next(undefined);
      subscriber.add(() => void database?.account.close());
      void sessionDatabase(account.pubkey, mode, clientId)
        .then((opened) => {
          if (subscriber.closed) {
            void opened.account.close();
            return;
          }
          database = opened;
          subscriber.next(database);
        })
        .catch((cause: unknown) => subscriber.error(cause));
    });
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);
