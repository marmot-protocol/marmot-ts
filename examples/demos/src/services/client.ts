import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  Observable,
  combineLatest,
  fromEvent,
  of,
  shareReplay,
  switchMap,
  takeUntil,
  withLatestFrom,
} from "rxjs";
import { account$ } from "./accounts.js";
import { transport$ } from "./transport.js";
import { clientId$ } from "./client-id.js";
import { sessionDatabase$ } from "./session-database.js";

/** The actual library client. No facade, decorated managers, or forwarded methods. */
export const client$: Observable<MarmotClient | undefined> =
  sessionDatabase$.pipe(
    // Pair the database with its account before reacting to transport or slot changes.
    withLatestFrom(account$),
    switchMap(([database, account]) => {
      if (!database || !account) return of(undefined);
      return combineLatest([transport$, clientId$]).pipe(
        switchMap(
          ([network, clientId]) =>
            new Observable<MarmotClient>((subscriber) => {
              const client = new MarmotClient({
                signer: account.signer,
                database,
                clientId,
                network,
              });
              subscriber.next(client);
              return () => client.dispose();
            }),
        ),
      );
    }),
    takeUntil(fromEvent(globalThis, "pagehide")),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
