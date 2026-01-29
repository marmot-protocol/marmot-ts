import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import type { NostrEvent } from "applesauce-core/helpers";
import {
  deserializeApplicationRumor,
  getNostrGroupIdHex,
  GROUP_EVENT_KIND,
  MarmotClient,
  MarmotGroup,
} from "marmot-ts";
import { BehaviorSubject, Subscription } from "rxjs";

import { pool } from "@/lib/nostr";

/**
 * Manages persistent subscriptions for all groups in the store.
 *
 * Why: In MLS, the group epoch advances with commits. If we don't ingest commits
 * in the background, the UI can drift and messages may fail to decrypt.
 */
export class GroupSubscriptionManager {
  private groupSubscriptions = new Map<
    string,
    {
      subscription: Subscription;
      seenEventIds: Set<string>;
    }
  >();

  private readonly client: MarmotClient;
  private isActive = false;
  private reconcileInterval: ReturnType<typeof setInterval> | null = null;
  private applicationMessageCallbacks = new Map<
    string,
    (messages: Rumor[]) => void
  >();

  /** GroupIds that currently have messages newer than the last "seen" timestamp. */
  readonly unreadGroupIds$ = new BehaviorSubject<string[]>([]);

  /** Last known message timestamp per group (seconds). */
  private lastMessageAtByGroup = new Map<string, number>();

  /** In-memory buffer of recent application messages per group (sorted). */
  private messageBufferByGroup = new Map<string, Rumor[]>();

  /** Last seen timestamp per group (seconds), persisted in localStorage. */
  private lastSeenAtByGroup = new Map<string, number>();

  constructor(client: MarmotClient) {
    this.client = client;
  }

  /** Start managing subscriptions for all groups in the store. */
  async start(): Promise<void> {
    if (this.isActive) return;

    this.isActive = true;
    this.loadLastSeenFromStorage();
    await this.reconcileSubscriptions();

    // Keep subscriptions in sync with the store over time.
    // Rationale: after a user joins/leaves a group, the store updates but the
    // app should not require a full reload to start/stop subscriptions.
    if (!this.reconcileInterval) {
      this.reconcileInterval = setInterval(() => {
        this.reconcileSubscriptions().catch(() => {
          // ignore
        });
      }, 2_000);
    }
  }

  /** Stop all subscriptions and clean up resources. */
  stop(): void {
    this.isActive = false;

    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }

    for (const [groupId, sub] of this.groupSubscriptions) {
      sub.subscription.unsubscribe();
      this.groupSubscriptions.delete(groupId);
    }

