import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { defined } from "applesauce-core";
import type { ClientState } from "ts-mls";
import { firstValueFrom } from "rxjs";
import { BehaviorSubject, fromEvent, merge, of } from "rxjs";
import {
  distinctUntilChanged,
  map,
  shareReplay,
  startWith,
  switchMap,
} from "rxjs/operators";
import type { MarmotGroup } from "../../../src/client/group/marmot-group";
import {
  extractMarmotGroupData,
  getMemberCount,
  getNostrGroupIdHex,
} from "../../../src/core";
import { marmotClient$ } from "./marmot-client";

/**
 * Manual refresh hook for UIs that perform store writes outside of the normal
 * event flow (or where some browsers miss EventEmitter-based events).
 */
const groupStoreManualRefresh$ = new BehaviorSubject<number>(0);

export function triggerGroupStoreRefresh(): void {
  groupStoreManualRefresh$.next(Date.now());
}

/** Currently selected group id (hex) */
export const selectedGroupId$ = new BehaviorSubject<string | null>(null);

/**
 * Emits whenever the underlying bytes-only group store changes.
 * Used to make group lists/counts reactive.
 */
export const groupStoreChanges$ = marmotClient$.pipe(
  defined(),
  switchMap((client) =>
    merge(
      // initial tick
      of(0),
      groupStoreManualRefresh$,
      fromEvent(client.groupStateStore, "groupStateAdded"),
      fromEvent(client.groupStateStore, "groupStateUpdated"),
      fromEvent(client.groupStateStore, "groupStateRemoved"),
    ).pipe(map(() => client)),
  ),
  shareReplay(1),
);

/** List of locally stored group ids (hex). */
export const groupIds$ = groupStoreChanges$.pipe(
  switchMap(async (client) => {
    const ids = await client.groupStateStore.list();
    return ids.map((id) => bytesToHex(id));
  }),
  // Avoid noisy rerenders when ordering is stable and ids are unchanged
  distinctUntilChanged(
    (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  ),
  shareReplay(1),
);

/** Reactive count of locally stored groups. */
export const groupCount$ = groupIds$.pipe(map((ids) => ids.length));

export type GroupSummary = {
  /** group id (hex) */
  groupId: string;
  /** group name (from MarmotGroupData) */
  name: string;
  /** current epoch */
  epoch: number;
  /** member count */
  memberCount: number;
  /** nostr group id (hex) */
  nostrGroupIdHex: string;
};

/** Hydrated group objects for all locally stored groups. */
export const groups$ = groupIds$.pipe(
  switchMap((ids) =>
    marmotClient$.pipe(
      defined(),
      switchMap(async (client) => {
        const groups = (
          await Promise.all(
            ids.map(async (id) => {
              try {
                return await client.getGroup(id);
              } catch {
                return null;
              }
            }),
          )
        ).filter(Boolean) as MarmotGroup[];
        return groups;
      }),
    ),
  ),
  shareReplay(1),
);

/** Minimal metadata used by UIs (selector, manager, side nav counts). */
export const groupSummaries$ = groups$.pipe(
  map((groups): GroupSummary[] => {
    return groups
      .map((group) => {
        const data = extractMarmotGroupData(group.state);
        const name = data?.name ?? "Unnamed Group";
        const memberCount = getMemberCount(group.state);
        const epoch = Number(group.state.groupContext.epoch);

        // Defensive: getNostrGroupIdHex throws for groups without MarmotGroupData
        let nostrGroupIdHex: string;
        try {
          nostrGroupIdHex = getNostrGroupIdHex(group.state);
        } catch {
          // Invalid group (lacks MarmotGroupData), filter it out
          return null;
        }

        return {
          groupId: bytesToHex(group.state.groupContext.groupId),
          name,
          epoch,
          memberCount,
          nostrGroupIdHex,
        };
      })
      .filter((summary): summary is GroupSummary => summary !== null);
  }),
  shareReplay(1),
);

/**
 * Convenience helper for destructive removal.
 * Uses MarmotClient.destroyGroup so group history/backends (if any) can be cleaned.
 */
export async function destroyGroup(groupIdHex: string): Promise<void> {
  const client = await firstValueFrom(marmotClient$.pipe(defined()));

  await client.destroyGroup(hexToBytes(groupIdHex));
}

/**
 * Selected group instance, hydrated via MarmotClient.getGroup().
 * This is the single source-of-truth group object used by the examples UI.
 */
export const selectedGroup$ = merge(
  // emit null immediately for initial render
  of(null as MarmotGroup | null),
  selectedGroupId$.pipe(
    switchMap((groupId) =>
      marmotClient$.pipe(
        defined(),
        switchMap(async (client) => {
          if (!groupId) return null;
          return await client.getGroup(groupId);
        }),
      ),
    ),
  ),
).pipe(startWith(null), shareReplay(1));

/**
 * Helper to access the currently selected hydrated ClientState.
 * Some components still use `ClientState` shapes for display.
 */
export const selectedClientState$ = selectedGroup$.pipe(
  map((group) => (group ? (group.state as ClientState) : null)),
  shareReplay(1),
);
