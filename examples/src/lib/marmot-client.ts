import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import {
  combineLatest,
  filter,
  firstValueFrom,
  from,
  lastValueFrom,
  map,
  of,
  shareReplay,
  startWith,
  switchMap,
} from "rxjs";
import localforage from "localforage";
import {
  KeyValueGroupStateBackend,
  MarmotClient,
  defaultMarmotClientConfig,
} from "../../../src";
import { MarmotGroup } from "../../../src/client/group/marmot-group";
import {
  NostrNetworkInterface,
  PublishResponse,
} from "../../../src/client/nostr-interface";
import accounts from "./accounts";
import { selectedGroupId$ } from "./group-store";
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

// Track when subscription manager is fully initialized
let isSubscriptionManagerReady = false;

// Export the subscription manager for components to register callbacks
export function getSubscriptionManager(): GroupSubscriptionManager | null {
  return subscriptionManager;
}

// Create an observable that creates a MarmotClient instance based on the current active account and stores.
// Note: We use distinctUntilChanged on the account to avoid recreating the client unnecessarily.
export const marmotClient$ = combineLatest([
  accounts.active$.pipe(defined()),
  keyPackageStore$,
]).pipe(
  map(([account, keyPackageStore]) => {
    // Create a KeyValueGroupStateBackend wrapping localforage
    const groupStateBackend = new KeyValueGroupStateBackend(
      localforage.createInstance({
        name: `marmot-group-store-${account.pubkey}`,
      }),
    );

    return new MarmotClient({
      signer: account.signer,
      groupStateBackend,
      keyPackageStore,
      network: networkInterface,
      clientConfig: defaultMarmotClientConfig,
    });
  }),
  startWith(undefined),
  shareReplay(1),
);

// Initialize subscription manager when client is ready
marmotClient$.subscribe(async (client) => {
  if (!client) {
    // Stop subscription manager when client is null
    if (subscriptionManager) {
      subscriptionManager.stop();
      subscriptionManager = null;
    }
    isSubscriptionManagerReady = false;
    return;
  }

  // Only start if not already running
  if (!subscriptionManager) {
    console.log("Starting subscription manager...");
    subscriptionManager = new GroupSubscriptionManager(client);
    try {
      await subscriptionManager.start();
      isSubscriptionManagerReady = true;
      console.log("Subscription manager started successfully");
    } catch (err) {
      console.error("Failed to start subscription manager:", err);
      subscriptionManager = null;
      isSubscriptionManagerReady = false;
    }
  }
});

// Reconcile subscriptions when client changes and manager is ready
// Obtain the latest marmotClient$ value and ensure manager is ready before reconciling
marmotClient$
  .pipe(
    filter((client) => {
      // Only proceed when client exists and subscription manager is fully initialized
      return Boolean(
        client && isSubscriptionManagerReady && subscriptionManager,
      );
    }),
  )
  .subscribe(() => {
    // At this point we know subscriptionManager is not null because of the filter
    subscriptionManager!.reconcileSubscriptions().catch((err) => {
      console.error("Failed to reconcile subscriptions:", err);
    });
  });

// Observable for the currently selected group
// Derives the MarmotGroup from the selectedGroupId$ and marmotClient$
// Note: This only updates when groupId or client changes, not on every store update.
// The group's internal state is reactive through the MarmotGroup instance.
export const selectedGroup$ = combineLatest([
  selectedGroupId$,
  marmotClient$.pipe(defined()),
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
