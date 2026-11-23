import type { MarmotDatabase } from "@internet-privacy/marmot-ts/client";
import { indexedDBDatabase } from "@internet-privacy/marmot-ts/extra";
import { Observable, of, shareReplay, switchMap } from "rxjs";
import { account$ } from "./accounts.js";

/** Owns the active account's database, including initialization and closing. */
export const sessionDatabase$ = account$.pipe(
  switchMap((account) => {
    if (!account) return of(undefined);
    return new Observable<MarmotDatabase | undefined>((subscriber) => {
      subscriber.next(undefined);
      const database = indexedDBDatabase({
        prefix: `marmot-demos:mls:${account.pubkey}`,
      });
      subscriber.add(() => void database.account.close());
      subscriber.next(database);
    });
  }),
  shareReplay({ bufferSize: 1, refCount: true }),
);
