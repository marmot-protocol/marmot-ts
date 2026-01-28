import localforage from "localforage";
import { BehaviorSubject, firstValueFrom, of, Subscription } from "rxjs";
import { catchError, map, timeout } from "rxjs/operators";

import { EventSigner, mapEventsToTimeline } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers";
import { relaySet } from "applesauce-core/helpers";
import { castUser } from "applesauce-common/casts/user";
import { Rumor, unlockGiftWrap } from "applesauce-common/helpers";

import { getWelcome, WELCOME_EVENT_KIND } from "marmot-ts";

import { extraRelays$ } from "@/lib/settings";
import { eventStore, pool } from "@/lib/nostr";

export type PendingInvite = {
  id: string; // giftWrapEvent.id
  giftWrapEvent: NostrEvent;
  welcomeRumor: Rumor; // kind 444
  receivedAt: number; // giftWrapEvent.created_at
  relays: string[]; // from welcome tags
  keyPackageEventId?: string; // from welcome "e" tag
  cipherSuite?: string; // best-effort decode via getWelcome()
  status: "pending" | "accepted" | "archived";
};

type InvitationInboxManagerOptions = {
  signer: EventSigner;
};

function getInviteRelaysFromWelcome(rumor: Rumor): string[] {
  return rumor.tags.filter((t) => t[0] === "relays").flatMap((t) => t.slice(1));
}

function getKeyPackageEventIdFromWelcome(rumor: Rumor): string | undefined {
  return rumor.tags.find((t) => t[0] === "e")?.[1];
}

function decodeCipherSuite(rumor: Rumor): string | undefined {
  try {
    return getWelcome(rumor).cipherSuite;
  } catch {
    return undefined;
  }
}

function inviteStore(pubkey: string) {
  return localforage.createInstance({
    name: "marmot-invites",
    storeName: pubkey || "anon",
  });
}

/**
 * Background inbox manager for NIP-59 gift wraps (kind 1059).
 *
 * It attempts to unwrap each gift wrap for the active signer and stores any
 * contained Welcome rumors (kind 444) as pending invites.
 */
export class InvitationInboxManager {
  readonly invites$ = new BehaviorSubject<PendingInvite[]>([]);
  readonly unreadCount$ = new BehaviorSubject<number>(0);

  private readonly signer: InvitationInboxManagerOptions["signer"];
  private isActive = false;
  private seenGiftWrapIds = new Set<string>();
  private pubkey: string | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private relaySubscription: Subscription | null = null;
  private relays: string[] = [];
  private giftWrapSub: Subscription | null = null;

  constructor({ signer }: InvitationInboxManagerOptions) {
    this.signer = signer;
  }

  async start(): Promise<void> {
    if (this.isActive) return;
    this.isActive = true;

    this.pubkey = await this.signer.getPublicKey();
    await this.loadFromStorage();

    // Track relay set (inboxes + extra relays) and keep a live subscription.
    this.setupRelayTracking();

    await this.refresh();

    // Keep the inbox updated while signed in.
    // This is a simple polling loop; can be replaced by push subscriptions later.
    this.startPolling();
  }

  stop(): void {
    this.isActive = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.relaySubscription?.unsubscribe();
    this.relaySubscription = null;

    this.giftWrapSub?.unsubscribe();
    this.giftWrapSub = null;

    this.seenGiftWrapIds.clear();
    this.invites$.next([]);
    this.unreadCount$.next(0);
    this.pubkey = null;
    this.relays = [];
  }

  /**
   * Best-effort refresh: requests recent gift wraps (kind 1059) and processes them.
   */
  async refresh(): Promise<void> {
    if (!this.isActive) return;
    if (!this.pubkey) return;

    const relays =
      this.relays.length > 0 ? this.relays : relaySet([], extraRelays$.value);

    const events = await firstValueFrom(
      pool
        .request(relays, {
          kinds: [1059],
          "#p": [this.pubkey],
          limit: 50,
        })
        .pipe(
          mapEventsToTimeline(),
          map((timeline) => [...timeline]),
          timeout({ first: 10_000 }),
          catchError(() => of([] as NostrEvent[])),
        ),
    );

    await this.processGiftWrapEvents(events);
  }

