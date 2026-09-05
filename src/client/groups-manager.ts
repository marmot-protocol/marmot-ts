/** @module @category Client - Group Manager */
import { bytesToHex } from "@noble/hashes/utils.js";
import { EventSigner } from "applesauce-core";
import { hexToBytes, type NostrEvent } from "applesauce-core/helpers";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  joinGroup,
  Welcome,
} from "ts-mls";
import {
  getNostrGroupIdHex,
  SerializedClientState,
} from "../core/client-state.js";
import type { MarmotGroupInfo } from "../core/client-state.js";
import { GROUP_EVENT_KIND } from "../core/protocol.js";
import {
  type AccountIdentityProofSigner,
  verifyAllLeafAccountIdentityProofs,
} from "../core/account-identity-proof.js";
import { marmotAuthService } from "../core/auth-service.js";
import type { ConvergencePolicy } from "../core/convergence.js";
import type { IngestionPoolOptions } from "../engine/ingestion-pool.js";
import type { AuditContextOptions, AuditSink } from "../audit/index.js";
import { logger } from "../utils/debug.js";
import { hasAck } from "../utils/index.js";
import type { GenericKeyValueStore } from "../utils/key-value.js";
import type { IngestPersistenceCapability } from "./marmot-client.js";
import { getSingletonTagValue } from "../utils/tag-cardinality.js";
import {
  BaseGroupHistory,
  BaseGroupMedia,
  GroupHistoryFactory,
  GroupMediaFactory,
  MarmotGroup,
} from "./group/marmot-group.js";
import { createInviteIntent } from "./group/invite.js";
import type { WelcomeKeyPackageCandidate } from "./key-package-store.js";
import { GroupFactory, type CreateGroupOptions } from "./group-factory.js";
import { GroupRegistry } from "./group-registry.js";
import type { GroupRuntime } from "./runtime/group-runtime.js";
import type {
  GroupPublishResult,
  GroupSessionSendIntent,
} from "./session/group-effects.js";
import type {
  DispositionedIngestResult,
  GroupSession,
} from "./session/group-session.js";
import type {
  NostrNetworkInterface,
  PublishResponse,
  Unsubscribable,
} from "./nostr-interface.js";
import {
  defaultVerifyEvent,
  type RejectReason,
  safeVerifyEvent,
  type VerifyEventMethod,
} from "./verify.js";

const SUBSCRIPTION_ID_CACHE_CAPACITY = 10_000;

