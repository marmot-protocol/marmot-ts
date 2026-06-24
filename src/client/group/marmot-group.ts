/** @module @category Client - Group */
import type { EventSigner } from "applesauce-core/factories";
import { bytesToHex, type NostrEvent } from "applesauce-core/helpers/event";
import { Debugger } from "debug";
import { EventEmitter } from "eventemitter3";
import {
  CiphersuiteImpl,
  ClientState,
  CryptoProvider,
  defaultCryptoProvider,
  Proposal,
} from "ts-mls";

import type { ProposalAction, ProposalContext } from "../../engine/types.js";
import type { MediaAttachment } from "../../core/media.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import { mayReleaseOutbound } from "../../core/convergence-status.js";
import type { ConvergenceScheduler } from "../../engine/group-engine.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { GroupHistoryTree } from "../../engine/history-tree.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import { buildForkTreeView, type ForkTreeView } from "./fork-tree-view.js";
import { logger } from "../../utils/debug.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import {
  getMarmotGroupInfo,
  type MarmotGroupInfo,
  type SerializedClientState,
} from "../../core/client-state.js";
import {
  evaluateKeyPackageForGroup,
  type KeyPackageEligibility,
} from "../../core/key-package-eligibility.js";
import { GroupRuntime } from "../runtime/group-runtime.js";
import type {
  GroupPublishResult,
  GroupSessionSendIntent,
} from "../session/group-effects.js";
import {
  GroupSession,
  type DispositionedIngestResult,
  type GroupSessionHistory,
  type ProposalBuilder,
} from "../session/group-session.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { NostrWelcomeDelivery } from "../transport/nostr/welcome-delivery.js";
import {
  GroupMediaService,
  type EncryptMediaMetadata,
} from "./group-media-service.js";

export { createAdminCommitPolicyCallback } from "../../engine/admin-policy.js";
export type { ProposalAction, ProposalContext } from "../../engine/types.js";

/** An error that is thrown when a group has no relays available to send messages. */
export class NoGroupRelaysError extends Error {
  constructor() {
    super("Group has no relays available to send messages.");
  }
}

/** An error that is thrown the client is unable to find the MarmotGroupData in the ClientState of a group. */
export class NoMarmotGroupDataError extends Error {
  constructor() {
    super("MarmotGroupData not found in ClientState.");
  }
}

export type {
  DispositionedIngestResult,
  IngestResult,
  ProcessedIngestResult,
  RejectedIngestResult,
  SkippedIngestResult,
  DeferredIngestResult,
  InvalidatedIngestResult,
  AutoCommitIngestResult,
  RemovedIngestResult,
  UnreadableIngestResult,
} from "../session/group-session.js";
export { ingestResultDisposition } from "../session/group-session.js";

/**
 * The minimum interface for a group to store them MLS messages
 * Implementations should extend this with methods for querying and loading stored messages
 */
export interface BaseGroupHistory extends GroupSessionHistory {
  /** Saves a new application message to the group history */
  saveMessage(message: Uint8Array): Promise<void>;
  /** Purge the group history, called when group is destroyed */
  purgeMessages(): Promise<void>;
}

/** Shape of the stored media in a {@link BaseGroupMedia} implementation */
export type StoredMedia = {
  /** Plaintext (decrypted) file bytes. */
  data: Uint8Array;
  /** The full encrypted-media-v1 attachment metadata associated with this blob. */
  attachment: MediaAttachment;
};

/** A factory function that creates a {@link BaseGroupHistory} instance for a group id */
export type GroupHistoryFactory<
  THistory extends BaseGroupHistory | undefined = undefined,
> = (groupId: Uint8Array) => THistory;

/** The minimal implementation of a group media store */
export interface BaseGroupMedia {
  /** Adds a new media entry to the group media store */
  addMedia(sha256: string, entry: StoredMedia): Promise<void>;
  /** Retrieves a media entry from the group media store */
  getMedia(sha256: string): Promise<StoredMedia | null>;
  /** Removes a media entry from the group media store */
  removeMedia(sha256: string): Promise<void>;
  /** Lists all media entries in the group media store */
  listMedia(): Promise<MediaAttachment[]>;
  /** Clears all media entries from the group media store */
  clearMedia(): Promise<void>;
}

