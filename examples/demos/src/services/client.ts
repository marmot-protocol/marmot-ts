import { MarmotClient } from "@internet-privacy/marmot-ts/client";
import {
  BehaviorSubject,
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
import { sessionDatabase } from "./internal/session-database.js";

const errors = new BehaviorSubject<string | undefined>(undefined);
export const error$ = errors.asObservable();

/** The actual library client. No facade, decorated managers, or forwarded methods. */
export const client$: Observable<MarmotClient | undefined> = combineLatest([
  account$,
  transport$,
]).pipe(
  switchMap(([account, transport]) => {
    errors.next(undefined);
    if (!account) return of(undefined);
    return new Observable<MarmotClient | undefined>((subscriber) => {
      const controller = new AbortController();
      let client: MarmotClient | undefined;
      subscriber.next(undefined);
      subscriber.add(() => {
        controller.abort();
        for (const group of client?.groups.loaded ?? []) group.dispose();
        void client?.database.account.close();
      });
      void sessionDatabase(account.pubkey, transport.mode)
        .then(({ database, clientId }) => {
          if (controller.signal.aborted) {
            void database.account.close();
            return;
          }
          const network = transport.network("you");
          client = new MarmotClient({
            signer: account.signer,
            database,
            clientId,
            network: {
              ...network,
              publish: (relays, event) => {
                controller.signal.throwIfAborted();
                return network.publish(relays, event);
              },
            },
          });
          subscriber.next(client);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            errors.next(cause instanceof Error ? cause.message : String(cause));
        });
    });
  }),
  takeUntil(fromEvent(globalThis, "pagehide")),
  shareReplay({ bufferSize: 1, refCount: true }),
);
