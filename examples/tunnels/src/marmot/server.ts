import type { NostrEvent } from "applesauce-core/helpers/event";
import { npubEncode } from "applesauce-core/helpers/pointers";
import type { EventStore } from "applesauce-core/event-store";

import type {
  MarmotClient,
  MarmotGroup,
  Unsubscribable,
} from "@internet-privacy/marmot-ts/client";
import {
  createInboxRelayListEvent,
  createNip65RelayListEvent,
  deserializeApplicationData,
  GROUP_EVENT_KIND,
} from "@internet-privacy/marmot-ts";
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts/utils";

import createDebug from "debug";

import type { Directory } from "../helpers/discovery.js";
import type { RelayPool } from "../helpers/relay-pool.js";

const log = createDebug("tunnels:server");

/** The kind-0 display name the server publishes so peers can recognise it. */
const PROFILE_NAME = "tunnels — group history debugger";

/** Minimal signer shape (applesauce `EventSigner`) the server needs. */
type Signer = {
  getPublicKey(): Promise<string> | string;
  signEvent(draft: any): Promise<NostrEvent> | NostrEvent;
};

export interface TunnelServerOptions {
  client: MarmotClient;
  pool: RelayPool;
  directory: Directory;
  eventStore: EventStore;
  signer: Signer;
  pubkey: string;
  /** NIP-65 outbox relays (kind 10002): profile, relay lists, KeyPackage. */
  outboxRelays: string[];
  /** Welcome-inbox relays (kind 10050): where invites are watched + delivered. */
  inboxRelays: string[];
  /** Sidecar index of the epoch each application message was decrypted at. */
  epochStore: GenericKeyValueStore<number>;
  /** Teardown hook (closes the SQLite connection). */
  dispose?: () => void;
}

/**
 * Headless driver for a passive, omniscient group observer. Unlike a chat
 * client it never sends, commits, or rotates leaves — it only listens. Its job
 * is to be invited into groups, follow every kind-445 event, and let the
 * {@link MarmotClient} (configured for infinite retention) record the full fork
 * history so the web UI can render it.
 *
 * The lifecycle: publish a discoverable identity + KeyPackage so peers can
 * invite us, restore + connect every known group, auto-accept every joinable
 * invite, and keep an up-to-date map of loaded groups for the HTTP layer.
 */
export class TunnelServer {
  readonly #client: MarmotClient;
  readonly #pool: RelayPool;
  readonly #directory: Directory;
  readonly #eventStore: EventStore;
  readonly #signer: Signer;
  readonly #pubkey: string;
  readonly #outboxRelays: string[];
  readonly #inboxRelays: string[];
  readonly #relays: string[];
  readonly #epochStore: GenericKeyValueStore<number>;
  readonly #dispose?: () => void;

  readonly #groups = new Map<string, MarmotGroup>();
  /** Live kind-445 subscriptions, one per followed group. */
  readonly #connections = new Map<string, Unsubscribable>();
  /** Invite rumor ids we've already attempted, so we don't re-join on re-yield. */
  readonly #handledInvites = new Set<string>();
  /** Profile-name cache for member pubkeys (kind 0), populated lazily. */
  readonly #names = new Map<string, string>();
  /** In-memory mirror of the epoch index, keyed `${groupHex}:${rumorId}`. */
  readonly #epochCache = new Map<string, number>();

  #stopped = false;
  #inviteConnection?: Unsubscribable;

