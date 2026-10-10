/** @module @category Client - Session */
import { deserializeApplicationData } from "../../core/application-rumor.js";
import {
  encodeDeliveredEvidence,
  decodeDeliveredEvidence,
} from "./delivered-payload-store.js";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  getCredentialFromLeafIndex,
  appDataUpdateProposalType,
  type CiphersuiteImpl,
  type ClientState,
  type LeafIndex,
  type Proposal,
} from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getAdminPolicy } from "../../core/components/dictionary.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";

import type { GroupProfileSupport } from "../../core/components/account-identity-proof.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../core/components/ids.js";
import {
  getMarmotGroupView,
  serializeClientState,
  type MarmotGroupView,
  type SerializedClientState,
} from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { Disposition } from "../../core/inbound.js";
import { getCredentialPubkey } from "../../core/credential.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import type { DisbandRequest } from "../../engine/disband-request.js";
import {
  disbandConvergenceKey,
  disbandRequestKey,
} from "../../engine/disband-request.js";
import {
  decodeDisbandTombstone,
  disbandRegistryStateKey,
  disbandTombstoneKey,
  encodeDisbandTombstone,
  type DisbandTombstone,
} from "../../engine/disband-tombstone.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import type {
  DispositionedIngestResult as EngineDispositionedIngestResult,
  IngestResult as EngineIngestResult,
  PendingState,
  ProposalContext,
  DisbandCandidateEvidence,
} from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
} from "../group/wrapper-ledger.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
import type {
  GroupEffects,
  GroupPublishWork,
  GroupSessionSendIntent,
} from "./group-effects.js";

/**
 * Public session results are the engine result union with the transport field
 * renamed at the Nostr boundary. Keeping this transformation distributive
 * makes new engine fields and variants flow through without a parallel union
 * that can silently drift (WR-12).
 */
type SessionIngestResult<TResult extends EngineIngestResult<NostrEvent>> =
  TResult extends { envelope: NostrEvent }
    ? Omit<TResult, "envelope"> & { event: NostrEvent }
    : TResult;

type EngineIngestResultOfKind<
  TKind extends EngineIngestResult<NostrEvent>["kind"],
> = Extract<EngineIngestResult<NostrEvent>, { kind: TKind }>;

export type ProcessedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"processed">
>;
export type RejectedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"rejected">
>;
export type SkippedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"skipped">
>;
export type UnreadableIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"unreadable">
>;
export type DeferredIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"deferred">
>;
export type InvalidatedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"invalidated">
>;
export type AutoCommitIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"autoCommit">
>;
export type RemovedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"removed">
>;
export type StateInvalidatedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"stateInvalidated">
>;
export type AppliedNotificationsIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"appliedNotifications">
>;
export type StateRevalidatedIngestResult = SessionIngestResult<
  EngineIngestResultOfKind<"stateRevalidated">
>;

export type IngestResult = SessionIngestResult<EngineIngestResult<NostrEvent>>;

export type DispositionedIngestResult = IngestResult & {
  disposition: Disposition;
};

export interface GroupSessionHistory {
  saveMessage(message: Uint8Array): Promise<void>;
  purgeMessages(): Promise<void>;
  /** Idempotent durable retraction by canonical inner rumor ID. */
  removeMessage(rumorId: string): Promise<void>;
}

export type GroupSessionOptions<
  THistory extends GroupSessionHistory | undefined = undefined,
> = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore?: GenericKeyValueStore<Uint8Array>;
  /** Durable lifecycle request/terminal store (defaults to ingestStateStore). */
  lifecycleStore?: GenericKeyValueStore<Uint8Array>;
  /**
   * Dedicated store for the full-fork history tree (per-node keys under a hex
   * group-id prefix). When set, the tree is flushed on {@link GroupSession.save}
   * and survives a restart. Optional — when omitted, history is in-memory only
   * and rebuilt from the current tip after each restart.
   */
  rewindStore?: GenericKeyValueStore<Uint8Array>;
  /** Group-scoped removal marker backend, potentially shared with state storage. */
  removedMarkerStore?: GenericKeyValueStore<boolean>;
  /**
   * The bounded convergence window, derived from the history tree on load (never
   * persisted separately). Set by the loader ({@link GroupRegistry}); fresh
   * groups seed it from the current tip.
   */
  retained?: RetainedHistoryStore;
  /**
   * A full-fork history tree rehydrated from {@link rewindStore} on load. When
   * omitted and a `rewindStore` is set, a fresh tree is bound to that store and
   * flushed on {@link GroupSession.save}.
   */
  historyTree?: GroupHistoryTree;
  /**
   * Convergence policy (branch selection + `maxRewindCommits` rollback horizon).
   * Keep the finite profile-1 default for production. `Infinity` is an explicit
   * debugging/forensics choice that can retain unbounded fork evidence.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Tuning for the persistent ingestion pool (undecryptable events held and
   * retried as the history tree grows): max entries and max epoch-age before an
   * unresolved entry is given up. Defaults bound it; a debugging tool that wants
   * to retain everything can raise both.
   */
  ingestionPool?: IngestionPoolOptions;
  history?: THistory;
  onStateChanged?: (state: ClientState) => void;
  onStateSaved?: () => void;
  onApplicationMessage?: (message: Uint8Array) => void;
  onHistoryError?: (error: Error) => void;
  onHistoryChanged?: () => void;
  /** Injectable wall-clock for the convergence quiescence window (B5; tests). */
  now?: () => number;
  /** Quiescence window (ms) before convergence may be treated as settled. */
  settlementQuiescenceMs?: number;
  /** Injectable settle-check timer (B5); defaults to `setTimeout`. */
  scheduler?: import("../../engine/group-engine.js").ConvergenceScheduler;
  /** Fired when the quiescence window elapses, so the owner can drain queued outbound (B5). */
  onSettleCheck?: () => void | Promise<void>;
  /** Optional forensic audit sink. Omitted by default; audit logging is app opt-in. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
};

export function ingestResultDisposition(result: IngestResult): Disposition {
  if (
    result.kind === "stateInvalidated" ||
    result.kind === "appliedNotifications" ||
    result.kind === "stateRevalidated"
  )
    return engineIngestResultDisposition(
      result as EngineIngestResult<NostrEvent>,
    );
  const { event, ...rest } = result;
  return engineIngestResultDisposition({
    ...rest,
    envelope: event,
  } as EngineIngestResult<NostrEvent>);
}

function mapEngineIngestResult(
  result: EngineDispositionedIngestResult<NostrEvent>,
): DispositionedIngestResult {
  // A withdrawal has no `envelope` to rename to `event` — pass it through
  // unchanged (D-11).
  if (
    result.kind === "stateInvalidated" ||
    result.kind === "appliedNotifications" ||
    result.kind === "stateRevalidated"
  )
    return result;
  const { envelope, disposition, ...rest } = result;
  return { ...rest, event: envelope, disposition };
}

export class GroupSession<
  THistory extends GroupSessionHistory | undefined = undefined,
> {
  readonly ciphersuite: CiphersuiteImpl;
  readonly store: GenericKeyValueStore<SerializedClientState>;
  readonly rewindStore?: GenericKeyValueStore<Uint8Array>;
  readonly ingestStateStore?: GenericKeyValueStore<Uint8Array>;
  readonly lifecycleStore?: GenericKeyValueStore<Uint8Array>;
  readonly #removedMarkerStore?: GenericKeyValueStore<boolean>;
  readonly history: THistory;

  readonly #engine: MarmotGroupEngine<NostrEvent>;
  readonly #peeler: NostrGroupPeeler;
  readonly #sentEventIds = new Set<string>();
  readonly #wrapperLedger?: TerminalWrapperLedger;
  readonly #effectLedger?: ConvergenceEffectLedger;

  #groupData: MarmotGroupView | null = null;
  #dirty = false;
  #destroyed = false;
  #disposed = false;
  readonly #localWrites = new Set<Promise<unknown>>();
  #terminalTombstone: DisbandTombstone | undefined;
  readonly #terminalHydrated: Promise<void>;
  readonly #deliveredHydrated: Promise<void>;
  readonly #pendingRetractions = new Map<
    string,
    import("../../engine/delivered-payloads.js").DeliveredAppPayload<NostrEvent>
  >();

  readonly #onStateChanged?: (state: ClientState) => void;
  readonly #onStateSaved?: () => void;
  readonly #onApplicationMessage?: (message: Uint8Array) => void;
  readonly #onHistoryError?: (error: Error) => void;
  readonly #onHistoryChanged?: () => void;

  constructor(options: GroupSessionOptions<THistory>) {
    this.ciphersuite = options.ciphersuite;
    this.store = options.store;
    this.rewindStore = options.rewindStore;
    this.ingestStateStore = options.ingestStateStore;
    this.lifecycleStore = options.lifecycleStore ?? options.ingestStateStore;
    this.#removedMarkerStore = options.removedMarkerStore;
    this.history = options.history as THistory;
    this.#onStateChanged = options.onStateChanged;
    this.#onStateSaved = options.onStateSaved;
    this.#onApplicationMessage = options.onApplicationMessage;
    this.#onHistoryError = options.onHistoryError;
    this.#onHistoryChanged = options.onHistoryChanged;

    this.#peeler = new NostrGroupPeeler(this.ciphersuite);
    if (this.ingestStateStore) {
      const groupId = bytesToHex(options.state.groupContext.groupId);
      this.#wrapperLedger = new TerminalWrapperLedger(
        this.ingestStateStore,
        groupId,
      );
      this.#effectLedger = new ConvergenceEffectLedger(
        this.ingestStateStore,
        groupId,
      );
    }
    this.#engine = new MarmotGroupEngine({
      state: options.state,
      ciphersuite: this.ciphersuite,
      peeler: this.#peeler,
      retained: options.retained,
      historyTree: options.historyTree,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      now: options.now,
      settlementQuiescenceMs: options.settlementQuiescenceMs,
      scheduler: options.scheduler,
      onSettleCheck: async () => {
        await this.#deliveredHydrated;
        if (this.#destroyed || this.#disposed) return;
        try {
          await options.onSettleCheck?.();
        } catch (error) {
          if (!this.#destroyed && !this.#disposed) throw error;
        }
      },
      audit: options.audit,
      auditContext: options.auditContext,
      // Engine lifecycle writes also occur outside awaited session calls (for
      // example when a confirmed epoch refreshes a pending request). Route
      // every such write through the same destruction barrier.
      lifecycleStore: this.lifecycleStore && {
        getItem: (key) => this.lifecycleStore!.getItem(key),
        keys: () => this.lifecycleStore!.keys(),
        setItem: async (key, value) => {
          await this.#write(() => this.lifecycleStore!.setItem(key, value));
          return value;
        },
        removeItem: async (key) => {
          await this.#write(() => this.lifecycleStore!.removeItem(key));
        },
        clear: async () => {
          await this.#write(() => this.lifecycleStore!.clear());
        },
      },
      onStateChanged: (newState) => {
        if (this.#destroyed || this.#disposed) return;
        this.#dirty = true;
        this.#groupData = null;
        this.#onStateChanged?.(newState);
      },
    });

    // Persist the full-fork history tree to the rewind store. A rehydrated tree
    // (loaded form) is already bound; a fresh one is bound here so its nodes
    // flush on the next save.
    if (this.rewindStore && !options.historyTree)
      this.#engine.history.bindStore(this.rewindStore);
    this.#terminalHydrated = this.#hydrateDisbandTombstone();
    this.#deliveredHydrated = this.#hydrateDelivered();
  }

  get id(): Uint8Array {
    return this.state.groupContext.groupId;
  }

  get state(): ClientState {
    return this.#engine.state;
  }

  set state(newState: ClientState) {
    this.#engine.state = newState;
  }

  get lifecycle() {
    return this.#engine.lifecycle;
  }

  /**
   * Whether this group's canonical GroupContext still classifies as the
   * current account identity proof profile (D-11). Orthogonal to `lifecycle`:
   * an unsupported group can still be `Stable` — it stays listable and
   * `destroy()`-able, but every outbound `send` and every inbound envelope is
   * refused. Delegates to the engine, which recomputes this on every access.
   */
  get profileSupport(): GroupProfileSupport {
    return this.#engine.profileSupport;
  }

  /** The derived convergence status (`group-state.md` §Convergence status, B5). */
  get convergenceStatus() {
    return this.#engine.convergenceStatus;
  }

  get groupData(): MarmotGroupView | null {
    if (!this.#groupData) this.#groupData = getMarmotGroupView(this.state);
    return this.#groupData;
  }

  get relays(): string[] | undefined {
    return this.groupData?.relays;
  }

  /** The full-fork history tree (every observed state, canonical + forks). */
  get historyTree(): GroupHistoryTree {
    return this.#engine.history;
  }

  /**
   * The retained canonical states within the rollback horizon, newest epoch
   * first — the candidate epochs for cross-epoch encrypted-media decryption
   * (see {@link MarmotGroupEngine.retainedStates}).
   */
  retainedStates(): ClientState[] {
    return this.#engine.retainedStates();
  }

  /**
   * Transport events received but not yet decrypted/processed into the history
   * tree — the engine's ingestion pool (undecryptable-so-far events held for
   * retry as the tree grows).
   */
  pendingEvents(): NostrEvent[] {
    return this.#engine.pendingEnvelopes();
  }

  /**
   * Transport events retained but not yet processed because a commit
   * publication or merge is in progress (or a convergence pass reached its
   * cutoff). Like {@link pendingEvents}, they exist only in memory until a
   * later convergence pass processes them.
   */
  retainedEvents(): NostrEvent[] {
    return this.#engine.retainedConvergenceInput();
  }

  get unappliedProposals() {
    return this.state.unappliedProposals;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** Refuses stale preparation, publication and confirmation after teardown. */
  get destroyed(): boolean {
    return this.#destroyed;
  }

  assertOpen(): void {
    if (this.#destroyed) throw new Error("Group destroyed");
    if (this.#disposed) throw new Error("Group unloaded");
  }

  /** Serializable identity of the canonical parent, including same-epoch forks. */
  get parentToken(): string {
    const { groupContext, confirmationTag } = this.state;
    return bytesToHex(
      sha256(
        new TextEncoder().encode(
          JSON.stringify([
            "marmot/group-parent/v1",
            bytesToHex(groupContext.groupId),
            groupContext.epoch.toString(),
            bytesToHex(confirmationTag),
            bytesToHex(groupContext.treeHash),
            bytesToHex(groupContext.confirmedTranscriptHash),
          ]),
        ),
      ),
    );
  }

  /** Track a whole admitted operation, including engine I/O between awaits. */
  async #whileOpen<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = await this.#write(async () => {
      let value: T;
      try {
        value = await operation();
      } catch (error) {
        this.assertOpen();
        throw error;
      }
      this.assertOpen();
      return { value };
    });
    this.assertOpen();
    if (!result) throw new Error("Group destroyed");
    return result.value;
  }

  async save(force = false): Promise<void> {
    await this.#terminalHydrated;
    await this.#deliveredHydrated;
    if (this.#destroyed || this.#disposed || this.#terminalTombstone) return;
    // The history tree can grow without the canonical state changing — a fork
    // whose incoming branch is superseded still records the losing branch — so
    // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
    const treeDirty = !!this.rewindStore && this.#engine.history.isDirty;
    if (!force && !this.#dirty && !treeDirty) {
      await this.#persistDelivered();
      return;
    }

    const idHex = bytesToHex(this.id);
    // Persist the full-fork history tree — the single source for fork recovery
    // across restarts. Append-only flush of any new nodes (O(new nodes)). The
    // bounded convergence window is rebuilt from the tree on load.
    await this.#write(() => this.#engine.persistDisbandConvergence());
    if (this.rewindStore) await this.#write(() => this.#engine.history.flush());
    // Restored delivered evidence must reference durable branch nodes, while
    // terminal convergence evidence must precede any fallible history write.
    await this.#persistDelivered();
    const stateBytes = serializeClientState(this.state);
    await this.#write(() => this.store.setItem(idHex, stateBytes));
    if (this.#destroyed || this.#disposed) return;
    this.#dirty = false;
    this.#onStateSaved?.();
  }

  /**
   * Re-scores the persisted fork history against the current tip and switches to
   * the canonical branch if a competing fork now wins (`convergence.md`), then
   * persists a resulting switch. Sources candidates from the history tree, so a
   * client that diverged onto a losing fork converges from disk without waiting
   * for the network to re-deliver the winning branch. Called on load.
   *
   * Returns the pass's results in the same shape {@link ingest} yields, so the
   * caller can route them through the identical handler — in particular the
   * `stateInvalidated` withdrawal that clears the removed-inactive marker
   * (CONV-03, D-12). This layer used to swallow them (CR-06).
   */
  async reconverge(): Promise<DispositionedIngestResult[]> {
    await this.#deliveredHydrated;
    if (this.#destroyed) return [];
    await this.#retryRetractions();
    const results: DispositionedIngestResult[] = [];
    for (const result of await this.#engine.reconvergeFromHistory())
      results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
    await this.save();
    return results;
  }

  /** Runs one retained-input scheduler edge through the normal reconciliation seam. */
  async driveConvergence(): Promise<DispositionedIngestResult[]> {
    await this.#deliveredHydrated;
    if (this.#destroyed) return [];
    await this.#retryRetractions();
    const results: DispositionedIngestResult[] = [];
    for (const result of await this.#engine.driveConvergence())
      results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
    await this.#persistSelectedDisbandIfPossible(
      this.#engine.selectedDisbandEvidence,
    );
    await this.save();
    return results;
  }

  /** Close admission synchronously, before asynchronous media/store cleanup. */
  beginDestroy(): void {
    this.#destroyed = true;
    this.#engine.dispose();
    this.#engine.destroyDeliveredPayloads();
    this.#pendingRetractions.clear();
  }

  /** Track local writes so destruction waits for any already admitted I/O. */
  async #write<T>(operation: () => Promise<T> | T): Promise<T | undefined> {
    if (this.#destroyed || this.#disposed) return undefined;
    const write = Promise.resolve().then(() => {
      if (!this.#destroyed && !this.#disposed) return operation();
      return undefined;
    });
    this.#localWrites.add(write);
    try {
      return await write;
    } finally {
      this.#localWrites.delete(write);
    }
  }

  async destroyLocalState(): Promise<void> {
    this.beginDestroy();
    // Hydration may already be reading the plaintext ledger. Let reads finish
    // before purge, and settle writes admitted before the destruction fence.
    await Promise.allSettled([this.#terminalHydrated, this.#deliveredHydrated]);
    await Promise.allSettled([...this.#localWrites]);
    this.#pendingRetractions.clear();
    await this.history?.purgeMessages();
    const idHex = bytesToHex(this.id);
    await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
    await this.store.removeItem(idHex);
    if (this.rewindStore) await GroupHistoryTree.purge(this.rewindStore, idHex);
    if (this.ingestStateStore)
      for (const key of await this.ingestStateStore.keys())
        if (key.startsWith(`${idHex}/`))
          await this.ingestStateStore.removeItem(key);
    if (this.lifecycleStore && this.lifecycleStore !== this.ingestStateStore)
      for (const key of await this.lifecycleStore.keys())
        if (key.startsWith(`${idHex}/`))
          await this.lifecycleStore.removeItem(key);
  }

  /** Returns authoritative terminal evidence, failing closed on corrupt bytes. */
  async disbandTombstone(): Promise<DisbandTombstone | undefined> {
    await this.#terminalHydrated;
    return this.#terminalTombstone;
  }

  /** Synchronous terminal authority after lifecycle hydration has completed. */
  get terminalTombstone(): DisbandTombstone | undefined {
    return this.#terminalTombstone;
  }

  /** Durably records public notification delivery before application callbacks run. */
  async markDisbandNotificationDelivered(): Promise<
    DisbandTombstone | undefined
  > {
    if (this.#destroyed) return undefined;
    return this.#whileOpen(() => this.#markDisbandNotificationDelivered());
  }

  async #markDisbandNotificationDelivered(): Promise<
    DisbandTombstone | undefined
  > {
    await this.#terminalHydrated;
    this.assertOpen();
    const current = this.#terminalTombstone;
    if (!current || current.notificationState === "delivered") return undefined;
    if (!this.lifecycleStore)
      throw new Error("Disband notification requires a lifecycle store");
    const delivered: DisbandTombstone = {
      ...current,
      notificationState: "delivered",
    };
    await this.lifecycleStore.setItem(
      disbandTombstoneKey(bytesToHex(current.groupId)),
      encodeDisbandTombstone(delivered),
    );
    this.assertOpen();
    this.#terminalTombstone = delivered;
    return delivered;
  }

  /** Waits until both durable lifecycle namespaces have been decoded. */
  async hydrateLifecycleEvidence(): Promise<void> {
    await this.#write(async () => {
      await this.#terminalHydrated;
      await this.#deliveredHydrated;
      if (this.#destroyed) return;
      await this.#retryRetractions();
      if (this.#destroyed) return;
      await this.#engine.disbandRequest();
    });
  }

  /**
   * WR-02: the guarded, best-effort form of {@link persistSelectedDisband}
   * that every internal caller uses.
   *
   * `persistSelectedDisband` THROWS without a `lifecycleStore`, and that store
   * is optional in both `GroupSessionOptions` and `MarmotGroupOptions` — while
   * `#selectedDisbandEvidence` is set by the engine for any inbound disband
   * commit that wins selection, store or no store. Calling it unguarded at the
   * end of `ingest` therefore threw for every store-less session, after
   * results had been yielded and BEFORE `save()`, so the batch persisted
   * nothing and the next ingest repeated it.
   *
   * The engine getter is never cleared, so this is re-entered on every
   * subsequent ingest for the life of the group; the `#terminalTombstone`
   * check makes that an explicit early return rather than relying on the one
   * buried inside `persistSelectedDisband`.
   */
  async #persistSelectedDisbandIfPossible(
    evidence: DisbandCandidateEvidence | undefined,
  ): Promise<void> {
    if (!evidence) return;
    await this.#terminalHydrated;
    if (this.#destroyed || this.#terminalTombstone || !this.lifecycleStore)
      return;
    try {
      await this.persistSelectedDisband(evidence);
    } catch (error) {
      // Terminal evidence stays in engine state, so the next pass retries.
      this.#onHistoryError?.(error as Error);
    }
  }

  /**
   * Commits selected terminal evidence before repeatable cleanup. The first
   * durable write is authoritative even if any later store operation fails.
   */
  async persistSelectedDisband(
    evidence: DisbandCandidateEvidence,
  ): Promise<DisbandTombstone> {
    return this.#whileOpen(() => this.#persistSelectedDisband(evidence));
  }

  async #persistSelectedDisband(
    evidence: DisbandCandidateEvidence,
  ): Promise<DisbandTombstone> {
    await this.#terminalHydrated;
    this.assertOpen();
    if (this.#terminalTombstone) return this.#terminalTombstone;
    if (!this.lifecycleStore)
      throw new Error("Selected disband requires a lifecycle store");

    const idHex = bytesToHex(this.id);
    const tombstone: DisbandTombstone = {
      groupId: this.id.slice(),
      selectedEpoch: Number(this.state.groupContext.epoch),
      commitDigest: evidence.commitDigest.slice(),
      actorPubkey: evidence.actorPubkey,
      notificationState: "pending",
    };
    // The terminal write is the commit point. Everything below is idempotent
    // cleanup and is resumed by hydration after an interrupted attempt.
    await this.lifecycleStore.setItem(
      disbandTombstoneKey(idHex),
      encodeDisbandTombstone(tombstone),
    );
    this.assertOpen();
    await this.lifecycleStore.setItem(
      disbandRegistryStateKey(idHex),
      serializeClientState(scrubTerminalRegistryState(this.state)),
    );
    this.assertOpen();
    this.#terminalTombstone = tombstone;
    await this.#cleanupAfterDisband(idHex);
    return tombstone;
  }

  async #hydrateDisbandTombstone(): Promise<void> {
    if (!this.lifecycleStore) return;
    const idHex = bytesToHex(this.id);
    const bytes = await this.lifecycleStore.getItem(disbandTombstoneKey(idHex));
    if (!bytes || this.#destroyed || this.#disposed) return;
    const tombstone = decodeDisbandTombstone(bytes);
    if (bytesToHex(tombstone.groupId) !== idHex)
      throw new Error("Invalid disband tombstone group id");
    this.#terminalTombstone = tombstone;
    if (!(await this.lifecycleStore.getItem(disbandRegistryStateKey(idHex))))
      await this.#write(() =>
        this.lifecycleStore!.setItem(
          disbandRegistryStateKey(idHex),
          serializeClientState(scrubTerminalRegistryState(this.state)),
        ),
      );
    if (this.#destroyed || this.#disposed) return;
    await this.#cleanupAfterDisband(idHex);
  }

  async #cleanupAfterDisband(idHex: string): Promise<void> {
    this.#engine.dispose();
    await this.history?.purgeMessages();
    await this.lifecycleStore?.removeItem(disbandRequestKey(idHex));
    await this.lifecycleStore?.removeItem(disbandConvergenceKey(idHex));
    await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
    await this.store.removeItem(idHex);
    if (this.rewindStore) await GroupHistoryTree.purge(this.rewindStore, idHex);
    if (this.ingestStateStore) {
      for (const key of await this.ingestStateStore.keys())
        if (key.startsWith(`${idHex}/`))
          await this.ingestStateStore.removeItem(key);
    }
    this.#dirty = false;
  }

  /** Releases engine resources (the settle-check timer); call on teardown (B5). */
  dispose(): void {
    this.#disposed = true;
    this.#engine.dispose();
  }

  confirmPublished(pending: PendingState): StateNotification[] {
    this.assertOpen();
    const historySizeBefore = this.#engine.history.size;
    const notifications = this.#engine.confirmPublished(pending);
    if (this.#engine.history.size !== historySizeBefore)
      this.#onHistoryChanged?.();
    return notifications;
  }

  publishFailed(pending: PendingState): void {
    if (this.#destroyed || this.#disposed) return;
    this.#engine.publishFailed(pending);
  }

  proposalContext(): ProposalContext {
    const groupData = this.groupData;
    if (!groupData)
      throw new Error("MarmotGroupData not found in ClientState.");
    return { state: this.state, ciphersuite: this.ciphersuite, groupData };
  }

  async send(intent: GroupSessionSendIntent): Promise<GroupEffects> {
    const admitted = { ...intent };
    const effects = await this.#whileOpen(() => this.#send(admitted));
    // Abort may arrive between engine staging and returning its effects. Release
    // staged ownership here; late cancelled preparation must not pin the group.
    if (admitted.kind === "commit" && admitted.signal?.aborted) {
      for (const work of effects.publish)
        if ("pending" in work) this.publishFailed(work.pending);
      admitted.signal.throwIfAborted();
    }
    return effects;
  }

  async #send(intent: GroupSessionSendIntent): Promise<GroupEffects> {
    await this.#deliveredHydrated;
    this.assertOpen();
    switch (intent.kind) {
      case "applicationMessage": {
        const sendResult = await this.#engine.send({
          kind: "applicationMessage",
          payload: intent.payload,
        });
        this.assertOpen();
        if (sendResult.kind !== "applicationMessage") {
          throw new Error(
            "Expected applicationMessage result from applicationMessage send",
          );
        }
        this.#sentEventIds.add(sendResult.envelope.id);
        await this.#saveHistory(intent.payload);
        await this.save(true);
        this.assertOpen();
        return {
          publish: [
            { kind: "applicationMessage", envelope: sendResult.envelope },
          ],
        };
      }

      case "proposal": {
        const sendResult = await this.#engine.send({
          kind: "proposal",
          proposal: intent.proposal,
        });
        this.assertOpen();
        if (sendResult.kind !== "proposal") {
          throw new Error("Expected proposal result from proposal send");
        }
        return {
          publish: [
            {
              kind: "proposal",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
            },
          ],
        };
      }

      case "selfUpdate": {
        const sendResult = await this.#engine.send({ kind: "selfUpdate" });
        this.assertOpen();
        if (sendResult.kind !== "selfUpdate") {
          throw new Error("Expected selfUpdate result from selfUpdate send");
        }
        return {
          publish: [
            {
              kind: "selfUpdate",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
            },
          ],
        };
      }

      case "commit": {
        const expectedParent = intent.expectedParent;
        const assertPreparation = (proposals: readonly Proposal[]) => {
          this.assertOpen();
          intent.signal?.throwIfAborted();
          if (
            expectedParent !== undefined &&
            expectedParent !== this.parentToken
          )
            throw new Error(
              "Group canonical parent changed before preparation",
            );
          const changesImage = proposals.some(
            (proposal) =>
              proposal.proposalType === appDataUpdateProposalType &&
              "appDataUpdate" in proposal &&
              proposal.appDataUpdate.componentId ===
                GROUP_BLOSSOM_IMAGE_COMPONENT_ID,
          );
          if (expectedParent === undefined && changesImage)
            throw new Error(
              "Group image commits require expectedParent from session.parentToken",
            );
          if (changesImage) {
            if (
              this.state.groupActiveState.kind === "removedFromGroup" ||
              !getAdminPolicy(this.state.groupContext.extensions)?.includes(
                intent.actorPubkey,
              ) ||
              !getGroupMemberPubkeys(this.state).includes(intent.actorPubkey)
            )
              throw new Error(
                "Only an active group admin can change the Blossom image",
              );
            if (this.profileSupport.kind !== "supported")
              throw new Error(
                "Group image mutation requires a supported group profile",
              );
            if (this.#terminalTombstone || this.lifecycle !== "Stable")
              throw new Error(
                "Group image mutation requires a stable active lifecycle",
              );
          }
        };
        assertPreparation([]);
        const sendResult = await this.#engine.send(
          {
            kind: "commit",
            actorPubkey: intent.actorPubkey,
            extraProposals: intent.extraProposals,
            proposalRefs: intent.proposalRefs,
          },
          assertPreparation,
        );
        if (intent.signal?.aborted) {
          if (sendResult.kind === "groupEvolution")
            this.publishFailed(sendResult.pending);
          intent.signal.throwIfAborted();
        }
        this.assertOpen();
        if (sendResult.kind !== "groupEvolution") {
          throw new Error("Expected groupEvolution result from commit send");
        }
        return {
          publish: [
            {
              kind: "groupEvolution",
              envelope: sendResult.envelope,
              pending: sendResult.pending,
              actorPubkey: intent.actorPubkey,
              welcome: sendResult.welcome,
              welcomeRecipients: intent.welcomeRecipients,
              signal: intent.signal,
            },
          ],
        };
      }
    }
  }

  /** Persists irreversible terminal intent before returning publish work. */
  async requestDisband(): Promise<GroupEffects> {
    return this.#whileOpen(() => this.#requestDisband());
  }

  async #requestDisband(): Promise<GroupEffects> {
    const sendResult = await this.#engine.requestDisband();
    this.assertOpen();
    if (!sendResult) return { publish: [] };
    if (sendResult.kind !== "groupEvolution")
      throw new Error("Expected groupEvolution result from disband request");
    return {
      publish: [
        {
          kind: "groupEvolution",
          envelope: sendResult.envelope,
          pending: sendResult.pending,
          welcome: sendResult.welcome,
          actorPubkey: this.#ownPubkey(),
        },
      ],
    };
  }

  /** Returns the hydrated durable disband request, if one exists. */
  async disbandRequest(): Promise<DisbandRequest | undefined> {
    return this.#whileOpen(() => this.#engine.disbandRequest());
  }

  /** Builds the atomic active+required lifecycle enablement commit. */
  async enableGroupDisbanding(): Promise<GroupEffects> {
    return this.#whileOpen(() => this.#enableGroupDisbanding());
  }

  async #enableGroupDisbanding(): Promise<GroupEffects> {
    const sendResult = await this.#engine.enableGroupDisbanding();
    this.assertOpen();
    if (!sendResult) return { publish: [] };
    if (sendResult.kind !== "groupEvolution")
      throw new Error(
        "Expected groupEvolution result from lifecycle enablement",
      );
    return {
      publish: [
        {
          kind: "groupEvolution",
          envelope: sendResult.envelope,
          pending: sendResult.pending,
          welcome: sendResult.welcome,
          actorPubkey: this.#ownPubkey(),
        },
      ],
    };
  }

  #ownPubkey(): string {
    return getCredentialPubkey(
      getCredentialFromLeafIndex(
        this.state.ratchetTree,
        this.state.privatePath.leafIndex as LeafIndex,
      ),
    );
  }

  /**
   * Builds the self-remove proposal effects for leaving the group.
   *
   * Per RFC 9420 §12.4 a member cannot *commit* a Remove targeting their own
   * leaf, so this emits self-remove proposal(s) for the next committer (e.g.
   * an admin) to apply. Modelled as a send-intent — the darkmatter engine
   * exposes the same operation as `do_send_leave` rather than letting callers
   * hand-build the proposals.
   *
   * @param ownPubkey - The leaving member's Nostr public key (hex string).
   * @returns Publishable proposal effects (one per owned leaf node).
   */
  async leave(ownPubkey: string): Promise<GroupEffects> {
    return this.#whileOpen(() => this.#leave(ownPubkey));
  }

  async #leave(ownPubkey: string): Promise<GroupEffects> {
    const removeProposals = await proposeLeaveGroup(ownPubkey)(
      this.proposalContext(),
    );
    this.assertOpen();

    const publish: GroupPublishWork[] = [];
    for (const proposal of removeProposals) {
      const sendResult = await this.#engine.send({
        kind: "proposal",
        proposal,
      });
      this.assertOpen();
      if (sendResult.kind !== "proposal") {
        throw new Error("Expected proposal result from leave send");
      }
      publish.push({
        kind: "proposal",
        envelope: sendResult.envelope,
        pending: sendResult.pending,
      });
    }
    return { publish };
  }

  async *ingest(
    events: NostrEvent[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult> {
    await this.#terminalHydrated;
    await this.#deliveredHydrated;
    if (this.#destroyed) return;
    if (this.#terminalTombstone) {
      for (const event of events) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          reason: "group-disbanded",
        };
        yield { ...skipped, disposition: ingestResultDisposition(skipped) };
      }
      return;
    }
    // D-11 mirror: refuse every event for a group outside the current
    // account identity proof profile before any effect-ledger replay or
    // wrapper-ledger bookkeeping, so refused input writes nothing to either
    // ledger and persists no state. The engine gate (`ingestEnvelopes`)
    // remains authoritative for direct engine callers; this repeats the
    // terminal-tombstone precedent of gating at both session and engine.
    if (this.#engine.profileSupport.kind === "unsupported") {
      for (const event of events) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          reason: "unsupported-profile",
        };
        yield { ...skipped, disposition: ingestResultDisposition(skipped) };
      }
      return;
    }
    await this.#retryRetractions();
    for (const pending of (await this.#effectLedger?.pending()) ?? [])
      yield { ...pending, disposition: ingestResultDisposition(pending) };
    const selfEcho: NostrEvent[] = [];
    const rest: NostrEvent[] = [];
    const stateHash = bytesToHex(sha256(serializeClientState(this.state)));

    for (const event of events) {
      if (this.#destroyed) return;
      if (await this.#wrapperLedger?.get(event.id, stateHash)) continue;
      if (this.#sentEventIds.delete(event.id)) selfEcho.push(event);
      else {
        await this.#write(() =>
          this.#wrapperLedger?.begin(event.id, stateHash),
        );
        rest.push(event);
      }
    }

    for (const event of selfEcho) {
      if (this.#destroyed) return;
      const peeled = await this.#peeler.peelGroupMessages([event], this.state);
      const message = peeled.read[0]?.message;
      if (message) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          message,
          reason: "self-echo",
        };
        const disposition = ingestResultDisposition(skipped);
        await this.#write(() => this.#wrapperLedger?.record(event.id, "stale"));
        if (this.#destroyed) return;
        yield { ...skipped, disposition };
      }
    }

    for await (const result of this.#engine.ingest(rest, options)) {
      if (this.#destroyed) return;
      const mapped = mapEngineIngestResult(result);

      if (mapped.kind === "processed")
        await this.#persistSelectedDisbandIfPossible(mapped.selectedTerminal);

      if (
        mapped.kind === "processed" &&
        mapped.result.kind === "applicationMessage"
      ) {
        await this.#saveHistory(mapped.result.message);
      }
      if (this.#destroyed) return;

      const reconciledResults = await this.#reconcile(mapped);
      const retryableUnreadable =
        mapped.kind === "unreadable" && mapped.decryptFailure === true;
      const terminal =
        "event" in mapped &&
        mapped.disposition.kind !== "deferred" &&
        !retryableUnreadable;
      if (terminal) {
        const outcome =
          mapped.disposition.kind === "accepted"
            ? "accepted"
            : mapped.disposition.kind === "invalidated"
              ? "invalidated"
              : "stale";
        await this.#write(() =>
          this.#wrapperLedger?.stageApplied(
            mapped.event.id,
            stateHash,
            bytesToHex(sha256(serializeClientState(this.state))),
            outcome,
          ),
        );
        // Canonical state and fork material must be durable before terminal
        // wrapper evidence can suppress replay after a crash.
        await this.save(true);
        await this.#write(() =>
          this.#wrapperLedger?.record(mapped.event.id, outcome),
        );
      }
      if (this.#destroyed) return;
      if (
        mapped.kind === "processed" &&
        mapped.result.kind === "applicationMessage"
      )
        this.#onApplicationMessage?.(mapped.result.message);
      for (const reconciled of reconciledResults) yield reconciled;
    }

    // WR-01: a pool-replay rewind can select disband evidence with no
    // `processed` result to carry it (every triggering envelope was refused).
    // The engine still records the selection, so persist it from engine state
    // exactly as `driveConvergence` does. Idempotent once the tombstone exists.
    await this.#persistSelectedDisbandIfPossible(
      this.#engine.selectedDisbandEvidence,
    );
    await this.save();
  }

  async #reconcile(
    result: DispositionedIngestResult,
  ): Promise<DispositionedIngestResult[]> {
    if (this.#destroyed) return [];
    if (result.kind === "invalidated") {
      try {
        if (!result.payload || result.epoch === undefined || !result.tag)
          throw new Error("Invalidation lacks delivered payload evidence");
        const rumorId = deserializeApplicationData(
          result.payload,
        ).id.toLowerCase();
        if (result.rumorId !== undefined && result.rumorId !== rumorId)
          throw new Error("Invalidation rumor identity mismatch");
        const entry = {
          epoch: result.epoch,
          stateTag: result.tag,
          envelope: result.event,
          message: result.message,
          payload: result.payload,
          rumorId,
          transportId: result.event.id,
          commitDigest: result.commitDigest,
        };
        this.#pendingRetractions.set(result.event.id, entry);
        await this.#persistDelivered();
        await this.#retryRetractions();
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
    }
    if (!this.#effectLedger) return [result];
    if (result.kind === "stateInvalidated") {
      return (await this.#write(() =>
        this.#effectLedger!.prepareWithdrawal(
          result.commitDigest,
          result.forkEpoch,
          result.withdrawn,
        ),
      ))
        ? [result]
        : [];
    }

    const notifications =
      "notifications" in result ? result.notifications : undefined;
    if (!notifications?.length) return [result];
    const groups = new Map<string, StateNotification[]>();
    for (const notification of notifications) {
      const key = bytesToHex(notification.commitDigest);
      const group = groups.get(key) ?? [];
      group.push(notification);
      groups.set(key, group);
    }
    const output: DispositionedIngestResult[] = [result];
    for (const group of groups.values()) {
      const digest = group[0]!.commitDigest;
      if (
        await this.#write(() =>
          this.#effectLedger!.prepareAdoption(digest, group),
        )
      )
        output.push({
          kind: "stateRevalidated",
          commitDigest: digest,
          effectId: digest,
          notifications: group,
          disposition: { kind: "accepted" },
        });
    }
    return output;
  }

  /** Establishes the durable application-observation boundary for an effect. */
  async acknowledgeConvergenceEffect(
    result: Extract<
      DispositionedIngestResult,
      { kind: "stateInvalidated" | "stateRevalidated" }
    >,
  ): Promise<void> {
    await this.#write(() =>
      this.#effectLedger?.acknowledge(
        result.commitDigest,
        result.kind === "stateInvalidated" ? "withdrawal" : "adoption",
      ),
    );
  }

  #deliveredKey(): string {
    return `${bytesToHex(this.id)}/delivered-payloads/v1`;
  }

  async #hydrateDelivered(): Promise<void> {
    // Without persisted fork nodes there is no restart rewind authority to
    // validate historical branch provenance against. Keep session-only evidence.
    if (!this.rewindStore) return;
    const bytes = await this.ingestStateStore?.getItem(this.#deliveredKey());
    if (this.#destroyed || this.#disposed) return;
    if (!bytes) return; // Older clients have no attributable pre-migration deliveries.
    const evidence = decodeDeliveredEvidence(bytes, this.#engine.history);
    this.#engine.importDeliveredPayloads(evidence.entries);
    for (const entry of evidence.pending)
      this.#pendingRetractions.set(entry.transportId!, entry);
  }

  async #retryRetractions(): Promise<void> {
    if (this.#destroyed) return;
    for (const [id, entry] of this.#pendingRetractions) {
      try {
        // Transport deliveries can share one inner rumor. A losing envelope
        // withdraws only its own support; retain (or restore) the history row
        // while any surviving delivery still supports that canonical identity.
        const surviving = this.#engine
          .exportDeliveredPayloads()
          .find((delivery) => delivery.rumorId === entry.rumorId);
        if (surviving)
          await this.#write(() => this.history?.saveMessage(surviving.payload));
        else
          await this.#write(() => this.history?.removeMessage(entry.rumorId!));
        if (this.#destroyed) return;
        this.#pendingRetractions.delete(id);
        try {
          await this.#persistDelivered();
        } catch (error) {
          if (!this.#destroyed) this.#pendingRetractions.set(id, entry);
          throw error;
        }
        this.#onHistoryChanged?.();
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
    }
  }

  async #persistDelivered(): Promise<void> {
    if (this.#destroyed) return;
    // Rewinds remove the entire batch before yielding individual results. Move
    // every obligation to the durable outbox before any canonical state save
    // or history removal can discard the abandoned delivery evidence.
    const invalidated = this.#engine.exportInvalidatedPayloads();
    for (const entry of invalidated)
      if (entry.rumorId && entry.transportId)
        this.#pendingRetractions.set(entry.transportId, entry);
    await this.#write(() =>
      this.ingestStateStore?.setItem(
        this.#deliveredKey(),
        encodeDeliveredEvidence({
          entries: this.#engine
            .exportDeliveredPayloads()
            .filter((entry) => !!entry.rumorId),
          pending: [...this.#pendingRetractions.values()],
        }),
      ),
    );
    this.#engine.acknowledgeInvalidatedPayloads(invalidated);
  }

  async #saveHistory(message: Uint8Array): Promise<void> {
    if (!this.history || this.#destroyed) return;
    try {
      await this.#write(() => this.history!.saveMessage(message));
    } catch (err) {
      this.#onHistoryError?.(err as Error);
    }
  }
}

function scrubTerminalRegistryState(state: ClientState): ClientState {
  const copy = structuredClone(state);
  scrubSecrets(copy.keySchedule);
  scrubSecrets(copy.secretTree);
  scrubSecrets(copy.privatePath);
  copy.signaturePrivateKey.fill(0);
  copy.historicalReceiverData.clear();
  copy.unappliedProposals = {};
  return copy;
}

function scrubSecrets(value: unknown): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) scrubSecrets(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const entry of Object.values(value as Record<string, unknown>))
    scrubSecrets(entry);
}

export type ProposalBuilder<
  Args extends unknown[],
  T extends Proposal | Proposal[],
> = (...args: Args) => import("../../engine/types.js").ProposalAction<T>;
