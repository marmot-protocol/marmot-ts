import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import {
  combineLatest,
  firstValueFrom,
  from,
  lastValueFrom,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
  tap,
} from "rxjs";
import { MarmotClient } from "../../../src";
import { MarmotGroup } from "../../../src/client/group/marmot-group";
import {
  NostrNetworkInterface,
  PublishResponse,
} from "../../../src/client/nostr-interface";
import accounts from "./accounts";
import { groupStore$, selectedGroupId$, storeChanges$ } from "./group-store";
import { keyPackageStore$ } from "./key-package-store";
import { eventStore, pool } from "./nostr";
import { GroupSubscriptionManager } from "./group-subscription-manager";

// Convert RelayPool to NostrPool, then to GroupNostrInterface
const networkInterface: NostrNetworkInterface = {
  request: (relays, filters) =>
    lastValueFrom(pool.request(relays, filters).pipe(mapEventsToTimeline())),
  subscription: (relays, filters) =>
    pool.subscription(relays, filters).pipe(onlyEvents()),
  publish: (relays, event) =>
    pool.publish(relays, event).then((res) =>
      res.reduce(
        (acc, curr) => {
          acc[curr.from] = curr;
          return acc;
        },
        {} as Record<string, PublishResponse>,
      ),
    ),
  getUserInboxRelays: (pubkey) =>
    firstValueFrom(
      eventStore.mailboxes(pubkey).pipe(
        defined(),
        map((mailboxes) => mailboxes.outboxes),
        simpleTimeout(30_000, "Failed to fetch users inbox relays"),
      ),
    ),
};

// Global subscription manager instance
let subscriptionManager: GroupSubscriptionManager | null = null;

// Create an observable that creates a MarmotClient instance based on the current active account and stores.
export const marmotClient$ = combineLatest([
  accounts.active$.pipe(defined()),
  groupStore$,
  keyPackageStore$,
]).pipe(
  map(
    ([account, groupStore, keyPackageStore]) =>
      new MarmotClient({
        signer: account.signer,
        groupStore,
        keyPackageStore,
        network: networkInterface,
      }),
  ),
  tap((client) => {
    // Start the subscription manager when client is created
    if (client && !subscriptionManager) {
      console.log("Starting subscription manager...");
      subscriptionManager = new GroupSubscriptionManager(client);
      subscriptionManager.start().catch((err) => {
        console.error("Failed to start subscription manager:", err);
      });
    }
  }),
  startWith(undefined),
  shareReplay(1),
);

// Stop subscription manager when account changes to null
accounts.active$.subscribe((account) => {
  if (!account && subscriptionManager) {
    subscriptionManager.stop();
    subscriptionManager = null;
  }
});

// Reconcile subscriptions when group store changes
groupStore$.subscribe((store) => {
  if (subscriptionManager && store) {
    subscriptionManager.reconcileSubscriptions().catch((err) => {
      console.error("Failed to reconcile subscriptions:", err);
    });
  }
});

// Observable for the currently selected group
// Derives the MarmotGroup from the selectedGroupId$ and marmotClient$
export const selectedGroup$ = combineLatest([
  selectedGroupId$,
  marmotClient$.pipe(defined()),
  storeChanges$,
]).pipe(
  switchMap(([groupId, client]) => {
    if (!groupId) {
      return of<MarmotGroup | null>(null);
    }
    return from(client.getGroup(groupId));
  }),
  startWith<MarmotGroup | null>(null),
  shareReplay(1),
);