/** Deterministic bounded LRU used by long-lived group subscriptions. */
export class BoundedIdCache {
  readonly #ids = new Map<string, undefined>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("BoundedIdCache capacity must be a positive integer");
  }

  get size(): number {
    return this.#ids.size;
  }

  has(id: string): boolean {
    if (!this.#ids.delete(id)) return false;
    this.#ids.set(id, undefined);
    return true;
  }

  add(id: string): void {
    this.#ids.delete(id);
    this.#ids.set(id, undefined);
    if (this.#ids.size <= this.capacity) return;
    const oldest = this.#ids.keys().next().value;
    if (oldest !== undefined) this.#ids.delete(oldest);
  }
}

const log = logger.extend("GroupsManager");

/** Options for {@link GroupsManager.connect} / {@link GroupsManager.connectAll}. */
export interface ConnectOptions {
  /**
   * Relays to subscribe on when a group carries no relays of its own. A group
   * with neither its own relays nor a fallback is skipped (it cannot receive,
   * just as it cannot send).
   */
  fallbackRelays?: string[];
}

/** Options for creating a new GroupsManager */
export type GroupsManagerOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The backend storing serialized group state bytes */
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore: GenericKeyValueStore<Uint8Array>;
  ingestPersistence: IngestPersistenceCapability;
  /**
   * Dedicated backend for the per-group rewind-history blob. When provided, the
   * convergence rewind window is persisted and survives a restart. Optional.
   */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /**
   * Dedicated backend for the persisted removed-inactive marker (D-12), keyed
   * by the same group-id hex as {@link store}. When provided, the fact that an
   * involuntary removal has already been realized survives a restart, so the
   * `removed` event fires exactly once across process boundaries and a rewind
   * that supersedes the removal can clear it durably. Optional — when omitted,
   * realization degrades to in-memory-only (fires once per process, does not
   * survive a restart).
   */
  removedMarkerStore?: GenericKeyValueStore<boolean>;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /**
   * Signs the account identity proof carried on the group creator's own leaf.
   * Required for the creator to be addable to spec-conformant groups, which
   * validate the proof on every leaf.
   */
  accountProofSigner?: AccountIdentityProofSigner;
  /** The nostr relay pool to use for the client */
  network: NostrNetworkInterface;
  /** Optional forensic audit sink inherited by groups. Omitted by default. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  /** The crypto provider to use for cryptographic operations */
  cryptoProvider?: CryptoProvider;
  /** Optional group history factory passed to each MarmotGroup instance */
  historyFactory?: GroupHistoryFactory<THistory>;
  /** Optional group media factory passed to each MarmotGroup instance */
  mediaFactory?: GroupMediaFactory<TMedia>;
  /**
   * Convergence policy applied to every group (branch selection + the
   * `maxRewindCommits` rollback horizon). Set `maxRewindCommits: Infinity` to
   * keep forks of any age eligible for re-convergence. Defaults to profile 1.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Ingestion-pool tuning applied to every group: max entries and max epoch-age
   * for undecryptable events held for retry. Raise both for a debugging tool
   * that aims to retain and process everything.
   */
  ingestionPool?: IngestionPoolOptions;
  /**
   * Injectable Nostr event verifier gating the 445 `#connectGroup` drain
   * (SEC-01): every inbound group-message event is verified before it
   * reaches `group.ingest()`. Defaults to applesauce's `verifyEvent`.
   */
  verifyEvent?: VerifyEventMethod;
};

/** Events emitted by {@link GroupsManager} */
export type GroupsManagerEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the set of loaded groups changes */
  updated: (groups: MarmotGroup<THistory, TMedia>[]) => void;
  /** Emitted when a group is loaded from the store */
  loaded: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a new group is created */
  created: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is imported from a ClientState object */
  imported: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is joined */
  joined: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when a group is unloaded */
  unloaded: (groupId: Uint8Array) => void;
  /** Emitted when a group is destroyed */
  destroyed: (groupId: Uint8Array) => void;
  /** Emitted when the client leaves a group via self-remove proposal events */
  left: (groupId: Uint8Array) => void;
  /**
   * Emitted when an inbound commit removed the client from a group — an admin's
   * involuntary Remove, or a peer committing the client's own self_remove. The
   * group's local state is kept as a `removedFromGroup` tombstone; the app may
   * call {@link GroupsManager.destroy} to purge it.
   */
  removed: (groupId: Uint8Array) => void;
  /**
   * Emitted by a {@link GroupsManager.connect} subscription when a received
   * transport event could not be read (e.g. an epoch beyond the retained
   * rewind horizon). Lets the app surface dropped events instead of the
   * connection loop logging them.
   */
  unreadable: (groupId: Uint8Array, event: NostrEvent) => void;
  /**
   * Emitted by a {@link GroupsManager.connect} subscription when an inbound
   * kind-445 event is rejected at the trust boundary — before it ever
   * reaches `group.ingest()` — for an invalid signature or a malformed `h`
   * tag (SEC-01/WIRE-02).
   */
  rejected: (
    groupId: Uint8Array,
    event: NostrEvent,
    reason: RejectReason,
  ) => void;
};

/**
 * Orchestrates the lifecycle of {@link MarmotGroup} instances. Delegates
 * in-memory caching and store hydration to a {@link GroupRegistry} and group
 * construction to a {@link GroupFactory}, layering the public lifecycle events
 * (created/imported/joined/destroyed/left) and the send/ingest facade on top.
 */