    this.unreadGroupIds$.next([]);
    this.lastMessageAtByGroup.clear();
    this.lastSeenAtByGroup.clear();
    this.messageBufferByGroup.clear();
  }

  /** Mark a group as seen up to a given timestamp (seconds). */
  markGroupSeen(groupIdHex: string, seenAt: number): void {
    const clamped = Math.max(0, Math.floor(seenAt));
    this.lastSeenAtByGroup.set(groupIdHex, clamped);
    this.persistLastSeenToStorage(groupIdHex, clamped);
    this.recomputeUnreadGroupIds();
  }

  /**
   * Reconcile subscriptions with the current state of the group store.
   * Adds subscriptions for new groups and removes subscriptions for deleted groups.
   */
  async reconcileSubscriptions(): Promise<void> {
    if (!this.isActive) return;

    try {
      const groups = await this.client.groupStore.list();
      const groupIds = new Set<string>();

      for (const groupState of groups) {
        const groupIdHex = getNostrGroupIdHex(groupState);
        groupIds.add(groupIdHex);

        if (!this.groupSubscriptions.has(groupIdHex)) {
          await this.subscribeToGroup(groupIdHex);
        }
      }

      for (const [groupId] of this.groupSubscriptions) {
        if (!groupIds.has(groupId)) {
          this.unsubscribeFromGroup(groupId);
        }
      }
    } catch (error) {
      console.error("Failed to reconcile group subscriptions:", error);
    }
  }

  private async subscribeToGroup(groupIdHex: string): Promise<void> {
    try {
      const group = await this.client.getGroup(groupIdHex);
      const relays = group.relays;

      if (!relays || relays.length === 0) {
        console.warn(
          `[GroupSubscriptionManager] No relays for group ${groupIdHex}`,
        );
        return;
      }

      const filters = {
        kinds: [GROUP_EVENT_KIND],
        "#h": [groupIdHex],
      };

      const observable = pool.subscription(relays, filters);
      const seenEventIds = new Set<string>();

      const subscription = observable.subscribe({
        next: async (value) => {
          if (value === "EOSE") return;
          const events: NostrEvent[] = Array.isArray(value) ? value : [value];
          await this.processEvents(groupIdHex, group, events, seenEventIds);
        },
        error: (err) => {
          console.error(
            `[GroupSubscriptionManager] Subscription error for group ${groupIdHex}:`,
            err,
          );
        },
        complete: () => {
          console.debug(
            `[GroupSubscriptionManager] Subscription completed for group ${groupIdHex}`,
          );
        },
      });

      this.groupSubscriptions.set(groupIdHex, {
        subscription,
        seenEventIds,
      });

      console.debug(
        `[GroupSubscriptionManager] Started subscription for group ${groupIdHex} on relays:`,
        relays,
      );

      await this.fetchHistoricalEvents(groupIdHex, relays, group, seenEventIds);
    } catch (error) {
      console.error(
        `[GroupSubscriptionManager] Failed to subscribe to group ${groupIdHex}:`,
        error,
      );
    }
  }

  private unsubscribeFromGroup(groupIdHex: string): void {
    const sub = this.groupSubscriptions.get(groupIdHex);
    if (!sub) return;

    sub.subscription.unsubscribe();
    this.groupSubscriptions.delete(groupIdHex);
    console.debug(
      `[GroupSubscriptionManager] Stopped subscription for group ${groupIdHex}`,
    );
  }

  private async processEvents(
    groupIdHex: string,
    group: MarmotGroup,
    events: NostrEvent[],
    seenEventIds: Set<string>,
  ): Promise<void> {
    if (events.length === 0) return;

    const newEvents = events.filter((e) => !seenEventIds.has(e.id));
    if (newEvents.length === 0) return;
    newEvents.forEach((e) => seenEventIds.add(e.id));

    try {
      const newMessages: Rumor[] = [];

      for await (const result of group.ingest(newEvents)) {
        if (result.kind === "applicationMessage") {
          try {
            const rumor = deserializeApplicationRumor(result.message);
            newMessages.push(rumor);
          } catch (parseErr) {
            console.error(
              "[GroupSubscriptionManager] Failed to parse application message:",
              parseErr,
            );
          }
        }
      }

      if (newMessages.length > 0) {
        // Update in-memory message buffer
        const prev = this.messageBufferByGroup.get(groupIdHex) ?? [];
        const mapById = new Map<string, Rumor>();
        for (const m of prev) mapById.set(m.id, m);
        for (const m of newMessages) mapById.set(m.id, m);
        const merged = Array.from(mapById.values()).sort(
          (a, b) => a.created_at - b.created_at,
        );
        // Keep it small and predictable
        const capped = merged.slice(-200);
        this.messageBufferByGroup.set(groupIdHex, capped);

        const newest = newMessages.reduce(
          (acc, m) => Math.max(acc, m.created_at),
          0,
        );
        const prevNewest = this.lastMessageAtByGroup.get(groupIdHex) ?? 0;
        if (newest > prevNewest) {
          this.lastMessageAtByGroup.set(groupIdHex, newest);
          this.recomputeUnreadGroupIds();
        }

        const callback = this.applicationMessageCallbacks.get(groupIdHex);
        callback?.(newMessages);
      }
    } catch (err) {
      console.error(
        `[GroupSubscriptionManager] Failed to process events for group ${groupIdHex}:`,
        err,
      );
    }
  }

  private async fetchHistoricalEvents(
    groupIdHex: string,
    relays: string[],
    group: MarmotGroup,
    seenEventIds: Set<string>,
  ): Promise<void> {
    try {
      const filters = {
        kinds: [GROUP_EVENT_KIND],
        "#h": [groupIdHex],
      };

      const events = await this.client.network.request(relays, filters);
      if (events.length === 0) return;

      console.debug(
        `[GroupSubscriptionManager] Fetched ${events.length} historical events for group ${groupIdHex}`,
      );

      await this.processEvents(groupIdHex, group, events, seenEventIds);
    } catch (error) {
      console.error(
        `[GroupSubscriptionManager] Failed to fetch historical events for group ${groupIdHex}:`,
        error,
      );
    }
  }

  private storageKey(groupIdHex: string): string {
    return `marmot:last-seen:${groupIdHex}`;
  }

  private loadLastSeenFromStorage(): void {
    try {
      // We don't know group ids yet at this stage; load lazily in recompute.
      // This is intentionally best-effort.
    } catch {
      // ignore
    }
  }

  private persistLastSeenToStorage(groupIdHex: string, seenAt: number): void {
    try {
      localStorage.setItem(this.storageKey(groupIdHex), String(seenAt));
    } catch {
      // ignore
    }
  }

  private getLastSeenFromStorage(groupIdHex: string): number {
    try {
      const raw = localStorage.getItem(this.storageKey(groupIdHex));
      if (!raw) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    } catch {
      return 0;
    }
  }

  private recomputeUnreadGroupIds(): void {
    const unread: string[] = [];
    for (const groupIdHex of this.groupSubscriptions.keys()) {
      const lastMsg = this.lastMessageAtByGroup.get(groupIdHex) ?? 0;

      let lastSeen = this.lastSeenAtByGroup.get(groupIdHex);
      if (lastSeen === undefined) {
        lastSeen = this.getLastSeenFromStorage(groupIdHex);
        this.lastSeenAtByGroup.set(groupIdHex, lastSeen);
      }

      if (lastMsg > lastSeen) unread.push(groupIdHex);
    }

    // Keep stable ordering for UI.
    unread.sort();
    this.unreadGroupIds$.next(unread);
  }
}
