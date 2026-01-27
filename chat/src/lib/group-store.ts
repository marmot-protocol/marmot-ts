import localforage from "localforage";
import {
  defaultMarmotClientConfig,
  GroupStore,
  MarmotGroupHistoryStore,
} from "marmot-ts";
import {
  BehaviorSubject,
  combineLatestWith,
  map,
  of,
  shareReplay,
  switchMap,
} from "rxjs";
import accountManager from "./accounts";
import { IdbGroupHistoryStore } from "./idb-group-history";

// Observable that triggers whenever the store changes
const storeChanges$ = new BehaviorSubject<number>(0);

/** Emits whenever the local group store mutates (add/update/remove/clear). */
export const groupStoreChanges$ = storeChanges$.asObservable();

/** Create a group store based on the active account */
export const groupStore$ = accountManager.active$.pipe(
  map((account) =>
    account && new GroupStore(
      localforage.createInstance({
        name: `${account.pubkey}-groups`,
      }),
      defaultMarmotClientConfig,
      {
        onUpdate: () => notifyStoreChange(), // Wire up notification
      },
    )
  ),
  // re-emit the store when the store changes
  combineLatestWith(storeChanges$),
  map(([store, _]) => store),
  shareReplay(1),
);

/** Group a group history store based on the active account */
export const groupHistoryStore$ = accountManager.active$.pipe(
  map((account) =>
    account && MarmotGroupHistoryStore.makeGroupHistoryInterface(
      new IdbGroupHistoryStore(`${account?.pubkey}-group-history`),
    )
  ),
  // Only create a single instance of the group history store
  shareReplay(1),
);

// Helper function to notify about store changes
function notifyStoreChange() {
  storeChanges$.next(storeChanges$.value + 1);
}

// Observable for the count of groups in the store
// This will automatically update when the store changes
export const groupCount$ = groupStore$.pipe(
  combineLatestWith(storeChanges$),
  switchMap(([store, _]) => store ? store.count() : of(0)),
);
