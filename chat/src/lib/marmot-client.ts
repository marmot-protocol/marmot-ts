import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { onlyEvents } from "applesauce-relay";
import {
  GroupRumorHistory,
  MarmotClient,
  MarmotGroup,
  NostrNetworkInterface,
  PublishResponse,
  KeyPackageStore,
} from "marmot-ts";
import {
  firstValueFrom,
  lastValueFrom,
  map,
  Observable,
  of,
  shareReplay,
  startWith,
  switchMap,
} from "rxjs";
import databaseBroker from "./account-database";
import accounts from "./accounts";
import { eventStore, pool } from "./nostr";

/** Publish an event to the given relays */
export function publish(
  relays: string[],
  event: NostrEvent,
): Promise<Record<string, PublishResponse>> {
  return pool.publish(relays, event).then((res) =>
    res.reduce(
      (acc, curr) => {
        acc[curr.from] = curr;
        return acc;
      },
      {} as Record<string, PublishResponse>,
    ),
  );
}

/** Fetch the inbox relays for a specific user */
function getUserInboxRelays(pubkey: string): Promise<string[]> {
  return firstValueFrom(
    eventStore.mailboxes(pubkey).pipe(
      defined(),
      map((mailboxes) => mailboxes.inboxes),
      simpleTimeout(30_000, "Failed to fetch users inbox relays"),
    ),
  );
}

// Convert RelayPool to NostrPool, then to GroupNostrInterface
const networkInterface: NostrNetworkInterface = {
  request: (relays, filters) =>
    lastValueFrom(pool.request(relays, filters).pipe(mapEventsToTimeline())),
  subscription: (relays, filters) =>
    pool.subscription(relays, filters).pipe(onlyEvents()),
  publish,
  getUserInboxRelays,
};

// Create an observable that creates a MarmotClient instance based on the current active account and stores.
export const marmotClient$ = accounts.active$.pipe(
  switchMap(async (account) => {
    // Ensure all stores are created and setup
    if (!account) return;

    // Get storage interfaces for the account
    const { groupStateBackend, keyPackageStore, historyFactory } =
      await databaseBroker.getStorageInterfacesForAccount(account.pubkey);

    // Create a new marmot client for the active account
    return new MarmotClient({
      signer: account.signer,
      groupStateBackend,
      keyPackageStore,
      network: networkInterface,
      historyFactory,
    });
  }),
  startWith(undefined),
  shareReplay(1),
);

/**
 * Converts the client's watchKeyPackages async generator to an RxJS Observable.
 * This provides a reactive stream of key package updates.
 */
export const liveKeyPackages$ = marmotClient$.pipe(
  switchMap((client) => {
    if (!client) return of([]);

    // Use the new watchKeyPackages async generator from MarmotClient
    return new Observable<Awaited<ReturnType<KeyPackageStore["list"]>>>(
      (subscriber) => {
        const abortController = new AbortController();
        const iterator = client.watchKeyPackages()[Symbol.asyncIterator]();

        (async () => {
          try {
            while (!abortController.signal.aborted) {
              const { value, done } = await iterator.next();
              if (done) break;
              subscriber.next(value);
            }
          } catch (error) {
            subscriber.error(error);
          } finally {
            subscriber.complete();
          }
        })();

        return () => {
          abortController.abort();
          iterator.return?.(undefined);
        };
      },
    );
  }),
  shareReplay(1),
);

/**
 * Converts the client's watchGroups async generator to an RxJS Observable.
 * This provides a reactive stream of group updates.
 */
export const liveGroups$ = marmotClient$.pipe(
  switchMap((client) => {
    if (!client) return of([]);

    // Use the new watchGroups async generator from MarmotClient
    return new Observable<MarmotGroup<GroupRumorHistory>[]>((subscriber) => {
      const abortController = new AbortController();
      const iterator = client.watchGroups()[Symbol.asyncIterator]();

      (async () => {
        try {
          while (!abortController.signal.aborted) {
            const { value, done } = await iterator.next();
            if (done) break;
            subscriber.next(value);
          }
        } catch (error) {
          subscriber.error(error);
        } finally {
          subscriber.complete();
        }
      })();

      return () => {
        abortController.abort();
        iterator.return?.(undefined);
      };
    });
  }),
  shareReplay(1),
);

// Attach marmot client to window for debugging
if (import.meta.env.DEV) {
  marmotClient$.subscribe((client) => {
    // @ts-ignore
    window.marmotClient = client;
  });
}
