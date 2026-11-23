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
import { mode$ } from "./mode.js";
import { sessionDatabase } from "./internal/session-database.js";

/** The actual library client. No facade, decorated managers, or forwarded methods. */
export const client$: Observable<MarmotClient | undefined> = combineLatest([
  account$,
  transport$,
  clientId$,
]).pipe(
  switchMap(([account, network, clientId]) => {
    // The writable root is already updated when its new transport is emitted.
    const mode = mode$.getValue();
    if (!account) return of(undefined);
    return new Observable<MarmotClient | undefined>((subscriber) => {
      let client: MarmotClient | undefined;
      subscriber.next(undefined);
      subscriber.add(() => {
        for (const group of client?.groups.loaded ?? []) group.dispose();
        void client?.database.account.close();
      });
      void sessionDatabase(account.pubkey, mode, clientId)
        .then((database) => {
          if (subscriber.closed) {
            void database.account.close();
            return;
          }
          client = new MarmotClient({
            signer: account.signer,
            database,
            clientId,
            network,
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