/** A factory function that creates a {@link BaseGroupHistory} instance for a group id */
export type GroupMediaFactory<
  TMedia extends BaseGroupMedia | undefined = undefined,
> = (groupId: Uint8Array) => TMedia;

export type MarmotGroupOptions<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> = {
  /** The key-value backend where serialized group state bytes are persisted */
  store: GenericKeyValueStore<SerializedClientState>;
  /**
   * Dedicated backend for the rewind-history blob (one entry per group). When
   * provided, the convergence rewind window survives a restart. Optional —
   * omitted means rewind history is in-memory only (legacy behavior).
   */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /** The signer used for the clients identity */
  signer: EventSigner;
  /** The ciphersuite implementation to use for the group */
  ciphersuite: CiphersuiteImpl;
  /** The nostr relay pool to use for the group. Should implement GroupNostrInterface for group operations. */
  network: NostrNetworkInterface;
  /** Optional forensic audit sink. Omitted by default; audit logging is app opt-in. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
  /**
   * Convergence policy (branch selection + `maxRewindCommits` rollback horizon).
   * Set `maxRewindCommits: Infinity` to keep forks of any age eligible for
   * re-convergence. Defaults to the profile-1 policy.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Tuning for the persistent ingestion pool (size + epoch-age bounds on
   * undecryptable events held for retry). Defaults bound it.
   */
  ingestionPool?: IngestionPoolOptions;
  /** The storage interface for the groups application message history (optional) */
  history?: THistory | GroupHistoryFactory<THistory>;
  /**
   * Backend (or pre-wrapped store) for the plaintext blob cache used by
   * {@link MarmotGroup.decryptMedia}. Defaults to an in-memory cache when
   * not provided.
   */
  media?: TMedia | GroupMediaFactory<TMedia>;
  /**
   * Injectable wall-clock (ms) for the convergence quiescence window (B5).
   * Defaults to `Date.now`; tests inject a fake clock for determinism.
   */
  now?: () => number;
  /**
   * Quiescence window (ms) before convergence may be treated as settled
   * (`convergence.md` `settlementQuiescenceMs`). Defaults to the profile-1 value.
   */
  settlementQuiescenceMs?: number;
  /**
   * Injectable settle-check timer for releasing queued outbound work (B5).
   * Defaults to `setTimeout`; tests pass a controllable fake.
   */
  scheduler?: ConvergenceScheduler;
  /**
   * The bounded convergence window, derived from the history tree on load. Set
   * by the loader ({@link GroupRegistry}); not part of the public construction
   * API.
   */
  retained?: RetainedHistoryStore;
  /**
   * A full-fork history tree rehydrated from {@link rewindStore} on load. Set by
   * the loader ({@link GroupRegistry}); not part of the public construction API.
   */
  historyTree?: GroupHistoryTree;
};

/** Map of events that can be emitted by a MarmotGroup */
export type MarmotGroupEvents<
  THistory extends BaseGroupHistory | undefined = any,
  TMedia extends BaseGroupMedia | undefined = any,
> = {
  /** Emitted when the group state is updated */
  stateChanged: (state: ClientState) => void;
  /** Emitted when a new application message is received */
  applicationMessage: (message: Uint8Array) => void;
  /** Emitted when the group state is saved */
  stateSaved: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when the group is destroyed */
  destroyed: (group: MarmotGroup<THistory, TMedia>) => void;
  /**
   * Emitted when an inbound commit removed this member from the group — an
   * admin's involuntary Remove, or a peer committing this member's own
   * self_remove. Local state is kept as a `removedFromGroup` tombstone (it is
   * persisted, but the group can no longer send or decrypt); the application
   * decides when to call {@link MarmotGroup.destroy} to purge it.
   */
  removed: (group: MarmotGroup<THistory, TMedia>) => void;
  /** Emitted when history persistence fails (best-effort, non-blocking) */
  historyError: (error: Error) => void;
  /**
   * Emitted when the fork-history tree grew during ingest — a new commit or a
   * newly observed fork branch. Fires even when the canonical state is
   * unchanged (a superseded fork still adds nodes). Read {@link forkTreeView}
   * to re-render.
   */
  historyChanged: (group: MarmotGroup<THistory, TMedia>) => void;
};

