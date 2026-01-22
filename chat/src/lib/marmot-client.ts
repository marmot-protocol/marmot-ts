import { defined, mapEventsToTimeline, simpleTimeout } from "applesauce-core";
import { onlyEvents } from "applesauce-relay";
import {
  combineLatest,
  firstValueFrom,
  lastValueFrom,
  map,
  shareReplay,
  startWith,
} from "rxjs";
import {
  MarmotClient,
  NostrNetworkInterface,
  PublishResponse,
} from "marmot-ts";
import accounts from "./accounts";
import { groupStore$ } from "./group-store";
import { keyPackageStore$ } from "./key-package-store";
import { eventStore, pool } from "./nostr";

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
