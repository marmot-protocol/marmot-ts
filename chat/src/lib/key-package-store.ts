import localforage from "localforage";
import {
  BehaviorSubject,
  combineLatestWith,
  map,
  shareReplay,
  switchMap,
} from "rxjs";
import accountManager from "./accounts";
import { KeyPackageStore } from "marmot-ts";

// Observable that triggers whenever the store changes
const storeChanges$ = new BehaviorSubject<number>(0);

// Create and export a shared KeyPackageStore instance
export const keyPackageStore$ = accountManager.active$.pipe(
  map((account) => {
    return new KeyPackageStore(
      localforage.createInstance({
        name: "marmot-key-package-store",
      }),
      {
        prefix: account?.pubkey ?? "anon",
        onUpdate: () => notifyStoreChange(), // Wire up notification
      },
    );
  }),
  // re-emit the store when the store changes
  combineLatestWith(storeChanges$),
  map(([store, _]) => store),
  shareReplay(1),
);

// Helper function to notify about store changes
function notifyStoreChange() {
  storeChanges$.next(storeChanges$.value + 1);
}

// Observable for the count of key packages in the store
// This will automatically update when the store changes
export const keyPackageCount$ = keyPackageStore$.pipe(
  combineLatestWith(storeChanges$),
  switchMap(([store, _]) => store.count()),
);
