import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import {
  combineLatest,
  filter,
  firstValueFrom,
  lastValueFrom,
  map,
  shareReplay,
  startWith,
} from "rxjs";
import localforage from "localforage";
import { KeyValueGroupStateBackend, MarmotClient } from "../../../src";
import {
  NostrNetworkInterface,
  PublishResponse,
} from "../../../src/client/nostr-interface";
import accounts from "./accounts";
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
        // NIP-65: inboxes are where a user expects to *receive* messages.
        // Gift-wrapped welcome messages (kind 1059) should be delivered there.
        map((mailboxes) => mailboxes.inboxes),
        simpleTimeout(30_000, "Failed to fetch users inbox relays"),
      ),
    ),
};

// Global subscription manager instance
let subscriptionManager: GroupSubscriptionManager | null = null;

// Track the current client + handler so we can detach event listeners when account changes
let currentClient: MarmotClient | null = null;
let groupsUpdatedHandler: (() => void) | null = null;
let groupStateChangedHandler: (() => void) | null = null;

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

    // Detach any previous client listeners
    if (currentClient && groupsUpdatedHandler) {
      currentClient.off("groupsUpdated", groupsUpdatedHandler);
    }
    if (currentClient && groupStateChangedHandler) {
      currentClient.groupStateStore.off(
        "groupStateAdded",
        groupStateChangedHandler,
      );
      currentClient.groupStateStore.off(
        "groupStateUpdated",
        groupStateChangedHandler,
      );
      currentClient.groupStateStore.off(
        "groupStateRemoved",
        groupStateChangedHandler,
      );
    }
    currentClient = null;
    groupsUpdatedHandler = null;
    groupStateChangedHandler = null;

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

      // IMPORTANT: reconcile subscriptions when the client's group inventory changes.
      // Without this, newly created/joined/imported groups won't get background
      // subscriptions until a full page refresh.
      if (currentClient && groupsUpdatedHandler) {
        currentClient.off("groupsUpdated", groupsUpdatedHandler);
      }
      currentClient = client;
      groupsUpdatedHandler = () => {
        subscriptionManager?.reconcileSubscriptions().catch((err) => {
          console.error("Failed to reconcile subscriptions:", err);
        });
      };
      client.on("groupsUpdated", groupsUpdatedHandler);

      // Also reconcile when the local group store changes so new groups start syncing
      // without requiring a page refresh.
      // We do this here (instead of importing groupStoreChanges$) to avoid a circular import.
      if (groupStateChangedHandler) {
        currentClient.groupStateStore.off(
          "groupStateAdded",
          groupStateChangedHandler,
        );
        currentClient.groupStateStore.off(
          "groupStateUpdated",
          groupStateChangedHandler,
        );
        currentClient.groupStateStore.off(
          "groupStateRemoved",
          groupStateChangedHandler,
        );
      }
      groupStateChangedHandler = () => {
        subscriptionManager?.reconcileSubscriptions().catch((err) => {
          console.error("Failed to reconcile subscriptions:", err);
        });
      };
      client.groupStateStore.on("groupStateAdded", groupStateChangedHandler);
      client.groupStateStore.on("groupStateUpdated", groupStateChangedHandler);
      client.groupStateStore.on("groupStateRemoved", groupStateChangedHandler);
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