export class GroupsManager<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> extends EventEmitter<GroupsManagerEvents<THistory, TMedia>> {
  /** The backend storing serialized group state bytes */
  readonly store: GenericKeyValueStore<SerializedClientState>;
  /** The signer used for the clients identity */
  readonly signer: EventSigner;
  /** Signs the account identity proof on the group creator's own leaf */
  readonly accountProofSigner?: AccountIdentityProofSigner;
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;
  readonly ingestPersistence: IngestPersistenceCapability;

  /** Owns the in-memory cache + store hydration. */
  readonly #registry: GroupRegistry<THistory, TMedia>;
  /** Builds new groups (the accountProofSigner/ciphersuite consumer). */
  readonly #factory: GroupFactory<THistory, TMedia>;
  /** The injectable event verifier gating the 445 drain (SEC-01). */
  readonly #verifyEvent: VerifyEventMethod;

  constructor(options: GroupsManagerOptions<THistory, TMedia>) {
    super();
    this.store = options.store;
    this.ingestPersistence = options.ingestPersistence;
    this.signer = options.signer;
    this.accountProofSigner = options.accountProofSigner;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;

    this.#registry = new GroupRegistry<THistory, TMedia>({
      store: options.store,
      ingestStateStore: options.ingestStateStore,
      rewindStore: options.rewindStore,
      removedMarkerStore: options.removedMarkerStore,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      signer: options.signer,
      network: options.network,
      audit: options.audit,
      auditContext: options.auditContext,
      cryptoProvider: this.cryptoProvider,
      historyFactory: options.historyFactory,
      mediaFactory: options.mediaFactory,
    });

    this.#factory = new GroupFactory<THistory, TMedia>({
      store: options.store,
      ingestStateStore: options.ingestStateStore,
      rewindStore: options.rewindStore,
      removedMarkerStore: options.removedMarkerStore,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      signer: options.signer,
      network: options.network,
      audit: options.audit,
      auditContext: options.auditContext,
      cryptoProvider: this.cryptoProvider,
      accountProofSigner: options.accountProofSigner,
      historyFactory: options.historyFactory,
      mediaFactory: options.mediaFactory,
    });

    // Forward the registry's cache-level events as our own.
    this.#registry.on("updated", (groups) => this.emit("updated", groups));
    this.#registry.on("loaded", (group) => this.emit("loaded", group));
    this.#registry.on("removed", (group) => this.emit("removed", group.id));
  }

  /** Returns the list of currently loaded group instances */
  get loaded(): MarmotGroup<THistory, TMedia>[] {
    return this.#registry.loaded;
  }

  /** Lists all persisted group IDs, decoded from their hex storage keys. */
  async listIds(): Promise<Uint8Array[]> {
    return this.#registry.listIds();
  }

  /** Checks if a group exists in the backend */
  async has(groupId: Uint8Array | string): Promise<boolean> {
    return this.#registry.has(groupId);
  }

  /** Gets a group from cache or loads it from store */
  async get(
    groupId: Uint8Array | string,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    return this.#registry.get(groupId);
  }

  /** Returns the protocol session for a loaded or persisted group. */
  async session(groupId: Uint8Array | string): Promise<GroupSession<THistory>> {
    return (await this.get(groupId)).session;
  }

  /** Returns the runtime publisher for a loaded or persisted group. */
  async runtime(groupId: Uint8Array | string): Promise<GroupRuntime> {
    return (await this.get(groupId)).runtime;
  }

  /** Returns the complete group info/debug model for a loaded or persisted group. */
  async info(groupId: Uint8Array | string): Promise<MarmotGroupInfo> {
    return (await this.get(groupId)).info;
  }

  /**
   * Sends a session intent through the group, convergence-gated (B5): published
   * immediately when convergence is `Settled`, otherwise queued until the
   * quiescence window settles and the queue drains. Used by `commit`/`invite`
   * and direct application-message sends; `leave` bypasses the gate.
   */
  async send(
    groupId: Uint8Array | string,
    intent: GroupSessionSendIntent,
  ): Promise<GroupPublishResult[]> {
    const group = await this.get(groupId);
    return group.submitIntent(intent);
  }

  /**
   * Invites a user to a group from their KeyPackage event (kind 30443).
   *
   * Resolves the committing member from the manager's signer, builds an Add
   * commit intent via {@link createInviteIntent} (gated on the same injected
   * verifier as the 445/1059/30443 inbound boundaries — SEC-01/WIRE-01/
   * WIRE-02), and drives it through the group session/runtime. After the
   * commit acks, the runtime delivers a Welcome to the invitee via NIP-59
   * gift wrap.
   *
   * @returns Per-relay publish responses for the commit group event.
   * @throws Error if the event is not a KeyPackage kind, fails signature
   *   verification, has invalid required-tag cardinality, has an over-long
   *   or not-current Lifetime, or the credential identity does not match
   *   the event author.
   */
  async invite(
    groupId: Uint8Array | string,
    keyPackageEvent: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    const actorPubkey = await this.signer.getPublicKey();
    const [result] = await this.send(
      groupId,
      createInviteIntent({
        keyPackageEvent,
        actorPubkey,
        verifyEvent: this.#verifyEvent,
      }),
    );
    return result.response;
  }

  /**
   * Creates a commit from proposals and publishes it to the group.
   *
   * Resolves the committing member from the manager's signer, builds a `commit`
   * intent, and drives it through the group session/runtime. See
   * {@link GroupSessionSendIntent} for how `extraProposals`, `proposalRefs`, and
   * `welcomeRecipients` are interpreted. Requires a group admin.
   *
   * @returns Per-relay publish responses for the commit group event.
   */
  async commit(
    groupId: Uint8Array | string,
    options?: Omit<
      Extract<GroupSessionSendIntent, { kind: "commit" }>,
      "kind" | "actorPubkey"
    >,
  ): Promise<Record<string, PublishResponse>> {
    const actorPubkey = await this.signer.getPublicKey();
    const [result] = await this.send(groupId, {
      kind: "commit",
      actorPubkey,
      extraProposals: options?.extraProposals,
      proposalRefs: options?.proposalRefs,
      welcomeRecipients: options?.welcomeRecipients,
    });
    return result.response;
  }

  /** Ingests group transport events through the group's protocol session. */
  async *ingest(
    groupId: Uint8Array | string,
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    const group = await this.get(groupId);
    // Route through the group facade (not the raw session) so an elected
    // self_remove auto-commit (B6) is published via the group's runtime.
    yield* group.ingest(events, options);
  }

  /** Loads all groups from the store and returns them */
  async loadAll(): Promise<MarmotGroup<THistory, TMedia>[]> {
    return this.#registry.loadAll();
  }

  /**
   * Connects a single group to its relays: backfills its kind-445 transport
   * events (by `#h` routing tag) and drains them through {@link MarmotGroup.ingest},
   * then opens a live subscription that ingests each subsequent event. Inbound
   * events are de-duplicated, and unreadable ones surface via the `unreadable`
   * event. Call `.unsubscribe()` on the result to disconnect.
   *
   * This is the inbound counterpart to the library's outbound publishing — the
   * relay-subscription/backfill/drain loop an app would otherwise hand-write.
   */
  async connect(
    groupId: Uint8Array | string,
    options?: ConnectOptions,
  ): Promise<Unsubscribable> {
    return this.#connectGroup(await this.get(groupId), options);
  }

  /**
   * Connects every loaded group (see {@link connect}) and keeps the set of
   * connections in lockstep with the loaded groups: newly created/joined/
   * imported/loaded groups are connected automatically, and
   * destroyed/left/unloaded/removed groups are disconnected. Returns a handle
   * whose `.unsubscribe()` tears down every connection and stops tracking.
   */
  connectAll(options?: ConnectOptions): Unsubscribable {
    const records = new Map<
      string,
      { cancelled: boolean; sub?: Unsubscribable }
    >();

    const connect = (group: MarmotGroup<THistory, TMedia>) => {
      if (records.has(group.idStr)) return;
      const record: { cancelled: boolean; sub?: Unsubscribable } = {
        cancelled: false,
      };
      records.set(group.idStr, record);
      void this.#connectGroup(group, options)
        .then((sub) => {
          if (record.cancelled) sub.unsubscribe();
          else record.sub = sub;
        })
        .catch((err) => {
          log("connectAll: failed to connect %s: %o", group.idStr, err);
          records.delete(group.idStr);
        });
    };

    const disconnect = (groupId: Uint8Array) => {
      const hex = bytesToHex(groupId);
      const record = records.get(hex);
      if (!record) return;
      record.cancelled = true;
      record.sub?.unsubscribe();
      records.delete(hex);
    };

    for (const group of this.loaded) connect(group);

    this.on("created", connect);
    this.on("joined", connect);
    this.on("imported", connect);
    this.on("loaded", connect);
    this.on("destroyed", disconnect);
    this.on("left", disconnect);
    this.on("unloaded", disconnect);
    this.on("removed", disconnect);

    return {
      unsubscribe: () => {
        this.off("created", connect);
        this.off("joined", connect);
        this.off("imported", connect);
        this.off("loaded", connect);
        this.off("destroyed", disconnect);
        this.off("left", disconnect);
        this.off("unloaded", disconnect);
        this.off("removed", disconnect);
        for (const record of records.values()) {
          record.cancelled = true;
          record.sub?.unsubscribe();
        }
        records.clear();
      },
    };
  }

  /** Backfill + live-subscribe a single group instance to its transport events. */
  async #connectGroup(
    group: MarmotGroup<THistory, TMedia>,
    options?: ConnectOptions,
  ): Promise<Unsubscribable> {
    const noop: Unsubscribable = { unsubscribe: () => {} };
    const relays =
      (group.relays?.length ? group.relays : options?.fallbackRelays) ?? [];
    if (!relays.length) {
      log("connect: group %s has no relays — skipping", group.idStr);
      return noop;
    }

    let h: string;
    try {
      h = getNostrGroupIdHex(group.state);
    } catch {
      log("connect: group %s has no nostr routing — skipping", group.idStr);
      return noop;
    }

    const filter = { kinds: [GROUP_EVENT_KIND], "#h": [h] };
    // Only ids of TRUSTED (verified + exact group-scoped `h`) events live here (SEC-01/
    // WR-01): an unverified or malformed event's id must never occupy this
    // dedup slot, or a corrupted same-id forgery could poison it and censor
    // the genuine, validly-signed event arriving later. `seen.add` MUST stay
    // strictly after both trust gates below — never add a rejected event's id
    // here (T-03-24). Rejected ids have a separate bounded cache, consulted
    // only after the current event fails validation, so a valid same-id event
    // can never be censored by an earlier forgery.
    const seen = new BoundedIdCache(SUBSCRIPTION_ID_CACHE_CAPACITY);
    const rejected = new BoundedIdCache(SUBSCRIPTION_ID_CACHE_CAPACITY);
    const drain = async (events: NostrEvent[]): Promise<void> => {
      const fresh = events.filter((event) => !seen.has(event.id));
      if (!fresh.length) return;

      // Trust boundary (SEC-01/WIRE-02): verify signature and `h` tag
      // cardinality BEFORE any event reaches group.ingest() or occupies the
      // dedup `seen` slot. Not a cross-check of the `h` value against the
      // subscribed group id — that is out of scope (RESEARCH Open Question 1).
      const trusted: NostrEvent[] = [];
      for (const event of fresh) {
        if (!safeVerifyEvent(this.#verifyEvent, event)) {
          rejected.add(event.id);
          this.emit("rejected", group.id, event, "invalid-signature");
          continue;
        }
        if (getSingletonTagValue(event, "h") !== h) {
          rejected.add(event.id);
          this.emit("rejected", group.id, event, "tag-cardinality");
          continue;
        }
        seen.add(event.id);
        trusted.push(event);
      }
      if (!trusted.length) return;

      try {
        for await (const result of group.ingest(trusted)) {
          if (result.kind === "unreadable")
            this.emit("unreadable", group.id, result.event);
        }
      } catch (err) {
        log("connect: ingest failed for group %s: %o", group.idStr, err);
      }
    };

    // Backfill before subscribing (mirrors the proven attach order): the backlog
    // ingests as one batch so out-of-order commits resolve together.
    await drain(await this.network.request(relays, filter));

    const sub = this.network
      .subscription(relays, filter)
      .subscribe({ next: (event) => void drain([event]) });

    return { unsubscribe: () => sub.unsubscribe() };
  }

  /**
   * Persists and caches a group built from a {@link ClientState}, emitting
   * the given lifecycle event. Used by higher-level flows (e.g. joining from
   * a welcome message) that construct ClientStates themselves.
   *
   * @param state - The ClientState to adopt
   * @returns The persisted and cached MarmotGroup
   * @throws Error if a group with the same id already exists
   */
  async adoptClientState(
    state: ClientState,
    options?: {
      /** Which lifecycle event to emit. Defaults to `"imported"`. */
      emit?: "imported" | "joined";
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const eventName = options?.emit ?? "imported";
    const id = bytesToHex(state.groupContext.groupId);

    if (await this.#registry.has(state.groupContext.groupId)) {
      throw new Error(`Group ${id} already exists`);
    }

    const group = await this.#registry.build(state);

    // Persist initial state via the group's own save() path.
    // MarmotGroup.save() is the single writer into the group state store.
    await group.save(true);

    await this.#registry.track(group);
    this.emit(eventName, group);
    log("adopted group %s (emit=%s)", id, eventName);

    return group;
  }

  /**
   * Imports a new group from a {@link ClientState} object, persisting it to
   * the store and emitting `imported`.
   */
  async import(state: ClientState): Promise<MarmotGroup<THistory, TMedia>> {
    return this.adoptClientState(state, { emit: "imported" });
  }

  /**
   * Joins a group from a decoded MLS {@link Welcome} using locally held key
   * package candidates (produced by `KeyPackageManager.selectForWelcome`).
   *
   * Mirrors the darkmatter engine `do_join_welcome`: the KeyPackageRef→private
   * bundle match and the MLS join happen here, in the group layer, not in the
   * composition root. Tries candidates in priority order, validates every leaf
   * carries a valid account identity proof, then adopts the resulting state and
   * emits `joined`.
   *
   * @returns The joined group and the KeyPackageRef that was consumed (so the
   *   caller can mark it used), or `consumedKeyPackageRef: null` if none matched.
   */
  async joinFromWelcome(options: {
    welcome: Welcome;
    candidates: WelcomeKeyPackageCandidate[];
    ciphersuiteImpl: CiphersuiteImpl;
  }): Promise<{
    group: MarmotGroup<THistory, TMedia>;
    consumedKeyPackageRef: Uint8Array | null;
  }> {
    const { welcome, candidates, ciphersuiteImpl } = options;

    if (candidates.length === 0) {
      throw new Error(
        "No matching KeyPackage found in local store. Make sure you have published a KeyPackage event.",
      );
    }

    let clientState: ClientState | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;

    for (const candidate of candidates) {
      try {
        clientState = await joinGroup({
          context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            externalPsks: {},
          },
          welcome,
          keyPackage: candidate.publicPackage,
          privateKeys: candidate.privatePackage,
        });
        consumedKeyPackageRef = candidate.keyPackageRef;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (!clientState) {
      throw new Error(
        lastError
          ? `Failed to join group with any matching key package. Last error: ${lastError.message}`
          : "Failed to join group with any matching key package",
      );
    }

    // The spec requires every member leaf to carry a valid account identity
    // proof, with no legacy fallback; reject joining a group that contains any
    // proof-less or invalid leaf (foundation/account-identity-proof-v1.md).
    verifyAllLeafAccountIdentityProofs(clientState, ciphersuiteImpl.id);

    const group = await this.adoptClientState(clientState, { emit: "joined" });
    return { group, consumedKeyPackageRef };
  }

  /** Unloads a group from the client but does not remove it from the store */
  async unload(groupId: Uint8Array | string): Promise<void> {
    const hex = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.#registry.untrack(hex);
    this.emit("unloaded", hex);
  }

  /** Destroys a group and purges the group history */
  async destroy(groupId: Uint8Array | string): Promise<void> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("destroying group %s", id);

    const group = this.#registry.peek(id) ?? (await this.#registry.load(id));

    // NOTE: MarmotGroup.destroy() is the single owner of removing group state
    // from storage. It emits `destroyed`, which the registry listener uses to
    // clear the in-memory cache and emit `updated`.
    await group.destroy();

    const hexId = typeof groupId === "string" ? hexToBytes(groupId) : groupId;
    this.emit("destroyed", hexId);
  }

  /**
   * Leaves a group by publishing a self-remove proposal and purging all
   * local group data from storage.
   *
   * At least one relay must acknowledge the proposals before local state is
   * destroyed. If no relay acks, an error is thrown and local state is
   * preserved so the caller can retry.
   *
   * @param groupId - The group ID as a hex string or Uint8Array.
   * @returns The relay publish responses for the leave proposal event(s).
   */
  async leave(
    groupId: Uint8Array | string,
  ): Promise<Record<string, PublishResponse>> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    log("leaving group %s", id);

    const group = this.#registry.peek(id) ?? (await this.#registry.load(id));
    const groupIdBytes =
      typeof groupId === "string" ? hexToBytes(groupId) : groupId;

    // "leave is a SendIntent": the session builds the self-remove proposals
    // (RFC 9420 §12.4 — a member cannot commit a Remove targeting their own
    // leaf, so an admin applies them later) and we publish them here.
    const ownPubkey = await this.signer.getPublicKey();
    const effects = await group.session.leave(ownPubkey);

    const response: Record<string, PublishResponse> = {};
    for (const result of await group.runtime.publishEffects(effects))
      Object.assign(response, result.response);

    // publishEffects already throws on no-ack, but guard local destruction
    // behind an explicit ack check so state is preserved on failure and the
    // caller can retry.
    if (!hasAck(response)) {
      throw new Error(
        "Failed to publish leave proposals: no relay acknowledged. Local state preserved — retry leave() to try again.",
      );
    }

    // group.destroy() purges local state and emits `destroyed`; the registry
    // listener clears the in-memory cache and emits `updated`.
    await group.destroy();

    this.emit("left", groupIdBytes);

    return response;
  }

  /** Creates a new simple group */
  async create(
    name: string,
    options?: CreateGroupOptions,
  ): Promise<MarmotGroup<THistory, TMedia>> {
    log("creating group %o", name);
    const group = await this.#factory.create(name, options);

    await this.#registry.track(group);
    this.emit("created", group);
    log("created group %s", group.idStr);

    return group;
  }

  /**
   * Watches for changes to the groups in the store.
   * Returns an async generator that yields the current list of groups
   * whenever the store changes.
   */
  async *watch(): AsyncGenerator<MarmotGroup<THistory, TMedia>[]> {
    let resolveNext: (() => void) | null = null;

    const handleChange = () => {
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    // `updated` fires whenever the set of loaded groups changes
    // (create, import, join, load, unload, destroy, leave).
    this.on("updated", handleChange);

    try {
      // Yield initial state after listeners are installed to avoid missing updates
      // that occur between snapshot and subscription.
      yield [...(await this.loadAll())];

      while (true) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });

        yield [...(await this.loadAll())];
      }
    } finally {
      this.off("updated", handleChange);
    }
  }
}
