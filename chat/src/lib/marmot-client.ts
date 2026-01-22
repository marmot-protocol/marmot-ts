import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { NostrEvent } from "applesauce-core/helpers/event";
import { onlyEvents } from "applesauce-relay";
import {
  MarmotClient,
  NostrNetworkInterface,
  PublishResponse,
} from "marmot-ts";
import {
  combineLatest,
  firstValueFrom,
  lastValueFrom,
  map,
  shareReplay,
  startWith,
} from "rxjs";
import accounts from "./accounts";
import { groupStore$ } from "./group-store";
import { keyPackageStore$ } from "./key-package-store";
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
  startWith(undefined),
  shareReplay(1),
);

// Attach marmot client to window for debugging
if (import.meta.env.DEV) {
  marmotClient$.subscribe((client) => {
    // @ts-ignore
    window.marmotClient = client;
  });
}
