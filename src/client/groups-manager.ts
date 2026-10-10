import { isReusableKeyPackage } from "../core/key-package.js";
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
  joinGroupWithExtensions,
  type GroupInfo,
  Welcome,
} from "ts-mls";
import {
  getNostrGroupIdHex,
  SerializedClientState,
} from "../core/client-state.js";
import type { MarmotGroupInfo } from "../core/client-state.js";
import { GROUP_EVENT_KIND } from "../core/protocol.js";
import { marmotAuthService } from "../core/auth-service.js";
import { validateWelcomeGroup } from "../core/welcome-join.js";
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
  GroupTerminalError,
  type GroupDisbandedEvent,
} from "./group/marmot-group.js";
import { createInviteIntent } from "./group/invite.js";
import { encryptGroupImage } from "../core/group-image.js";
import { encodeGroupBlossomImage } from "../core/components/blossom-image.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../core/components/ids.js";
import { getAdminPolicy } from "../core/components/dictionary.js";
import { getGroupMemberPubkeys } from "../core/group-members.js";
import { appDataUpdateProposalType } from "ts-mls";
import {
  groupImageEndpoints,
  groupImageLimit,
  groupImageUnavailable,
  requestGroupImage,
  withGroupImageBudget,
  type GroupImageProfile,
  type GroupImageOperationOptions,
  type GroupImageMutationResult,
} from "./group/group-image-service.js";
import {
  createGroupImageUploadAuthorization,
  GroupImageRequestError,
  validateGroupImageUploadResponse,
} from "./group/group-image-transport.js";
import type { WelcomeKeyPackageCandidate } from "./key-package-store.js";
import { GroupFactory, type CreateGroupOptions } from "./group-factory.js";
import {
  DEFAULT_BACKFILL_MAX_PAGES,
  DEFAULT_BACKFILL_PAGE_SIZE,
  DEFAULT_BACKFILL_SLACK_SECONDS,
  type BackfillProgress,
  type PagedBackfillResult,
  backfillCursorKey,
  backfillProgressKey,
  encodeBackfillCursor,
  encodeBackfillProgress,
  fetchPagedBackfill,
  nextBackfillCursor,
  oldestCreatedAt,
  readBackfillCursor,
  readBackfillProgress,
} from "./group-backfill.js";
import { GroupRegistry } from "./group-registry.js";
import { InMemoryKeyValueStore } from "../extra/in-memory-key-value-store.js";
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
  /** Stops intake, including a connection still waiting for backfill. */
  signal?: AbortSignal;
  /**
   * Relays to subscribe on when a group carries no relays of its own. A group
   * with neither its own relays nor a fallback is skipped (it cannot receive,
   * just as it cannot send).
   */
  fallbackRelays?: string[];
  /**
   * Overlap, in seconds, re-fetched behind each relay's stored backfill
   * cursor (and ahead of the live subscription's start) to absorb relay clock
   * skew and late-propagating events. Defaults to 600 (10 minutes).
   */
  backfillSlackSeconds?: number;
  /** `limit` of each backfill page request. Defaults to 500. */
  backfillPageSize?: number;
  /**
   * Maximum pages fetched from each relay per connect. When a relay hits the
   * cap the fetched events are still ingested, but its cursor is not
   * advanced, so the remainder is retried on the next connect. Defaults to 50.
   */
  backfillMaxPages?: number;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Validates the backfill bounds of {@link ConnectOptions}, applying defaults. */
function backfillBounds(options: ConnectOptions | undefined) {
  const slack = options?.backfillSlackSeconds ?? DEFAULT_BACKFILL_SLACK_SECONDS;
  if (!Number.isFinite(slack) || slack < 0)
    throw new Error("backfillSlackSeconds must be a non-negative number");
  return {
    slack,
    pageSize: positiveInteger(
      options?.backfillPageSize,
      DEFAULT_BACKFILL_PAGE_SIZE,
      "backfillPageSize",
    ),
    maxPages: positiveInteger(
      options?.backfillMaxPages,
      DEFAULT_BACKFILL_MAX_PAGES,
      "backfillMaxPages",
    ),
  };
}

