import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  Observable,
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
    // Rebuild only after the database invalidates or finishes opening, never
    // combine a new account or transport with the previous account's database.
    withLatestFrom(account$, transport$, clientId$),
    switchMap(([database, account, network, clientId]) => {
      if (!database || !account) return of(undefined);
      return new Observable<MarmotClient>((subscriber) => {
        const client = new MarmotClient({
          signer: account.signer,
          database,
          clientId,
          network,
        });
        subscriber.next(client);
        return () => client.dispose();
      });
    }),
    takeUntil(fromEvent(globalThis, "pagehide")),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
