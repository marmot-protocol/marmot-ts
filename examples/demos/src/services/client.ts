import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  Observable,
  combineLatest,
  fromEvent,
  of,
  shareReplay,
  switchMap,
  takeUntil,
} from "rxjs";
import { account$ } from "./accounts.js";
import { transport$ } from "./transport.js";
import { clientId$ } from "./client-id.js";
import { sessionDatabase } from "./internal/session-database.js";

/** The actual library client. No facade, decorated managers, or forwarded methods. */
export const client$: Observable<MarmotClient | undefined> = combineLatest([
  account$,
  transport$,
  clientId$,
]).pipe(
  switchMap(([account, transport, clientId]) => {
    if (!account) return of(undefined);
    return new Observable<MarmotClient | undefined>((subscriber) => {
      let client: MarmotClient | undefined;
      subscriber.next(undefined);
      subscriber.add(() => {
        for (const group of client?.groups.loaded ?? []) group.dispose();
        void client?.database.account.close();
      });
      void sessionDatabase(account.pubkey, transport.mode, clientId)
        .then((database) => {
          if (subscriber.closed) {
            void database.account.close();
            return;
          }
          client = new MarmotClient({
            signer: account.signer,
            database,
            clientId,
            network: transport.network("you"),
          });
          subscriber.next(client);
        })
        .catch((cause: unknown) => {
          subscriber.error(cause);
        });
    });
  }),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);
