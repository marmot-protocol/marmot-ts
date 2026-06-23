import type { NostrEvent } from "applesauce-core/helpers/event";
import { npubEncode } from "applesauce-core/helpers/pointers";
import type { EventStore } from "applesauce-core/event-store";

import type {
  ForkTreeNodeView,
  GroupRumorHistory,
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
import { getCredentialPubkey } from "@internet-privacy/marmot-ts/core";
import {
  contentTypes,
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  selfRemoveProposalType,
  wireformats,
} from "@internet-privacy/marmot-ts/mls";
import type {
  ClientState,
  LeafIndex,
  ProposalOrRef,
} from "@internet-privacy/marmot-ts/mls";

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

/**
 * Where an application message was decrypted: the MLS epoch number and the
 * fork-tree node tag (hex of the state's confirmation tag) of the exact state it
 * decrypted at. The tag pins the message to a single branch — two same-epoch
 * forks have distinct tags — so the UI can attribute messages per fork, not just
 * per epoch number.
 */
export interface MessageMeta {
  /** MLS epoch the message decrypted at. */
  epoch: number;
  /** Fork-tree node tag (hex confirmation tag), or `""` for legacy rows. */
  tag: string;
}

/** A single proposal carried by a commit, summarized for the debugger UI. */
export interface ProposalSummary {
  /** Human label: `add`, `remove`, `update`, `self_remove`, `by reference`, … */
  type: string;
  /** True when the commit referenced a previously-published proposal by hash. */
  byReference: boolean;
  /** A resolvable target pubkey (added/removed/updated member), when known. */
  pubkey?: string;
  /** Extra free-text detail (leaf index, reference hash prefix, …). */
  detail?: string;
}

/** Commit-level detail for one fork-tree node (epoch), for the per-epoch page. */
export interface EpochDetail {
  /** The fork-tree node, or `undefined` if the tag is unknown to this group. */
  node?: ForkTreeNodeView;
  /** The committer's MLS leaf index in the parent epoch, when known. */
  committerLeaf?: number;
  /** The committer's nostr pubkey, resolved from the parent epoch's roster. */
  committerPubkey?: string;
  /** The proposals the commit applied (empty for a bare self-update commit). */
  proposals: ProposalSummary[];
  /** Whether the commit message was available and decoded (public-message). */
  commitDecoded: boolean;
}

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
  /** Sidecar index of where (epoch + fork node) each app message decrypted. */
  metaStore: GenericKeyValueStore<MessageMeta>;
  /** Durable archive of raw kind-445 events, keyed `${groupHex}:${eventId}`. */
  eventArchive: GenericKeyValueStore<NostrEvent>;
  /**
   * Optional inactivity TTL in hours. When set (> 0), groups idle for at least
   * this long are periodically purged from local storage. Unset = retain forever.
   */
  groupTtlHours?: number;
  /** Teardown hook (closes the SQLite connection). */
  dispose?: () => void;
}

