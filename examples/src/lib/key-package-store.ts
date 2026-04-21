import localforage from "localforage";
import { map, shareReplay } from "rxjs";
import accounts from "./accounts";

// Create a per-account localforage backend for key package storage.
// This is the raw GenericKeyValueStore passed to MarmotClient.
export const keyPackageStore$ = accounts.active$.pipe(
  map(() =>
    localforage.createInstance({
      name: "marmot-key-package-store",
    }),
  ),
  shareReplay(1),
);