  constructor(options: TunnelServerOptions) {
    this.#client = options.client;
    this.#pool = options.pool;
    this.#directory = options.directory;
    this.#eventStore = options.eventStore;
    this.#signer = options.signer;
    this.#pubkey = options.pubkey;
    this.#outboxRelays = options.outboxRelays;
    this.#inboxRelays = options.inboxRelays;
    this.#relays = [
      ...new Set([...options.outboxRelays, ...options.inboxRelays]),
    ];
    this.#epochStore = options.epochStore;
    this.#dispose = options.dispose;
  }

  get pubkey(): string {
    return this.#pubkey;
  }

  get npub(): string {
    return npubEncode(this.#pubkey);
  }

  get relays(): string[] {
    return this.#relays;
  }

  get outboxRelays(): string[] {
    return this.#outboxRelays;
  }

  get inboxRelays(): string[] {
    return this.#inboxRelays;
  }

  // --- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    await this.#publishIdentity();
    await this.#refreshKeyPackage();

    // #trackGroups follows the library's loaded-group set and connects each
    // group's kind-445 subscription (existing + future-joined), draining ingest
    // ourselves so we can capture the epoch each application message decrypts
    // at. invites.listen subscribes for gift-wraps on our inbox relays.
    this.#inviteConnection = await this.#client.invites.listen(
      this.#inboxRelays,
    );

    void this.#trackGroups();
    void this.#autoAcceptInvites();

    log("ready as %s on %o", this.npub, this.#relays);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#inviteConnection?.unsubscribe();
    for (const sub of this.#connections.values()) sub.unsubscribe();
    this.#connections.clear();
    this.#eventStore.dispose();
    this.#pool.close();
    this.#dispose?.();
  }

  // --- queries (consumed by the HTTP layer) ----------------------------------

  /** Every group the server is currently following, in load order. */
  groups(): MarmotGroup[] {
    return [...this.#groups.values()];
  }

  /** A single followed group by hex id, or undefined. */
  group(idStr: string): MarmotGroup | undefined {
    return this.#groups.get(idStr);
  }

  /**
   * A human label for a member pubkey: the cached kind-0 display name if known,
   * else a short npub. Triggers a background profile fetch (via the shared
   * event store loader) so a later render can show the name.
   */
  nameFor(pubkey: string): string {
    const cached = this.#names.get(pubkey);
    if (cached) return cached;
    void this.#directory
      .profile(pubkey, this.#relays)
      .then((profile) => {
        const name = profile?.name?.trim() || profile?.display_name?.trim();
        if (name) this.#names.set(pubkey, name);
      })
      .catch(() => {});
    return npubShort(pubkey);
  }

  // --- internals -------------------------------------------------------------

  /**
   * Publish a discoverable identity on every start: a kind-0 profile, a NIP-65
   * (kind 10002) outbox list advertising the outbox relays, and a kind-10050
   * inbox list advertising the inbox relays. All three are announced to the
   * outbox relays — where peers read them to discover the server's KeyPackage
   * and learn where to deliver a Welcome. Without these, the server can't be
   * invited.
   */
  async #publishIdentity(): Promise<void> {
    const profile = await this.#signer.signEvent({
      kind: 0,
      content: JSON.stringify({
        name: PROFILE_NAME,
        about:
          "Follows and decrypts the full fork history of every group it joins.",
      }),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    await this.#pool.publish(this.#outboxRelays, profile);
    this.#eventStore.add(profile);

    const outbox = await this.#signer.signEvent(
      createNip65RelayListEvent({
        pubkey: this.#pubkey,
        relays: this.#outboxRelays,
      }),
    );
    await this.#pool.publish(this.#outboxRelays, outbox);
    this.#eventStore.add(outbox);

    const inbox = await this.#signer.signEvent(
      createInboxRelayListEvent({
        pubkey: this.#pubkey,
        relays: this.#inboxRelays,
      }),
    );
    await this.#pool.publish(this.#outboxRelays, inbox);
    this.#eventStore.add(inbox);

    log(
      "published identity — outbox %o · inbox %o",
      this.#outboxRelays,
      this.#inboxRelays,
    );
  }

  /**
   * Publish a fresh KeyPackage to the outbox relays on every start: rotate the
   * current one if we already hold a KeyPackage (replacing the advertised
   * material so a relay restart or rotation can't strand us with a stale,
   * consumed package), otherwise create the first one. Either way a peer
   * fetching our outbox finds an unused KeyPackage to invite us with.
   */
  async #refreshKeyPackage(): Promise<void> {
    const list = await this.#client.keyPackages.list();
    const current =
      list.find((pkg) => !pkg.used && pkg.identifier === "tunnels") ??
      list.find((pkg) => !pkg.used) ??
      list[0];

    if (current) {
      const rotated = await this.#client.keyPackages.rotate(
        current.keyPackageRef,
        { relays: this.#outboxRelays },
      );
      log("rotated KeyPackage → %s", hex(rotated.keyPackageRef));
    } else {
      const created = await this.#client.keyPackages.create({
        relays: this.#outboxRelays,
      });
      log("created KeyPackage %s", hex(created.keyPackageRef));
    }
  }

  /**
   * Follow the library's loaded-group set (initial snapshot + every change) and
   * keep our subscriptions in lockstep: connect freshly-loaded/joined groups,
   * drop ones that left. This is the single source that connects both restored
   * groups (the initial yield is `loadAll()`) and newly-joined ones.
   */
  async #trackGroups(): Promise<void> {
    try {
      for await (const groups of this.#client.groups.watch()) {
        if (this.#stopped) break;
        const live = new Set(groups.map((g) => g.idStr));
        for (const group of groups) this.#track(group);
        for (const id of [...this.#groups.keys()]) {
          if (!live.has(id)) this.#untrack(id);
        }
      }
    } catch (err) {
      if (!this.#stopped) log("group tracking error: %O", err);
    }
  }

  #track(group: MarmotGroup): void {
    if (this.#groups.has(group.idStr)) return;
    this.#groups.set(group.idStr, group);
    log("following group %s (%s)", group.idStr.slice(0, 8), groupName(group));
    void this.#connect(group);
  }

  #untrack(idStr: string): void {
    this.#groups.delete(idStr);
    this.#connections.get(idStr)?.unsubscribe();
    this.#connections.delete(idStr);
  }

  /**
   * Subscribe a group to its kind-445 events (backfill, then live) and drain
   * ingest ourselves. Every processed application message carries the epoch it
   * decrypted at on its `newState`; we record that against the rumor id so the
   * UI can show it (the stored rumor itself has no epoch). Mirrors the library's
   * `connectAll` transport, but observes the per-message results it discards.
   */
  async #connect(group: MarmotGroup): Promise<void> {
    if (this.#connections.has(group.idStr) || this.#stopped) return;
    const groupIdHex = group.info.nostr.groupIdHex;
    const relays = group.relays?.length ? group.relays : this.#relays;
    if (!groupIdHex || !relays.length) {
      log("connect: group %s has no routing/relays — skipping", group.idStr);
      return;
    }
    const filter = { kinds: [GROUP_EVENT_KIND], "#h": [groupIdHex] };

    const seen = new Set<string>();
    const drain = async (events: NostrEvent[]): Promise<void> => {
      const fresh = events.filter((event) => !seen.has(event.id));
      for (const event of fresh) seen.add(event.id);
      if (!fresh.length) return;
      try {
        for await (const result of group.ingest(fresh)) {
          if (
            result.kind === "processed" &&
            result.result.kind === "applicationMessage"
          ) {
            this.#recordEpoch(
              group.idStr,
              result.result.message,
              Number(result.result.newState.groupContext.epoch),
            );
          }
        }
      } catch (err) {
        log("connect: ingest failed for %s: %O", group.idStr, err);
      }
    };

    // Backfill as one batch (so out-of-order commits resolve together), then go
    // live. Register the subscription before awaiting backfill so a concurrent
    // stop() can tear it down.
    const sub = this.#pool
      .subscription(relays, filter)
      .subscribe({ next: (event) => void drain([event]) });
    this.#connections.set(group.idStr, sub);
    if (this.#stopped) {
      sub.unsubscribe();
      this.#connections.delete(group.idStr);
      return;
    }
    await drain(await this.#pool.request(relays, filter));
  }

  /**
   * Persist the epoch an application message was decrypted at, keyed by its
   * rumor id. The payload is the raw application data; deserializing it yields
   * the same rumor id the history store keys by, so the UI can join them.
   */
  #recordEpoch(groupIdStr: string, payload: Uint8Array, epoch: number): void {
    let rumorId: string;
    try {
      rumorId = deserializeApplicationData(payload).id;
    } catch {
      return; // not a rumor payload (e.g. a non-NIP-59 application message)
    }
    const key = `${groupIdStr}:${rumorId}`;
    if (this.#epochCache.get(key) === epoch) return;
    this.#epochCache.set(key, epoch);
    void this.#epochStore.setItem(key, epoch).catch(() => {});
  }

  /**
   * The epoch each of `rumorIds` was decrypted at, for one group. Reads the
   * in-memory mirror first, falling back to the persisted index for messages
   * captured in an earlier run.
   */
  async epochsFor(
    groupIdStr: string,
    rumorIds: string[],
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    await Promise.all(
      rumorIds.map(async (id) => {
        const key = `${groupIdStr}:${id}`;
        const cached = this.#epochCache.get(key);
        const epoch =
          cached ?? (await this.#epochStore.getItem(key)) ?? undefined;
        if (epoch !== undefined && epoch !== null) {
          this.#epochCache.set(key, epoch);
          out[id] = epoch;
        }
      }),
    );
    return out;
  }

  /**
   * Auto-accept every joinable invite. The server is a passive observer, so it
   * joins from the Welcome but never performs the MIP-02 self-update — that
   * would push it onto its own fork and disturb the group it is here to watch.
   */
  async #autoAcceptInvites(): Promise<void> {
    try {
      for await (const entries of this.#client.watchInvites()) {
        if (this.#stopped) break;
        for (const entry of entries) {
          if (!entry.joinable) continue;
          if (this.#handledInvites.has(entry.invite.id)) continue;
          this.#handledInvites.add(entry.invite.id);
          await this.#join(entry.invite);
        }
      }
    } catch (err) {
      if (!this.#stopped) log("invite watch error: %O", err);
    }
  }

  async #join(invite: { id: string }): Promise<void> {
    try {
      const { group } = await this.#client.joinGroupFromWelcome({
        welcomeRumor: invite as any,
      });
      await this.#client.invites.markAsRead(invite.id);
      this.#track(group);
      log("joined group %s (%s)", group.idStr.slice(0, 8), groupName(group));
    } catch (err) {
      // Re-allow a retry on the next yield (e.g. KeyPackage not yet stored).
      this.#handledInvites.delete(invite.id);
      log("failed to join invite %s: %O", invite.id, err);
    }
  }
}

/** Best-effort group display name (falls back to a short hex id). */
export function groupName(group: MarmotGroup): string {
  const name =
    group.groupData?.name?.trim() || group.info.app.view?.name?.trim();
  return name || `group ${group.idStr.slice(0, 8)}`;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function npubShort(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}