/** How often the inactivity sweep runs (capped to the TTL for short TTLs). */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

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
  readonly #metaStore: GenericKeyValueStore<MessageMeta>;
  readonly #eventArchive: GenericKeyValueStore<NostrEvent>;
  readonly #groupTtlHours?: number;
  readonly #dispose?: () => void;

  readonly #groups = new Map<string, MarmotGroup>();
  /** Newest kind-445 `created_at` (unix seconds) seen per group — its activity. */
  readonly #lastActive = new Map<string, number>();
  /** Live kind-445 subscriptions, one per followed group. */
  readonly #connections = new Map<string, Unsubscribable>();
  /** Invite rumor ids we've already attempted, so we don't re-join on re-yield. */
  readonly #handledInvites = new Set<string>();
  /** Profile-name cache for member pubkeys (kind 0), populated lazily. */
  readonly #names = new Map<string, string>();
  /** In-memory mirror of the message-meta index, keyed `${groupHex}:${rumorId}`. */
  readonly #metaCache = new Map<string, MessageMeta>();

  #stopped = false;
  #inviteConnection?: Unsubscribable;
  #sweepTimer?: ReturnType<typeof setInterval>;

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
    this.#metaStore = options.metaStore;
    this.#eventArchive = options.eventArchive;
    this.#groupTtlHours = options.groupTtlHours;
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

    if (this.#groupTtlHours) {
      log("inactivity TTL: purging groups idle for > %dh", this.#groupTtlHours);
      // Sweep no less often than the TTL itself, so a short TTL still fires.
      const every = Math.min(
        SWEEP_INTERVAL_MS,
        this.#groupTtlHours * 3_600_000,
      );
      this.#sweepTimer = setInterval(() => void this.#sweepExpired(), every);
      this.#sweepTimer.unref?.();
    }

    log("ready as %s on %o", this.npub, this.#relays);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
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
   * The newest kind-445 event `created_at` (unix seconds) seen for a group — its
   * "last active" time across all activity (commits + messages + proposals), or
   * `0` if nothing has been ingested for it yet. Used to order the group list
   * (most-recently-active first) and to drive inactivity expiry.
   */
  lastActive(idStr: string): number {
    return this.#lastActive.get(idStr) ?? 0;
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
    this.#lastActive.delete(idStr);
    this.#connections.get(idStr)?.unsubscribe();
    this.#connections.delete(idStr);
  }

  /**
   * Purge groups with no kind-445 activity within the configured TTL. A group is
   * only eligible once it has a recorded last-active time (> 0), so groups whose
   * archive replay is still in flight on startup are never purged prematurely.
   */
  async #sweepExpired(): Promise<void> {
    if (this.#stopped || !this.#groupTtlHours) return;
    const cutoff = Math.floor(Date.now() / 1000) - this.#groupTtlHours * 3600;
    const stale = [...this.#groups.keys()].filter((id) => {
      const seen = this.#lastActive.get(id);
      return seen !== undefined && seen < cutoff;
    });
    for (const id of stale) {
      log(
        "purging idle group %s (last active %s)",
        id.slice(0, 8),
        this.#lastActive.get(id),
      );
      await this.#purgeGroup(id);
    }
  }

  /**
   * Remove every trace of a group from local storage. `client.groups.destroy`
   * purges the library-owned state (group state, rewind history, rumor history)
   * *without publishing anything* — so the passive-observer contract holds — and
   * its `destroyed` event drives `#untrack` via the watch loop. We then clear the
   * tunnels-owned sidecars the library doesn't know about: the raw-event archive
   * and the message-meta index, both keyed `${groupHex}:`.
   */
  async #purgeGroup(idStr: string): Promise<void> {
    try {
      await this.#client.groups.destroy(idStr);
    } catch (err) {
      log("purge: destroy failed for %s: %O", idStr, err);
      return; // leave the sidecars intact so a retry can finish the job
    }
    this.#untrack(idStr);
    await this.#clearPrefixed(this.#eventArchive, `${idStr}:`);
    await this.#clearPrefixed(this.#metaStore, `${idStr}:`);
    for (const key of [...this.#metaCache.keys()]) {
      if (key.startsWith(`${idStr}:`)) this.#metaCache.delete(key);
    }
  }

  /** Remove every row in a store whose key starts with `prefix`. */
  async #clearPrefixed(
    store: GenericKeyValueStore<unknown>,
    prefix: string,
  ): Promise<void> {
    const keys = (await store.keys()).filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => store.removeItem(key).catch(() => {})));
  }

  /**
   * Subscribe a group to its kind-445 events (backfill, then live) and drain
   * ingest ourselves, recording where every application message decrypted so the
   * UI can place it on its fork node (the stored rumor carries no epoch/tag).
   *
   * `processed` application messages are on the selected (canonical) branch — the
   * library already persists their rumor, so we only record their meta. The
   * engine also surfaces messages that decrypt **only on a losing/non-canonical
   * branch** as `invalidated`, each now carrying the fork node (`tag`/`epoch`) it
   * decrypted against; the library does *not* store those, so we persist the
   * rumor ourselves and record its meta. Together they give the full fork view.
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
    const history = group.history as unknown as GroupRumorHistory | undefined;
    const drain = async (events: NostrEvent[]): Promise<void> => {
      const fresh = events.filter((event) => !seen.has(event.id));
      for (const event of fresh) seen.add(event.id);
      if (!fresh.length) return;
      // Archive every event before processing it, so the durable store is a
      // superset of whatever relays still serve (idempotent upsert by id), and
      // advance the group's last-active time from the newest event seen.
      let newest = this.#lastActive.get(group.idStr) ?? 0;
      for (const event of fresh) {
        void this.#eventArchive
          .setItem(`${group.idStr}:${event.id}`, event)
          .catch(() => {});
        if (event.created_at > newest) newest = event.created_at;
      }
      this.#lastActive.set(group.idStr, newest);
      try {
        for await (const result of group.ingest(fresh)) {
          if (
            result.kind === "processed" &&
            result.result.kind === "applicationMessage"
          ) {
            const state = result.result.newState;
            this.#recordMessageMeta(group.idStr, result.result.message, {
              epoch: Number(state.groupContext.epoch),
              // An application message never changes group state, so newState's
              // confirmation tag is the fork-tree node it decrypted at.
              tag: Buffer.from(state.confirmationTag).toString("hex"),
            });
          } else if (
            result.kind === "invalidated" &&
            result.payload !== undefined &&
            result.tag !== undefined &&
            result.epoch !== undefined
          ) {
            // Decrypted only on a losing branch — the library never stores it, so
            // save the rumor ourselves and pin it to the fork node it belongs to.
            try {
              const rumor = deserializeApplicationData(result.payload);
              await history?.saveRumor(rumor);
              this.#recordMessageMeta(group.idStr, result.payload, {
                epoch: result.epoch,
                tag: result.tag,
              });
            } catch {
              // not a NIP-59 rumor payload (or history unavailable) — skip
            }
          }
        }
      } catch (err) {
        log("connect: ingest failed for %s: %O", group.idStr, err);
      }
    };

    // Register the live subscription first (so nothing is missed), then drain in
    // two batches: our durable event archive — so the full history survives even
    // if relays have pruned it — then a relay backfill for anything new since the
    // last run. Both batches share `seen`, so an event in both is processed once.
    const sub = this.#pool
      .subscription(relays, filter)
      .subscribe({ next: (event) => void drain([event]) });
    this.#connections.set(group.idStr, sub);
    if (this.#stopped) {
      sub.unsubscribe();
      this.#connections.delete(group.idStr);
      return;
    }
    await drain(await this.#loadArchivedEvents(group.idStr));
    await drain(await this.#pool.request(relays, filter));
  }

  /**
   * Every kind-445 event previously archived for a group, newest first (so a
   * replay resolves the same way a fresh backfill would). Reads the durable
   * `events` store, which is a superset of whatever relays still serve.
   */
  async #loadArchivedEvents(groupIdStr: string): Promise<NostrEvent[]> {
    const prefix = `${groupIdStr}:`;
    const keys = (await this.#eventArchive.keys()).filter((key) =>
      key.startsWith(prefix),
    );
    const events = await Promise.all(
      keys.map((key) => this.#eventArchive.getItem(key)),
    );
    return events
      .filter((event): event is NostrEvent => event != null)
      .sort((a, b) => b.created_at - a.created_at);
  }

  /**
   * Persist where an application message decrypted (epoch + fork node), keyed by
   * its rumor id. The payload is the raw application data; deserializing it
   * yields the same rumor id the history store keys by, so the UI can join them.
   */
  #recordMessageMeta(
    groupIdStr: string,
    payload: Uint8Array,
    meta: MessageMeta,
  ): void {
    let rumorId: string;
    try {
      rumorId = deserializeApplicationData(payload).id;
    } catch {
      return; // not a rumor payload (e.g. a non-NIP-59 application message)
    }
    const key = `${groupIdStr}:${rumorId}`;
    const prev = this.#metaCache.get(key);
    if (prev && prev.epoch === meta.epoch && prev.tag === meta.tag) return;
    this.#metaCache.set(key, meta);
    void this.#metaStore.setItem(key, meta).catch(() => {});
  }

  /**
   * Where each of `rumorIds` decrypted (epoch + fork node tag), for one group.
   * Reads the in-memory mirror first, falling back to the persisted index for
   * messages captured in an earlier run. Legacy rows that stored a bare epoch
   * number are normalized to a tagless {@link MessageMeta}.
   */
  async messageMetaFor(
    groupIdStr: string,
    rumorIds: string[],
  ): Promise<Record<string, MessageMeta>> {
    const out: Record<string, MessageMeta> = {};
    await Promise.all(
      rumorIds.map(async (id) => {
        const key = `${groupIdStr}:${id}`;
        let meta = this.#metaCache.get(key);
        if (!meta) {
          const stored = await this.#metaStore.getItem(key);
          if (stored != null) meta = normalizeMeta(stored);
        }
        if (meta) {
          this.#metaCache.set(key, meta);
          out[id] = meta;
        }
      }),
    );
    return out;
  }

  /**
   * Resolve commit-level detail for one fork-tree node (epoch): who created the
   * commit and which proposals it applied. The committer leaf and any removed
   * leaf are resolved against the *parent* epoch's roster (the tree the commit
   * was applied to). Best-effort — anything undecodable is simply omitted.
   */
  async epochDetail(group: MarmotGroup, tag: string): Promise<EpochDetail> {
    const node = group.forkTreeView().nodes.find((n) => n.tag === tag);
    if (!node) return { proposals: [], commitDecoded: false };

    let parentState: ClientState | undefined;
    if (node.parentTag) {
      try {
        parentState = await group.forkTree.stateAt(node.parentTag);
      } catch {
        parentState = undefined;
      }
    }

    const committerLeaf = node.commit?.senderLeafIndex;
    const committerPubkey =
      committerLeaf !== undefined && parentState
        ? leafPubkey(parentState, committerLeaf)
        : undefined;

    const proposals: ProposalSummary[] = [];
    let commitDecoded = false;
    try {
      const message = await group.forkTree.commitMessageOf(tag);
      if (
        message?.wireformat === wireformats.mls_public_message &&
        message.publicMessage.content.contentType === contentTypes.commit
      ) {
        commitDecoded = true;
        for (const por of message.publicMessage.content.commit.proposals)
          proposals.push(summarizeProposal(por, parentState));
      }
    } catch {
      // commit bytes unavailable (e.g. root) or undecodable — leave empty.
    }

    return { node, committerLeaf, committerPubkey, proposals, commitDecoded };
  }

  /**
   * Resolve the committer pubkey for each of `tags` (fork-tree nodes), keyed by
   * tag. Each is read from the *parent* epoch's roster (the tree the commit was
   * applied to) at the commit's sender leaf — the same resolution
   * {@link epochDetail} does, but committer-only and batched, so the timeline can
   * label every stop's commit without decoding proposals. Root nodes (no commit)
   * and anything undecodable are simply omitted.
   */
  async committersByTag(
    group: MarmotGroup,
    tags: string[],
  ): Promise<Record<string, string>> {
    const nodes = group.forkTreeView().nodes;
    const byTag = new Map(nodes.map((n) => [n.tag, n]));
    const out: Record<string, string> = {};
    await Promise.all(
      [...new Set(tags)].map(async (tag) => {
        const node = byTag.get(tag);
        const leaf = node?.commit?.senderLeafIndex;
        if (!node?.parentTag || leaf === undefined) return;
        try {
          const parentState = await group.forkTree.stateAt(node.parentTag);
          const pubkey = parentState && leafPubkey(parentState, leaf);
          if (pubkey) out[tag] = pubkey;
        } catch {
          // parent state unavailable or undecodable — omit this committer.
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

/** Coerce a stored value (legacy bare epoch number or object) to MessageMeta. */
function normalizeMeta(stored: MessageMeta | number): MessageMeta {
  return typeof stored === "number" ? { epoch: stored, tag: "" } : stored;
}

/** The nostr pubkey at `leafIndex` in a state's ratchet tree, or undefined. */
function leafPubkey(state: ClientState, leafIndex: number): string | undefined {
  try {
    return getCredentialPubkey(
      getCredentialFromLeafIndex(state.ratchetTree, leafIndex as LeafIndex),
    );
  } catch {
    return undefined;
  }
}

/** Summarize one proposal (inline or by-reference) carried by a commit. */
function summarizeProposal(
  por: ProposalOrRef,
  parentState: ClientState | undefined,
): ProposalSummary {
  if ("reference" in por) {
    return {
      type: "by reference",
      byReference: true,
      detail: Buffer.from(por.reference).toString("hex").slice(0, 16),
    };
  }
  // Narrow with the `in` operator: a value switch on `proposalType` can't
  // exclude ProposalCustom (its `proposalType` is a plain `number`).
  const p = por.proposal;
  if ("add" in p) {
    let pubkey: string | undefined;
    try {
      pubkey = getCredentialPubkey(p.add.keyPackage.leafNode.credential);
    } catch {
      pubkey = undefined;
    }
    return { type: "add", byReference: false, pubkey };
  }
  if ("remove" in p) {
    return {
      type: "remove",
      byReference: false,
      pubkey: parentState
        ? leafPubkey(parentState, p.remove.removed)
        : undefined,
      detail: `leaf ${p.remove.removed}`,
    };
  }
  if ("update" in p) {
    let pubkey: string | undefined;
    try {
      pubkey = getCredentialPubkey(p.update.leafNode.credential);
    } catch {
      pubkey = undefined;
    }
    return { type: "update", byReference: false, pubkey };
  }
  return { type: proposalTypeName(p.proposalType), byReference: false };
}

/** A human label for a keyless / custom proposal type value. */
function proposalTypeName(type: number): string {
  switch (type) {
    case defaultProposalTypes.psk:
      return "psk";
    case defaultProposalTypes.reinit:
      return "reinit";
    case defaultProposalTypes.external_init:
      return "external_init";
    case defaultProposalTypes.group_context_extensions:
      return "group_context_extensions";
    case selfRemoveProposalType:
      return "self_remove";
    default:
      return `type ${type}`;
  }
}

function npubShort(pubkey: string): string {
  try {
    const npub = npubEncode(pubkey);
    return `${npub.slice(0, 10)}…${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}
