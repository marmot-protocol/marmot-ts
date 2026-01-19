import localforage from "localforage";
import { BehaviorSubject, map, shareReplay, switchMap } from "rxjs";
import { GroupStore, defaultMarmotClientConfig } from "../../../src";
import accounts from "./accounts";

// Observable that triggers whenever the store changes.
// This is a manual signal for UI components that need to reload data.
// Note: This is NOT used in reactive chains (groupStore$, selectedGroup$) to avoid cascading re-emissions.
export const storeChanges$ = new BehaviorSubject<number>(0);

// BehaviorSubject for the currently selected group ID
export const selectedGroupId$ = new BehaviorSubject<string | null>(null);

// Create and export a shared GroupStore instance
// Note: This only emits when the account changes, not on every store update.
// The onUpdate callback still fires to notify other parts of the app about changes.
export const groupStore$ = accounts.active$.pipe(
  map((account) => {
    return new GroupStore(
      localforage.createInstance({
        name: "marmot-group-store",
      }),
      defaultMarmotClientConfig,
      {
        prefix: account?.pubkey ?? "anon",
        onUpdate: () => notifyStoreChange(), // Wire up notification
      },
    );
  }),
  shareReplay(1),
);

// Helper function to notify about store changes
function notifyStoreChange() {
  storeChanges$.next(storeChanges$.value + 1);
}

// Observable for the count of groups in the store
// Note: This updates when the store instance changes (account change).
// For reactive updates on group additions/removals, subscribe to storeChanges$ separately.
export const groupCount$ = groupStore$.pipe(
  switchMap((store) => store.count()),
);
