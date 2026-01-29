import localforage from "localforage";
import {
  BehaviorSubject,
  combineLatestWith,
  fromEvent,
  map,
  merge,
  of,
  shareReplay,
  switchMap,
} from "rxjs";
import { KeyPackageStore } from "../../../src/store/key-package-store";
import accounts from "./accounts";

// Observable that triggers whenever the store changes
const storeChanges$ = new BehaviorSubject<number>(0);

// Create and export a shared KeyPackageStore instance
export const keyPackageStore$ = accounts.active$.pipe(
  map((account) => {
    return new KeyPackageStore(
      localforage.createInstance({
        name: "marmot-key-package-store",
      }),
      {
        prefix: account?.pubkey ?? "anon",
      },
    );
  }),
  switchMap((store) => {
    return merge(
      of(store),
      // Listen for key package events
      fromEvent(store, "keyPackageAdded"),
      fromEvent(store, "keyPackageRemoved"),
    ).pipe(map(() => store));
  }),
  shareReplay(1),
);

// Observable for the count of key packages in the store
// This will automatically update when the store changes
export const keyPackageCount$ = keyPackageStore$.pipe(
  combineLatestWith(storeChanges$),
  switchMap(([store, _]) => store.count()),
);