/** Options for creating a new GroupsManager */
export type GroupsManagerOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The backend storing serialized group state bytes */
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore: GenericKeyValueStore<Uint8Array>;
  lifecycleStore: GenericKeyValueStore<Uint8Array>;
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
   * `maxRewindCommits` rollback horizon). Keep the finite profile-1 default
   * for production. `Infinity` is an explicit debugging/forensics choice
   * that keeps arbitrarily old forks eligible and can retain unbounded evidence.
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
  /** Maximum admitted image mutations per loaded group, including active work. Default 16. */
  maxPendingImageMutations?: number;
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
  /** Emitted once for the selected, durably recorded terminal commit. */
  disbanded: (groupId: Uint8Array, evidence: GroupDisbandedEvent) => void;
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
  /** Every connected group result, including timer-driven invalidations, once. */
  ingestResult: (
    groupId: Uint8Array,
    result: DispositionedIngestResult,
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
  /** The nostr relay pool to use for the client */
  readonly network: NostrNetworkInterface;

  /** Crypto provider for cryptographic operations */
  public cryptoProvider: CryptoProvider;
  readonly ingestPersistence: IngestPersistenceCapability;

  /** Owns the in-memory cache + store hydration. */
  readonly #registry: GroupRegistry<THistory, TMedia>;
  readonly #adoptions = new Map<string, Promise<void>>();
  readonly #maxPendingImageMutations: number;
  readonly #imageMutations = new Map<
    string,
    {
      group: Promise<MarmotGroup<THistory, TMedia>>;
      instance?: MarmotGroup<THistory, TMedia>;
      tail: Promise<unknown>;
      pending: number;
    }
  >();
  readonly #admissions = new Map<
    string,
    {
      tail: Promise<unknown>;
      seen: BoundedIdCache;
      /** Set once an admitted batch fails to ingest; never cleared. */
      ingestFailed: boolean;
      connections: number;
      pending: number;
      cleanup: () => void;
    }
  >();
  /** Builds new groups (the identity-signer/ciphersuite consumer). */
  readonly #factory: GroupFactory<THistory, TMedia>;
  /** The injectable event verifier gating the 445 drain (SEC-01). */
  readonly #verifyEvent: VerifyEventMethod;
  /** Holds each group's backfill cursor alongside its ingest state. */
  readonly #ingestStateStore: GenericKeyValueStore<Uint8Array>;

  constructor(options: GroupsManagerOptions<THistory, TMedia>) {
    super();
    const capacity = options.maxPendingImageMutations ?? 16;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error(
        "Image mutation capacity must be a finite positive integer",
      );
    this.#maxPendingImageMutations = capacity;
    this.store = options.store;
    this.ingestPersistence = options.ingestPersistence;
    this.signer = options.signer;
    this.network = options.network;
    this.cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    this.#verifyEvent = options.verifyEvent ?? defaultVerifyEvent;
    this.#ingestStateStore =
      options.ingestStateStore ?? new InMemoryKeyValueStore<Uint8Array>();

    this.#registry = new GroupRegistry<THistory, TMedia>({
      store: options.store,
      ingestStateStore: options.ingestStateStore,
      lifecycleStore: options.lifecycleStore,
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
      lifecycleStore: options.lifecycleStore,
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
      verifyEvent: this.#verifyEvent,
    });

    // Forward the registry's cache-level events as our own.
    this.#registry.on("updated", (groups) => this.emit("updated", groups));
    this.#registry.on("loaded", (group) => this.emit("loaded", group));
    this.#registry.on("removed", (group) => this.emit("removed", group.id));
    this.#registry.on("disbanded", (group, evidence) =>
      this.emit("disbanded", group.id, evidence),
    );
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

  /** Upload opaque encrypted bytes, then submit guarded metadata through MLS. */
  replaceGroupImage(
    groupId: Uint8Array | string,
    bytes: Uint8Array,
    mediaType: string,
    profile: GroupImageProfile,
    options: GroupImageOperationOptions = {},
  ): Promise<GroupImageMutationResult> {
    if (
      bytes.length > groupImageLimit(profile.maxUploadBytes, 10 * 1024 * 1024)
    )
      return Promise.resolve({ kind: "unavailable", reason: "byte-limit" });
    profile = { ...profile, endpoints: profile.endpoints?.slice() };
    options = { ...options };
    return this.#mutateImage(
      groupId,
      async (group, actorPubkey, owned, mutationSignal) => {
        const expectedParent = group.session.parentToken;
        if (
          owned!.length >
          groupImageLimit(profile.maxUploadBytes, 10 * 1024 * 1024)
        )
          return { kind: "unavailable", reason: "byte-limit" };
        const encrypted = encryptGroupImage(owned!, mediaType);
        try {
          await withGroupImageBudget(
            profile,
            { signal: mutationSignal },
            async (signal) => {
              const endpoints = await groupImageEndpoints(
                profile,
                group.image.source(),
                signal,
              );
              const endpoint = endpoints[0]!;
              const hash = bytesToHex(encrypted.metadata.imageHash);
              const response = await requestGroupImage(
                profile,
                {
                  url: `${endpoint}/upload`,
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/octet-stream",
                    "X-SHA-256": hash,
                    Authorization: createGroupImageUploadAuthorization(
                      endpoint,
                      encrypted.metadata,
                    ),
                  },
                  body: encrypted.ciphertext,
                  maxBytes: groupImageLimit(
                    profile.maxDescriptorBytes,
                    16 * 1024,
                  ),
                },
                { signal },
              );
              validateGroupImageUploadResponse(
                response,
                endpoint,
                hash,
                encrypted.ciphertext.length,
              );
            },
          );
        } catch (error) {
          if (group.closedSignal.aborted || group.image.closedSignal.aborted)
            return { kind: "unavailable", reason: "closed" };
          return groupImageUnavailable(error);
        }
        if (options.signal?.aborted)
          return { kind: "unavailable", reason: "cancelled" };
        const currentActor = await this.#imageActor(group, mutationSignal);
        if (currentActor !== actorPubkey)
          throw new Error("Group image actor changed before preparation");
        this.#assertImageMutation(group, actorPubkey, expectedParent);
        if (options.signal?.aborted)
          return { kind: "unavailable", reason: "cancelled" };
        const publications = await group.submitIntent({
          kind: "commit",
          actorPubkey,
          expectedParent,
          signal: mutationSignal,
          extraProposals: [
            {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                operation: "update",
                update: encodeGroupBlossomImage(encrypted.metadata),
              },
            },
          ],
        });
        return {
          kind: "published",
          publications,
        };
      },
      bytes,
      options,
    );
  }

  /** Clear canonical Blossom metadata; URL avatars and remote blobs remain. */
  clearGroupImage(
    groupId: Uint8Array | string,
    options: GroupImageOperationOptions = {},
  ): Promise<GroupImageMutationResult> {
    return this.#mutateImage(
      groupId,
      async (group, actorPubkey, _owned, signal) => ({
        kind: "published",
        publications: await group.submitIntent({
          kind: "commit",
          actorPubkey,
          expectedParent: group.session.parentToken,
          signal,
          extraProposals: [
            {
              proposalType: appDataUpdateProposalType,
              appDataUpdate: {
                componentId: GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
                operation: "update",
                update: encodeGroupBlossomImage({ kind: "empty" }),
              },
            },
          ],
        }),
      }),
      undefined,
      options,
    );
  }

  #mutateImage(
    groupId: Uint8Array | string,
    operation: (
      group: MarmotGroup<THistory, TMedia>,
      actorPubkey: string,
      owned: Uint8Array | undefined,
      signal: AbortSignal,
    ) => Promise<GroupImageMutationResult>,
    bytes?: Uint8Array,
    options: GroupImageOperationOptions = {},
  ): Promise<GroupImageMutationResult> {
    const id = typeof groupId === "string" ? groupId : bytesToHex(groupId);
    const loaded = this.loaded.find((group) => group.idStr === id);
    let queue = this.#imageMutations.get(id);
    if (!queue || (loaded && queue.instance && queue.instance !== loaded)) {
      queue = {
        group: loaded ? Promise.resolve(loaded) : this.get(id),
        instance: loaded,
        tail: Promise.resolve(),
        pending: 0,
      };
      this.#imageMutations.set(id, queue);
    }
    if (queue.pending >= this.#maxPendingImageMutations)
      return Promise.resolve({ kind: "unavailable", reason: "byte-limit" });
    const owned = bytes?.slice();
    queue.pending++;
    const admitted = queue;
    const controller = new AbortController();
    let completed = false;
    const signals: AbortSignal[] = [];
    const abort = () => {
      const closed =
        admitted.instance &&
        (admitted.instance.closedSignal.aborted ||
          admitted.instance.image.closedSignal.aborted);
      controller.abort(
        closed
          ? new Error("Group unloaded; image mutation cancelled")
          : new GroupImageRequestError("cancelled"),
      );
    };
    const observe = (signal: AbortSignal) => {
      signals.push(signal);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    };
    if (options.signal) observe(options.signal);
    // Observe the admitted instance immediately, even while waiting in the
    // manager FIFO. Closing an image service releases every waiting caller.
    const groupReady = admitted.group.then((group) => {
      admitted.instance = group;
      if (completed) return group;
      observe(group.closedSignal);
      observe(group.image.closedSignal);
      return group;
    });
    void groupReady.catch(() => undefined);
    let rejectAdmission: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAdmission = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAdmission, {
        once: true,
      });
      if (controller.signal.aborted) rejectAdmission();
    });
    const queued = admitted.tail
      .catch(() => undefined)
      .then(async () => {
        const group = await groupReady;
        controller.signal.throwIfAborted();
        this.#assertImageOwnerOpen(group);
        const actorPubkey = await this.#imageActor(group, controller.signal);
        controller.signal.throwIfAborted();
        this.#assertImageMutation(group, actorPubkey);
        // Preparation handles cancellation from here. Once transport starts,
        // return its publication outcome even if image closure arrives later.
        controller.signal.removeEventListener("abort", rejectAdmission!);
        return operation(group, actorPubkey, owned, controller.signal);
      });
    const result = Promise.race([queued, interrupted])
      .catch((error) => {
        if (error instanceof GroupImageRequestError)
          return groupImageUnavailable(error);
        throw error;
      })
      .finally(() => {
        completed = true;
        controller.signal.removeEventListener("abort", rejectAdmission!);
        for (const signal of signals)
          signal.removeEventListener("abort", abort);
        owned?.fill(0);
        admitted.pending--;
        if (admitted.pending === 0 && this.#imageMutations.get(id) === admitted)
          this.#imageMutations.delete(id);
      });
    // A waiting caller may cancel promptly without letting later FIFO work
    // overtake the operation that was ahead of it.
    admitted.tail = queued;
    void result.catch(() => undefined);
    return result;
  }

  #assertImageOwnerOpen(group: MarmotGroup<THistory, TMedia>): void {
    if (
      !this.loaded.includes(group) ||
      group.closedSignal.aborted ||
      group.image.closedSignal.aborted
    )
      throw new Error("Group unloaded; image mutation cancelled");
    group.session.assertOpen();
  }

  async #imageActor(
    group: MarmotGroup<THistory, TMedia>,
    signal?: AbortSignal,
  ): Promise<string> {
    this.#assertImageOwnerOpen(group);
    signal?.throwIfAborted();
    const signals = [group.closedSignal, group.image.closedSignal];
    let abort!: () => void;
    const closed = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          signal?.aborted
            ? signal.reason
            : new Error("Group unloaded; image mutation cancelled"),
        );
      signal?.addEventListener("abort", abort, { once: true });
      for (const signal of signals)
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          this.#assertImageOwnerOpen(group);
          signal?.throwIfAborted();
          return this.signer.getPublicKey();
        }),
        closed,
      ]);
    } finally {
      signal?.removeEventListener("abort", abort);
      for (const signal of signals) signal.removeEventListener("abort", abort);
    }
  }

  #assertImageMutation(
    group: MarmotGroup<THistory, TMedia>,
    actorPubkey: string,
    expectedParent?: string,
  ): void {
    this.#assertImageOwnerOpen(group);
    if (
      group.status !== "active" ||
      !getAdminPolicy(group.state.groupContext.extensions)?.includes(
        actorPubkey,
      ) ||
      !getGroupMemberPubkeys(group.state).includes(actorPubkey)
    )
      throw new Error(
        "Only an active group admin can change the Blossom image",
      );
    if (group.profileSupport.kind !== "supported")
      throw new Error(
        "Group image mutation requires a supported group profile",
      );
    if (group.session.terminalTombstone || group.lifecycle !== "Stable")
      throw new Error(
        "Group image mutation requires a stable active lifecycle",
      );
    if (
      expectedParent !== undefined &&
      expectedParent !== group.session.parentToken
    )
      throw new Error("Group canonical parent changed before preparation");
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
      expectedParent: options?.expectedParent,
      signal: options?.signal,
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
    backfillBounds(options);
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
    backfillBounds(options);
    const records = new Map<
      string,
      { controller: AbortController; sub?: Unsubscribable }
    >();

    const connect = (group: MarmotGroup<THistory, TMedia>) => {
      if (records.has(group.idStr)) return;
      if (options?.signal?.aborted) return;
      const record: { controller: AbortController; sub?: Unsubscribable } = {
        controller: new AbortController(),
      };
      records.set(group.idStr, record);
      void this.#connectGroup(group, {
        ...options,
        signal: record.controller.signal,
      })
        .then((sub) => {
          if (record.controller.signal.aborted) sub.unsubscribe();
          else record.sub = sub;
        })
        .catch((err) => {
          log("connectAll: failed to connect %s: %o", group.idStr, err);
          if (records.get(group.idStr) === record) records.delete(group.idStr);
        });
    };

    const disconnect = (groupId: Uint8Array) => {
      const hex = bytesToHex(groupId);
      const record = records.get(hex);
      if (!record) return;
      record.controller.abort();
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
    this.on("disbanded", disconnect);

    const unsubscribe = () => {
      options?.signal?.removeEventListener("abort", unsubscribe);
      this.off("created", connect);
      this.off("joined", connect);
      this.off("imported", connect);
      this.off("loaded", connect);
      this.off("destroyed", disconnect);
      this.off("left", disconnect);
      this.off("unloaded", disconnect);
      this.off("removed", disconnect);
      this.off("disbanded", disconnect);
      for (const record of records.values()) {
        record.controller.abort();
        record.sub?.unsubscribe();
      }
      records.clear();
    };
    options?.signal?.addEventListener("abort", unsubscribe, { once: true });
    if (options?.signal?.aborted) unsubscribe();
    return { unsubscribe };
  }

  /** Backfill + live-subscribe a single group instance to its transport events. */
  async #connectGroup(
    group: MarmotGroup<THistory, TMedia>,
    options?: ConnectOptions,
  ): Promise<Unsubscribable> {
    const noop: Unsubscribable = { unsubscribe: () => {} };
    if (
      options?.signal?.aborted ||
      group.status === "removed" ||
      group.status === "disbanded"
    ) {
      log("connect: group %s is %s — skipping", group.idStr, group.status);
      return noop;
    }
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
    // here (T-03-24), so a valid same-id event can never be censored by forgery.
    let admission = this.#admissions.get(group.idStr);
    if (!admission) {
      const forward = (result: DispositionedIngestResult) => {
        if (result.kind === "unreadable")
          this.emit("unreadable", group.id, result.event);
        this.emit("ingestResult", group.id, result);
      };
      group.on("ingestResult", forward);
      admission = {
        tail: Promise.resolve(),
        seen: new BoundedIdCache(SUBSCRIPTION_ID_CACHE_CAPACITY),
        ingestFailed: false,
        connections: 0,
        pending: 0,
        cleanup: () => group.off("ingestResult", forward),
      };
      this.#admissions.set(group.idStr, admission);
    }
    const record = admission;
    record.connections++;
    const cleanup = () => {
      if (record.connections || record.pending) return;
      record.cleanup();
      if (this.#admissions.get(group.idStr) === record)
        this.#admissions.delete(group.idStr);
    };
    let cancelled = false;
    // Stops a paged backfill once the connection is cancelled (abort/disband).
    const paging = new AbortController();
    let sub: Unsubscribable | undefined;
    const unsubscribe = () => {
      if (cancelled) return;
      cancelled = true;
      paging.abort();
      options?.signal?.removeEventListener("abort", unsubscribe);
      group.off("disbanded", unsubscribe);
      sub?.unsubscribe();
      record.connections--;
      cleanup();
    };
    options?.signal?.addEventListener("abort", unsubscribe, { once: true });
    group.once("disbanded", unsubscribe);
    const seen = record.seen;
    type DrainOutcome = {
      /**
       * Events that passed the trust boundary: those handed to ingest now and
       * those an earlier batch for this group already admitted.
       */
      trusted: NostrEvent[];
      /** Whether this or an earlier admitted batch was not fully ingested. */
      failed: boolean;
    };
    const drain = async (events: NostrEvent[]): Promise<DrainOutcome> => {
      // `seen` is shared by every connection to this group, so a backfill can
      // re-fetch events an earlier batch already ingested. They count towards
      // the backfill cursor unless an admitted batch has failed. A same-id
      // copy only counts if it passes the trust boundary itself: the cache
      // vouches for the id, not for this copy's `created_at`.
      const outcome: DrainOutcome = {
        trusted: [],
        failed: record.ingestFailed,
      };
      const fresh: NostrEvent[] = [];
      for (const event of events) {
        if (!seen.has(event.id)) fresh.push(event);
        else if (
          safeVerifyEvent(this.#verifyEvent, event) &&
          getSingletonTagValue(event, "h") === h
        )
          outcome.trusted.push(event);
      }
      if (!fresh.length) return outcome;

      // Trust boundary (SEC-01/WIRE-02): verify signature and `h` tag
      // cardinality BEFORE any event reaches group.ingest() or occupies the
      // dedup `seen` slot. The singleton must match this group's routing id.
      const trusted: NostrEvent[] = [];
      for (const event of fresh) {
        if (!safeVerifyEvent(this.#verifyEvent, event)) {
          this.emit("rejected", group.id, event, "invalid-signature");
          continue;
        }
        if (getSingletonTagValue(event, "h") !== h) {
          this.emit("rejected", group.id, event, "tag-cardinality");
          continue;
        }
        seen.add(event.id);
        trusted.push(event);
      }
      for (const event of trusted) outcome.trusted.push(event);
      if (!trusted.length) return outcome;

      // Result delivery uses the facade event only; consuming yields as well
      // would duplicate live results and still miss timer-driven results.
      for await (const result of group.ingest(trusted)) void result;
      return outcome;
    };
    /**
     * Queues `events` behind every earlier batch for this group. `settle`
     * runs in the same queued operation, after the drain, so no later batch
     * is ingested while it inspects or persists ingest-dependent state.
     */
    const admit = (
      events: NostrEvent[],
      settle?: (outcome: DrainOutcome) => Promise<void>,
    ): Promise<DrainOutcome> => {
      if (cancelled) return Promise.resolve({ trusted: [], failed: true });
      record.pending++;
      const work = record.tail
        .then(async () => {
          let outcome: DrainOutcome;
          try {
            outcome = await drain(events);
          } catch (err) {
            log("connect: ingest failed for group %s: %o", group.idStr, err);
            record.ingestFailed = true;
            outcome = { trusted: [], failed: true };
          }
          if (settle) {
            try {
              await settle(outcome);
            } catch (err) {
              log(
                "connect: backfill settle failed for %s: %o",
                group.idStr,
                err,
              );
            }
          }
          return outcome;
        })
        .finally(() => {
          record.pending--;
          cleanup();
        });
      record.tail = work;
      return work;
    };

    // Backfill before subscribing (mirrors the proven attach order): the backlog
    // ingests as one batch so out-of-order commits resolve together. Each relay
    // is fetched from its own cursor (newest event ingested from its last
    // complete backfill) minus a slack window, and paged so relay result caps
    // cannot silently truncate it; a relay without a cursor is paged through
    // its full history. Per-relay cursors let a failing or incomplete relay be
    // re-read without holding back the others.
    try {
      const { slack, pageSize, maxPages } = backfillBounds(options);
      const nowSeconds = () => Math.floor(Date.now() / 1000);
      const cursors = new Map<string, number>();
      const since = new Map<string, number>();
      // Per-relay progress of an earlier page-capped backfill: the walk skips
      // ranges already fetched, so history beyond the cap is reached over
      // several connects instead of re-reading the newest pages every time.
      const resume = new Map<string, BackfillProgress>();
      for (const relay of relays) {
        const cursor = await readBackfillCursor(
          this.#ingestStateStore,
          group.idStr,
          relay,
          nowSeconds(),
        );
        if (cursor !== undefined) {
          cursors.set(relay, cursor);
          since.set(relay, Math.max(0, Math.floor(cursor - slack)));
        }
        const progress = await readBackfillProgress(
          this.#ingestStateStore,
          group.idStr,
          relay,
          nowSeconds(),
        );
        if (progress)
          resume.set(relay, {
            from: progress.from,
            to: Math.floor(progress.to - slack),
          });
      }
      const walkStart = nowSeconds();
      const backfill = await fetchPagedBackfill(this.network, relays, filter, {
        since,
        pageSize,
        maxPages,
        resume,
        signal: paging.signal,
        // The admission trust gates, applied before copies are collapsed by
        // id so a forged copy cannot displace the genuine event.
        accept: (event) =>
          safeVerifyEvent(this.#verifyEvent, event) &&
          getSingletonTagValue(event, "h") === h,
      });
      await admit(backfill.events, async (drained) => {
        // Decided inside the admission queue: no other batch for this group
        // can be ingested (and pool, retain, or fail) between reading the
        // state below and persisting the cursor and progress.
        if (drained.failed || cancelled || group.session.terminalTombstone)
          return;
        // Events the group holds only in memory are lost on restart, so
        // neither the cursor nor recorded progress may pass them: the
        // undecryptable-so-far pool and capacity-refused input (pooled
        // without yielding a result), and input retained while a commit
        // publication or merge is in progress.
        const held = group.pendingEvents();
        const retained = group.session.retainedEvents();

        await this.#recordBackfillProgress(
          group,
          backfill,
          resume,
          [...held, ...retained],
          walkStart,
        );

        await this.#advanceBackfillCursors(
          group,
          backfill,
          drained.trusted,
          held,
          retained,
          cursors,
          nowSeconds(),
        );
      });

      // Backfill may itself have selected terminal state. Never seed a live route
      // after the durable tombstone has won.
      if (cancelled || group.session.terminalTombstone) {
        unsubscribe();
        return noop;
      }

      // The backfill covered everything before the walk began; the slack
      // re-reads events that reached a relay late.
      const installed = this.network
        .subscription(relays, {
          ...filter,
          since: Math.max(0, Math.floor(walkStart - slack)),
        })
        .subscribe({ next: (event) => void admit([event]) });
      sub = installed;
      if (cancelled) installed.unsubscribe();
      return { unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  /**
   * Writes one of a group's backfill records (removes it without `value`),
   * unless the group is destroyed or disbanded. Their cleanup purges the
   * group's ingest state, possibly while this write is in flight, so a record
   * written as the group closes is removed again.
   */
  async #writeBackfillRecord(
    group: MarmotGroup<THistory, TMedia>,
    key: string,
    value?: Uint8Array,
  ): Promise<void> {
    const closed = () =>
      group.session.destroyed || group.session.terminalTombstone !== undefined;
    if (closed()) return;
    if (value === undefined) return this.#ingestStateStore.removeItem(key);
    await this.#ingestStateStore.setItem(key, value);
    if (closed()) await this.#ingestStateStore.removeItem(key);
  }

  /**
   * Advances the cursor of each relay whose backfill completed, from the
   * events it returned that admission trusted. A relay that hit the page
   * cap, saturated a second, or failed keeps its cursor, so its next connect
   * re-reads the same window. Persistence failures are logged, never thrown.
   */
  async #advanceBackfillCursors(
    group: MarmotGroup<THistory, TMedia>,
    backfill: PagedBackfillResult,
    trusted: readonly NostrEvent[],
    held: readonly NostrEvent[],
    retained: readonly NostrEvent[],
    cursors: ReadonlyMap<string, number>,
    nowSeconds: number,
  ): Promise<void> {
    const trustedIds = new Set(trusted.map((event) => event.id));
    for (const outcome of backfill.relays) {
      if (outcome.status !== "complete") continue;
      const previous = cursors.get(outcome.relay);
      const next = nextBackfillCursor({
        ingested: (backfill.relayEvents.get(outcome.relay) ?? []).filter(
          (event) => trustedIds.has(event.id),
        ),
        held,
        retained,
        previous,
        nowSeconds,
      });
      if (next === undefined || next === previous) continue;
      try {
        await this.#writeBackfillRecord(
          group,
          backfillCursorKey(group.idStr, outcome.relay),
          encodeBackfillCursor(next),
        );
      } catch (err) {
        log("connect: failed to persist cursor for %s: %o", group.idStr, err);
      }
    }
  }

  /**
   * Records each relay's resumable paging progress after a backfill has been
   * ingested: a capped relay stores the range now fetched (`[until, walk
   * start]`, ended strictly below the second of the oldest event still held
   * in memory), a completed
   * relay drops its record. Saturated or failed relays keep any earlier
   * record unchanged. Persistence failures are logged, never thrown.
   */
  async #recordBackfillProgress(
    group: MarmotGroup<THistory, TMedia>,
    backfill: PagedBackfillResult,
    recorded: ReadonlyMap<string, BackfillProgress>,
    held: readonly NostrEvent[],
    walkStart: number,
  ): Promise<void> {
    for (const outcome of backfill.relays) {
      const key = backfillProgressKey(group.idStr, outcome.relay);
      try {
        if (outcome.status === "complete") {
          if (recorded.has(outcome.relay))
            await this.#writeBackfillRecord(group, key);
        } else if (outcome.status === "capped") {
          const from = outcome.until;
          // End strictly below the oldest held event: its whole second must
          // be re-read (a jump inside it could skip same-second events).
          const oldestHeld = oldestCreatedAt(held, from);
          const to = Math.min(
            walkStart,
            oldestHeld === undefined ? walkStart : oldestHeld - 1,
          );
          if (from <= to)
            await this.#writeBackfillRecord(
              group,
              key,
              encodeBackfillProgress({ from, to }),
            );
          // Nothing durable to record: drop any older range, which may
          // cover the held event too.
          else if (recorded.has(outcome.relay))
            await this.#writeBackfillRecord(group, key);
        }
      } catch (err) {
        log("connect: failed to persist backfill progress: %o", err);
      }
    }
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
      /** Runs after duplicate rejection while adoption for this group is serialized. */
      beforeAdopt?: () => Promise<void>;
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const eventName = options?.emit ?? "imported";
    const id = bytesToHex(state.groupContext.groupId);
    const previous = this.#adoptions.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#adoptions.set(id, gate);
    await previous;
    try {
      if (await this.#registry.has(state.groupContext.groupId)) {
        throw new Error(`Group ${id} already exists`);
      }
      await options?.beforeAdopt?.();

      const group = await this.#registry.build(state);

      // Persist initial state via the group's own save() path.
      // MarmotGroup.save() is the single writer into the group state store.
      await group.save(true);

      await this.#registry.track(group);
      this.emit(eventName, group);
      log("adopted group %s (emit=%s)", id, eventName);

      return group;
    } finally {
      release();
      if (this.#adoptions.get(id) === gate) this.#adoptions.delete(id);
    }
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
   * composition root. Tries candidates in priority order, then requires the
   * joined GroupContext to classify as the current `0x8009` profile
   * (rejecting legacy, mixed, and neither) and every member leaf's proof to
   * validate against the group ciphersuite — both before adopting state, per
   * `refs/marmot/app-components/account-identity-proof-v2.md` "Migration from
   * v1" — then adopts the resulting state and emits `joined`.
   *
   * @returns The joined group and the KeyPackageRef that was consumed (so the
   *   caller can mark it used), or `consumedKeyPackageRef: null` if none matched.
   */
  async joinFromWelcome(options: {
    welcome: Welcome;
    candidates: WelcomeKeyPackageCandidate[];
    ciphersuiteImpl: CiphersuiteImpl;
    /** Records durable cleanup intent only after validation and duplicate rejection. */
    beforeAdopt?: (
      groupId: Uint8Array,
      keyPackageRef: Uint8Array,
    ) => Promise<void>;
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
    let groupInfo: GroupInfo | null = null;
    let lastError: Error | null = null;
    let consumedKeyPackageRef: Uint8Array | null = null;

    for (const candidate of candidates) {
      try {
        isReusableKeyPackage(candidate.publicPackage);
        const joined = await joinGroupWithExtensions({
          context: {
            cipherSuite: ciphersuiteImpl,
            authService: marmotAuthService,
            externalPsks: {},
          },
          welcome,
          keyPackage: candidate.publicPackage,
          privateKeys: candidate.privatePackage,
        });
        clientState = joined.state;
        groupInfo = joined.groupInfo;
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

    // Full tentative validation precedes the serialized persistence boundary.
    validateWelcomeGroup(clientState, groupInfo!);
    const ref = consumedKeyPackageRef;
    const group = await this.adoptClientState(clientState, {
      emit: "joined",
      beforeAdopt: async () => {
        if (ref)
          await options.beforeAdopt?.(clientState.groupContext.groupId, ref);
      },
    });
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
    if (group.status === "disbanded") throw new GroupTerminalError();
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
  watch(options?: {
    signal?: AbortSignal;
  }): AsyncGenerator<MarmotGroup<THistory, TMedia>[]> {
    const manager = this;
    const signal = options?.signal;
    let cancelled = false;
    let listening = false;
    let version = 0;
    let wake: (() => void) | undefined;
    let cancelLoad: (() => void) | undefined;
    const changed = () => {
      version++;
      wake?.();
      wake = undefined;
    };
    const cleanup = () => {
      if (!listening) return;
      listening = false;
      manager.off("updated", changed);
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      cancelled = true;
      cleanup();
      cancelLoad?.();
      cancelLoad = undefined;
      wake?.();
      wake = undefined;
    };
    const iterator = (async function* (): AsyncGenerator<
      MarmotGroup<THistory, TMedia>[]
    > {
      if (cancelled || signal?.aborted) return;
      listening = true;
      manager.on("updated", changed);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        // Capture the change version before loading. An update during the load
        // or between yields remains pending, even when there is no idle waiter.
        let yieldedVersion = -1;
        while (!cancelled) {
          if (yieldedVersion === version) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (cancelled) return;
          const snapshotVersion = version;
          // Cancellation must also wake a load waiting on storage, without
          // leaving its eventual rejection unhandled.
          const snapshot = await new Promise<
            MarmotGroup<THistory, TMedia>[] | undefined
          >((resolve, reject) => {
            cancelLoad = () => resolve(undefined);
            manager.loadAll().then(
              (groups) => {
                cancelLoad = undefined;
                resolve(groups);
              },
              (error) => {
                cancelLoad = undefined;
                reject(error);
              },
            );
          });
          if (cancelled || signal?.aborted || snapshot === undefined) return;
          yieldedVersion = snapshotVersion;
          yield [...snapshot];
        }
      } finally {
        cancel();
      }
    })();
    // Native generator return queues behind an outstanding next. Wake that
    // next first, then let the generator perform normal completion/error flow.
    return {
      next: (...args) => iterator.next(...args),
      return: (value) => {
        cancel();
        return iterator.return(value);
      },
      throw: (error) => {
        cancel();
        return iterator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async [Symbol.asyncDispose]() {
        cancel();
        await iterator.return(undefined);
      },
    };
  }
}
