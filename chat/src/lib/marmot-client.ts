import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { onlyEvents } from "applesauce-relay";
import {
  GroupRumorHistory,
  MarmotClient,
  MarmotGroup,
  NostrNetworkInterface,
  PublishResponse,
} from "marmot-ts";
import {
  firstValueFrom,
  from,
  fromEvent,
  lastValueFrom,
  map,
  merge,
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
    const { groupStore, keyPackageStore, historyFactory } =
      await databaseBroker.getStorageInterfacesForAccount(account.pubkey);

    // Create a new marmot client for the active account
    return new MarmotClient({
      signer: account.signer,
      groupStore,
      keyPackageStore,
      network: networkInterface,
      historyFactory,
    });
  }),
  startWith(undefined),
  shareReplay(1),
);

// TODO: this is ugly, MarmotClient or KeyPackageStore should expose a simple interface to subscribe to key package changes
// Maybe an AsyncGenerator could be used as a simple stream of updates?
export const liveKeyPackages$ = marmotClient$.pipe(
  switchMap((client) => {
    if (!client) return of([]);

    return merge(
      // Start with true to trigger load
      of(true),
      // Listen for key package events
      fromEvent(client.keyPackageStore, "keyPackageAdded"),
      fromEvent(client.keyPackageStore, "keyPackageRemoved"),
    ).pipe(
      switchMap(() =>
        // Load key packages list
        from(client.keyPackageStore.list()),
      ),
    );
  }),
  shareReplay(1),
);

// TODO: this is a little better but still ugly
export const liveGroups$ = marmotClient$.pipe(
  switchMap((client) => {
    if (!client) return of([]);

    return merge(
      // Start with true to trigger load
      from(client.loadAllGroups()),
      // Listen for group events
      fromEvent(client, "groupsUpdated") as Observable<
        MarmotGroup<GroupRumorHistory>[]
      >,
    );
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