/**
 * The main class for interacting with a MLS group
 * @template THistory - The type of the history store to use for the group, must implement the {@link BaseGroupHistory} interface. (Default is no history store)
 */
export class MarmotGroup<
  THistory extends BaseGroupHistory | undefined = undefined,
  TMedia extends BaseGroupMedia | undefined = undefined,
> extends EventEmitter<MarmotGroupEvents<THistory, TMedia>> {
  /** The key-value backend where serialized group state bytes are persisted */
  readonly store: GenericKeyValueStore<SerializedClientState>;

  /** The signer used for the clients identity */
  readonly signer: EventSigner;

  /** The ciphersuite implementation to use for the group */
  readonly ciphersuite: CiphersuiteImpl;

  /** The nostr relay pool to use for the group */
  readonly network: NostrNetworkInterface;

  /** The storage interface for the groups application message history */
  readonly history: THistory;

  /** The storage interface for the groups media */
  readonly media: TMedia;

  /** Protocol state owner for this group. Prefer this over convenience methods. */
  readonly session: GroupSession<THistory>;
  /** Runtime publisher for driving session effects through transport. */
  readonly runtime: GroupRuntime;
  /** Optional media helper for group encrypted attachments. */
  readonly mediaService: GroupMediaService<TMedia>;

  /**
   * Outbound intents held while convergence is not `Settled` (B5). Each entry
   * keeps the caller's promise open until the intent is built, encrypted, and
   * published at drain time — so a commit is regenerated against the canonical
   * post-settle state and never reuses a pre-selection staged commit.
   */
  readonly #outboundQueue: Array<{
    intent: GroupSessionSendIntent;
    resolve: (results: GroupPublishResult[]) => void;
    reject: (error: unknown) => void;
  }> = [];

  private log: Debugger;

  get id() {
    return this.session.id;
  }

  /** The group id as a hex string */
  idStr: string;

  /** Read the current group state */
  get state() {
    return this.session.state;
  }

  /**
   * The group's lifecycle state (`group-state.md`). A new local commit may only
   * be prepared while `Stable`; the commit flow moves through `PendingPublish`
   * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
   * commit applying) and back to `Stable`.
   */
  get lifecycle() {
    return this.session.lifecycle;
  }

  /**
   * The group's derived convergence status (`group-state.md` §Convergence
   * status, B5): `Syncing` / `Resolving` / `Settled` / `Blocked`. Recomputed on
   * read against the clock, so it advances to `Settled` once the quiescence
   * window elapses with no further convergence-relevant input.
   */
  get convergenceStatus() {
    return this.session.convergenceStatus;
  }

  get groupData() {
    return this.session.groupData;
  }

  /** Complete group info/debug model for chat panels and diagnostics. */
  get info(): MarmotGroupInfo {
    return getMarmotGroupInfo(this.state);
  }

  /**
   * The live full-fork history tree: every group state observed (the canonical
   * branch and every fork), keyed by MLS confirmation tag. Exposes synchronous
   * structural queries (`node`, `childrenOf`, `tips`, `path`, `ancestors`,
   * `lowestCommonAncestor`) and async snapshot access (`stateAt`,
   * `commitMessageOf`). For a serializable rendering snapshot use
   * {@link forkTreeView}.
   */
  get forkTree(): GroupHistoryTree {
    return this.session.historyTree;
  }

  /**
   * A plain, serializable snapshot of the fork-history tree for debugging UIs —
   * every node with its epoch, parent/children, tip flag, and whether it lies on
   * the canonical path to the live tip (the branch convergence settled on, i.e.
   * the node matching {@link state}). Computed on demand.
   */
  forkTreeView(): ForkTreeView {
    return buildForkTreeView(
      this.session.historyTree,
      bytesToHex(this.state.confirmationTag),
    );
  }

  /**
   * Evaluates whether a candidate's KeyPackage event (kind 30443) can be added
   * to this group — cipher-suite match, `required_capabilities`,
   * agent-text-stream-QUIC `required_member_roles`, and already-a-member. Use
   * this before {@link GroupsManager.invite} to surface why a KeyPackage can't be
   * added; an `eligible: true` result is safe to invite. Never throws.
   */
  evaluateKeyPackage(keyPackageEvent: NostrEvent): KeyPackageEligibility {
    return evaluateKeyPackageForGroup(this.state, keyPackageEvent);
  }

  get unappliedProposals() {
    return this.session.unappliedProposals;
  }

  get dirty() {
    return this.session.dirty;
  }

  /**
   * Overrides the current group state
   * @warning It is not recommended to use this
   */
  set state(newState: ClientState) {
    this.session.state = newState;
  }

  get relays() {
    return this.groupData?.relays;
  }

  constructor(
    state: ClientState,
    options: MarmotGroupOptions<THistory, TMedia>,
  ) {
    super();
    this.store = options.store;
    this.signer = options.signer;
    this.ciphersuite = options.ciphersuite;
    this.network = options.network;

    if (options.history) {
      if (typeof options.history === "function") {
        this.history = options.history(state.groupContext.groupId);
      } else {
        this.history = options.history;
      }
    } else {
      this.history = undefined as THistory;
    }

    this.session = new GroupSession({
      state,
      ciphersuite: this.ciphersuite,
      store: this.store,
      rewindStore: options.rewindStore,
      retained: options.retained,
      historyTree: options.historyTree,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      history: this.history,
      now: options.now,
      settlementQuiescenceMs: options.settlementQuiescenceMs,
      scheduler: options.scheduler,
      audit: options.audit,
      auditContext: options.auditContext,
      // When the quiescence window elapses, release any queued outbound (B5).
      onSettleCheck: () => this.#drainOutbound(),
      onStateChanged: (newState) => this.emit("stateChanged", newState),
      onStateSaved: () => this.emit("stateSaved", this),
      onApplicationMessage: (message) =>
        this.emit("applicationMessage", message),
      onHistoryError: (error) => this.emit("historyError", error),
    });

    if (options.media) {
      if (typeof options.media === "function") {
        this.media = options.media(this.id);
      } else {
        this.media = options.media;
      }
    } else {
      this.media = undefined as TMedia;
    }

    this.idStr = bytesToHex(this.id);
    this.log = logger.extend(`group:${this.idStr.slice(0, 8)}`);
    this.runtime = new GroupRuntime({
      welcomeDelivery: new NostrWelcomeDelivery({
        signer: this.signer,
        network: this.network,
      }),
      getNetwork: () => this.network,
      getRelays: () => this.relays,
      getGroupRef: () => this.idStr,
      getGroupData: () => this.groupData,
      confirmPublished: (pending) => this.session.confirmPublished(pending),
      publishFailed: (pending) => this.session.publishFailed(pending),
      save: () => this.save(),
      log: this.log,
      audit: options.audit,
      auditContext: options.auditContext,
    });
    this.mediaService = new GroupMediaService({
      media: this.media,
      getState: () => this.state,
      getCiphersuite: () => this.ciphersuite,
    });
  }

  /** Creates a new {@link MarmotGroup} instance from a {@link ClientState} object */
  static async fromClientState<
    THistory extends BaseGroupHistory | undefined = undefined,
    TMedia extends BaseGroupMedia | undefined = undefined,
  >(
    state: ClientState,
    options: Omit<MarmotGroupOptions<THistory, TMedia>, "ciphersuite"> & {
      cryptoProvider?: CryptoProvider;
    },
  ): Promise<MarmotGroup<THistory, TMedia>> {
    const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const cipherSuite = await cryptoProvider.getCiphersuiteImpl(
      state.groupContext.cipherSuite,
    );

    return new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
  }

  /**
   * Persists any pending changes to the group state in the store.
   *
   * @param force - When `true`, writes the current state even if `dirty` is
   *   `false`. Useful for persisting the initial state of a freshly constructed
   *   group (e.g. after `createGroup` / `joinGroupFromWelcome` / import) without
   *   having to mutate `dirty` externally.
   */
  async save(force = false) {
    await this.session.save(force);
  }

  /**
   * Performs a self-update commit (no proposals) to rotate this member's leaf key material.
   *
   * This is required by MIP-02 for forward secrecy after joining from a Welcome.
   *
   * Unlike admin commits (see {@link GroupsManager.commit}), this operation is
   * allowed for non-admin members.
   */
  async selfUpdate(): Promise<Record<string, PublishResponse>> {
    this.log("self-update commit");
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const [result] = await this.submitIntent({ kind: "selfUpdate" });
    return result.response;
  }

  /**
   * Creates and publishes a proposal as a private MLS message.
   * @returns Promise resolving to the publish response from the relays
   */
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    action: ProposalBuilder<Args, T>,
    ...args: Args
  ): Promise<Record<string, PublishResponse>>;
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    action: ProposalAction<T>,
  ): Promise<Record<string, PublishResponse>>;
  async propose<Args extends unknown[], T extends Proposal | Proposal[]>(
    ...args: Args
  ): Promise<Record<string, PublishResponse>> {
    const groupData = this.groupData;
    if (!groupData) throw new NoMarmotGroupDataError();

    const context: ProposalContext = this.session.proposalContext();

    let proposals: T;
    if (args.length === 1) {
      proposals = await (args[0] as ProposalAction<T>)(context);
    } else {
      proposals = await (args[0] as ProposalBuilder<Args, T>)(...args)(context);
    }

    if (!proposals) {
      throw new Error("Proposal is undefined. This should not happen.");
    }

    const proposalArray = Array.isArray(proposals) ? proposals : [proposals];

    const responses: Record<string, PublishResponse> = {};
    for (const proposal of proposalArray) {
      const response = await this.sendProposal(proposal as Proposal);
      Object.assign(responses, response);
    }

    return responses;
  }

  /** Sends a proposal to the group relays */
  async sendProposal(
    proposal: Proposal,
  ): Promise<Record<string, PublishResponse>> {
    const [result] = await this.submitIntent({ kind: "proposal", proposal });
    return result.response;
  }

  /**
   * Convergence-gated outbound entry point (B5). While convergence is `Settled`
   * and the lifecycle allows outbound, the intent is built, encrypted, and
   * published immediately. Otherwise it is queued and the returned promise stays
   * pending until the quiescence window settles and the queue drains — so app
   * payloads are held, and group-state commits are (re)generated only against the
   * canonical post-settle state. `leave()` and the self_remove auto-committer
   * bypass this gate by design (departures and convergence progress, not fresh
   * local intents).
   */
  async submitIntent(
    intent: GroupSessionSendIntent,
  ): Promise<GroupPublishResult[]> {
    if (mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)) {
      return this.#sendNow(intent);
    }
    this.log(
      "queueing %s — convergence %s, lifecycle %s",
      intent.kind,
      this.session.convergenceStatus,
      this.lifecycle,
    );
    return new Promise<GroupPublishResult[]>((resolve, reject) => {
      this.#outboundQueue.push({ intent, resolve, reject });
    });
  }

  /** Builds + publishes an intent's effects immediately (no gating). */
  async #sendNow(
    intent: GroupSessionSendIntent,
  ): Promise<GroupPublishResult[]> {
    const effects = await this.session.send(intent);
    return this.runtime.publishEffects(effects);
  }

  /**
   * Releases queued outbound while convergence is `Settled` and the lifecycle
   * allows outbound (B5). Drains FIFO so send order is preserved; re-checks the
   * gate each iteration so a fork arriving mid-drain re-queues the remainder.
   */
  async #drainOutbound(): Promise<void> {
    while (
      this.#outboundQueue.length > 0 &&
      mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)
    ) {
      const item = this.#outboundQueue.shift()!;
      try {
        item.resolve(await this.#sendNow(item.intent));
      } catch (error) {
        item.reject(error);
      }
    }
  }

  /** Rejects and clears every queued outbound intent (teardown / removal). */
  #rejectQueuedOutbound(reason: string): void {
    if (this.#outboundQueue.length === 0) return;
    const error = new Error(reason);
    for (const item of this.#outboundQueue.splice(0)) item.reject(error);
  }

  /**
   * ingests an array of group messages and applies commits to the group state.
   *
   * Processing happens in two stages:
   * 1. Process all non-commit messages (proposals, application messages)
   *    - If a message fails to process, it's added to unreadable for retry
   * 2. Process commits according to MIP-03 (sorted by epoch, timestamp, event id)
   *    - Commits advance the epoch and update the group state
   *
   * After both stages, recursively retry unreadable messages until no more can be read.
   * Events that can never be processed are yielded as {@link UnreadableIngestResult}.
   *
   * @param events - Array of Nostr events containing encrypted MLS messages
   * @yields DispositionedIngestResult - The processing result plus its
   *   inbound-processing {@link Disposition}.
   */
  async *ingest(
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    // The fork-history tree can grow during ingest (new commits / forks) without
    // the canonical state changing — track its size to emit `historyChanged`.
    const historySizeBefore = this.session.historyTree.size;
    for await (const result of this.session.ingest(events, options)) {
      // The engine elected us to commit a peer's departure (B6): publish the
      // staged self_remove-only commit (publish-before-apply). On publish
      // failure the staged commit is rolled back and the self_remove stays
      // pending, so a later ingest re-elects and retries — swallow the throw so
      // it does not abort delivery of the rest of the batch.
      if (result.kind === "autoCommit") {
        try {
          await this.runtime.publishCommit({
            envelope: result.event,
            pending: result.pending,
            actorPubkey: result.actorPubkey,
          });
        } catch {
          /* rolled back; retried on a later ingest */
        }
      }

      // An inbound commit removed us (involuntary Remove, or a peer committing
      // our own self_remove). The session has already applied + persisted the
      // `removedFromGroup` tombstone; surface it so the app can react. Per the
      // chosen policy we keep the tombstone rather than auto-destroying — the
      // app calls destroy() when it wants to purge.
      if (result.kind === "removed") {
        this.log("removed from group by inbound commit");
        // The tombstone can never send again; fail any queued outbound (B5).
        this.#rejectQueuedOutbound("Removed from group; outbound cancelled.");
        this.emit("removed", this);
      }
      yield result;
    }
    if (this.session.historyTree.size !== historySizeBefore)
      this.emit("historyChanged", this);
  }

  /**
   * Encrypts a media file for sharing in a group message (encrypted-media-v1).
   *
   * Derives the per-file key from the current MLS epoch, encrypts with
   * ChaCha20-Poly1305, and returns the ciphertext alongside a populated
   * {@link MediaAttachment} (hashes, nonce, media type, filename) with no
   * locators yet.
   *
   * **Caller responsibilities:**
   * 1. Upload `encrypted` to a blob store (`ciphertextSha256` is the content id).
   * 2. Push a locator (`{ kind, value }`) onto `attachment.locators`.
   * 3. Serialize with `encodeMediaImetaTag` and include the tag on the rumor.
   */
  async encryptMedia(
    blob: Blob,
    metadata: EncryptMediaMetadata,
  ): Promise<{ encrypted: Uint8Array; attachment: MediaAttachment }> {
    return this.mediaService.encryptMedia(blob, metadata);
  }

  /**
   * Decrypts an encrypted-media-v1 attachment downloaded from a blob store.
   *
   * On the first call for a given file the plaintext bytes are derived via
   * key-derivation + ChaCha20-Poly1305 decryption (after verifying the
   * ciphertext and plaintext hashes) and stored in {`@link` media}. Subsequent
   * calls for the same `attachment.ciphertextSha256` are served directly from
   * the cache, skipping key-derivation entirely.
   */
  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
  ): Promise<StoredMedia> {
    return this.mediaService.decryptMedia(encrypted, attachment);
  }

  /**
   * Releases in-memory resources without touching persisted state (B5): cancels
   * the settle-check timer and fails any queued outbound. Call on unload so a
   * timer/promise does not outlive the cached instance.
   */
  dispose() {
    this.session.dispose();
    this.#rejectQueuedOutbound("Group unloaded; outbound cancelled.");
  }

  /** Destroys the group and purges the group history */
  async destroy() {
    this.log("destroying group");

    // Stop the settle timer and fail queued outbound before tearing down (B5).
    this.dispose();

    this.log("clearing group media");
    if (this.media) await this.media.clearMedia();

    this.log("removing group from store");
    await this.session.destroyLocalState();

    this.emit("destroyed", this);
  }
}
