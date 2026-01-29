import localforage from "localforage";
import { KeyPackageStore } from "marmot-ts";
import { BehaviorSubject, combineLatestWith, map, shareReplay } from "rxjs";
import accountManager from "./accounts";

// Observable that triggers whenever the store changes
const storeChanges$ = new BehaviorSubject<number>(0);

// Create and export a shared KeyPackageStore instance
export const keyPackageStore$ = accountManager.active$.pipe(
  map(
    (account) =>
      account &&
      new KeyPackageStore(
        localforage.createInstance({
          name: `${account.pubkey}-key-packages`,
        }),
        {
          onUpdate: () => notifyStoreChange(), // Wire up notification
        },
      ),
  ),
  // re-emit the store when the store changes
  combineLatestWith(storeChanges$),
  map(([store, _]) => store),
  shareReplay(1),
);

// Helper function to notify about store changes
function notifyStoreChange() {
  storeChanges$.next(storeChanges$.value + 1);
}