  /**
   * Subscribe to incoming gift wraps (kind 1059) targeted at the active pubkey.
   *
   * This is the "live" path. `refresh()` remains as a best-effort historical catch-up.
   */
  private setupRelayTracking(): void {
    if (!this.pubkey) return;

    const user = castUser(this.pubkey, eventStore);

    // When relay config changes, restart the subscription.
    // NOTE: `extraRelays$` isn't an Observable chain here, so we just poll it via startPolling().
    this.relaySubscription = user.inboxes$.subscribe((inboxes) => {
      const next = relaySet(inboxes, extraRelays$.value);
      const same =
        next.length === this.relays.length &&
        next.every((r, i) => r === this.relays[i]);
      if (same) return;

      this.relays = next;
      this.restartGiftWrapSubscription();
    });

    // Initialize from the first inboxes emission.
  }

  private restartGiftWrapSubscription(): void {
    if (!this.isActive) return;
    if (!this.pubkey) return;

    // Stop previous subscription
    this.giftWrapSub?.unsubscribe();

    if (this.relays.length === 0) return;

    const sub = pool.subscription(this.relays, {
      kinds: [1059],
      "#p": [this.pubkey],
    });

    this.giftWrapSub = sub.subscribe({
      next: async (value) => {
        if (!this.isActive) return;
        if (value === "EOSE") return;
        const events: NostrEvent[] = Array.isArray(value) ? value : [value];
        await this.processGiftWrapEvents(events);
      },
      error: (err) => {
        console.debug("[InvitationInboxManager] subscription error", err);
      },
    });
  }

  private startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
      // fire-and-forget
      this.refresh().catch(() => {
        // ignore
      });
    }, 5_000);
  }

  async setInviteStatus(
    id: string,
    status: PendingInvite["status"],
  ): Promise<void> {
    if (!this.pubkey) return;

    const updated = this.invites$.value.map((inv) =>
      inv.id === id ? { ...inv, status } : inv,
    );
    this.invites$.next(updated);
    this.unreadCount$.next(
      updated.filter((i) => i.status === "pending").length,
    );
    await this.persistToStorage(updated);
  }

  private async loadFromStorage(): Promise<void> {
    if (!this.pubkey) return;

    try {
      const store = inviteStore(this.pubkey);
      const invites = (await store.getItem<PendingInvite[]>("invites")) ?? [];
      this.invites$.next(invites);
      this.unreadCount$.next(
        invites.filter((i) => i.status === "pending").length,
      );
      invites.forEach((i) => this.seenGiftWrapIds.add(i.id));
    } catch {
      // Silent failure (storage may be unavailable)
      this.invites$.next([]);
      this.unreadCount$.next(0);
    }
  }

  private async persistToStorage(invites: PendingInvite[]): Promise<void> {
    if (!this.pubkey) return;

    try {
      const store = inviteStore(this.pubkey);
      await store.setItem("invites", invites);
    } catch {
      // Silent failure
    }
  }

  private async processGiftWrapEvents(events: NostrEvent[]): Promise<void> {
    if (!this.isActive) return;
    if (!this.pubkey) return;

    const current = this.invites$.value;
    const nextInvites: PendingInvite[] = [...current];
    let changed = false;

    for (const giftWrapEvent of events) {
      if (this.seenGiftWrapIds.has(giftWrapEvent.id)) continue;

      try {
        const rumor = await unlockGiftWrap(giftWrapEvent, this.signer as any);
        if (rumor.kind !== WELCOME_EVENT_KIND) continue;

        const invite: PendingInvite = {
          id: giftWrapEvent.id,
          giftWrapEvent,
          welcomeRumor: rumor,
          receivedAt: giftWrapEvent.created_at,
          relays: getInviteRelaysFromWelcome(rumor),
          keyPackageEventId: getKeyPackageEventIdFromWelcome(rumor),
          cipherSuite: decodeCipherSuite(rumor),
          status: "pending",
        };

        nextInvites.push(invite);
        this.seenGiftWrapIds.add(giftWrapEvent.id);
        changed = true;
      } catch {
        // Not for us or invalid: ignore
      }
    }

    if (!changed) return;

    // Sort newest first
    nextInvites.sort((a, b) => b.receivedAt - a.receivedAt);

    this.invites$.next(nextInvites);
    // pending = unread
    this.unreadCount$.next(
      nextInvites.filter((i) => i.status === "pending").length,
    );
    await this.persistToStorage(nextInvites);
  }
}
