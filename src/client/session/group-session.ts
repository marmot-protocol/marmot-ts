/** @module @category Client - Session */
import {
  mediaSourceStateToken,
  StaleMediaPreparationError,
} from "../../core/media/source-state.js";

import { deserializeApplicationData } from "../../core/application-rumor.js";
import {
  deliveryId,
  fromDeliveryRow,
  toDeliveryRow,
} from "../storage/delivered-payload-store.js";
import { messageRow } from "../storage/database/message-database.js";
import type { DeliveredAppPayload } from "../../engine/delivered-payloads.js";
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
import { getAdminPolicy } from "../../core/components/dictionary.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";

import type { GroupProfileSupport } from "../../core/components/account-identity-proof.js";
import { GROUP_BLOSSOM_IMAGE_COMPONENT_ID } from "../../core/components/ids.js";
import {
  getMarmotGroupView,
  deserializeClientState,
  serializeClientState,
  type MarmotGroupView,
} from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { Disposition } from "../../core/inbound.js";
import { getCredentialPubkey } from "../../core/credential.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import { framedEpoch } from "../../engine/wire-format.js";
import { contentDedupId } from "../../engine/message-dedup.js";
import {
  registerSettledRetentionOwner,
  unregisterSettledRetentionOwner,
} from "../../engine/settled-retention-owner.js";
import {
  registerPublicationPreparationOwner,
  unregisterPublicationPreparationOwner,
} from "../../engine/publication-preparation.js";
import {
  registerPublicationRetention,
  unregisterPublicationRetention,
} from "../runtime/publication-retention.js";
import {
  projectHistoricalReceivers,
  type HistoryRetentionPin,
} from "../../engine/retention.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import type {
  RemovalAttribution,
  RemovalRecovery,
} from "../../engine/fork-recovery.js";
import type { DisbandRequest } from "../../engine/disband-request.js";
import type { DisbandRecordStore } from "../../engine/disband-request.js";
import {
  fromStoredDisbandTombstone,
  toStoredDisbandTombstone,
  type DisbandTerminalIntent,
  type DisbandTombstone,
} from "../../engine/disband-tombstone.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import type {
  DispositionedIngestResult as EngineDispositionedIngestResult,
  IngestResult as EngineIngestResult,
  PendingState,
  SendResult,
  ProposalContext,
  DisbandCandidateEvidence,
} from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import {
  applyTreeWrite,
  GroupBatch,
  groupRecordStore,
  groupTreeStore,
  type GroupRecordStore,
} from "../storage/database/group-batch.js";
import type {
  GroupRecordUpdate,
  MarmotGroupDatabase,
  RemovalRecord,
} from "../storage/database/types.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import {
  ConvergenceEffectLedger,
  TerminalWrapperLedger,
  type TerminalWrapperOutcome,
} from "../storage/wrapper-ledger.js";
import { proposeLeaveGroup } from "../group/proposals/leave-group.js";
import type {
  GroupEffects,
  GroupPublishWork,
  GroupSessionSendIntent,
} from "./group-effects.js";

type AssociatePublication = (
  result: SendResult<NostrEvent> | undefined,
) => void;

/**
 * Public session results are the engine result union with the transport field
 * renamed at the Nostr boundary. Keeping this transformation distributive
 * makes new engine fields and variants flow through without a parallel union
 * that can silently drift (WR-12).
 */
export type SessionIngestResult<
  TResult extends EngineIngestResult<NostrEvent>,
> = TResult extends { envelope: NostrEvent }
  ? Omit<TResult, "envelope"> & { event: NostrEvent }
  : TResult;

/** Selects an engine result variant before adapting its Nostr transport field. */
export type EngineIngestResultOfKind<
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

/** Versioned non-secret lifecycle authority, stored apart from the MLS snapshot. */
export interface RemovalEvidence extends RemovalAttribution {
  notificationState: "pending" | "delivered";
  recoveryPending?: RemovalRecovery;
}

type StagedWrapper = { outcome: TerminalWrapperOutcome; epoch: number };

export type DispositionedIngestResult = IngestResult & {
  disposition: Disposition;
};

/** The history writes a {@link GroupSession} performs (implemented by `GroupHistory`). */
export interface GroupSessionHistory {
  saveMessage(message: Uint8Array): Promise<void>;
  purgeMessages(): Promise<void>;
  /** Idempotent durable retraction by canonical inner rumor ID. */
  removeMessage(rumorId: string): Promise<void>;
}

export type GroupSessionOptions = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  /**
   * This group's database: canonical state, history tree, ingest ledgers,
   * lifecycle records and messages.
   */
  database: MarmotGroupDatabase;
  /**
   * Permanently deletes this group's database on {@link GroupSession.destroyLocalState}.
   * When omitted the session clears the records it knows about instead.
   */
  dropDatabase?: () => Promise<void>;
  /**
   * The bounded convergence window, derived from the history tree on load (never
   * persisted separately). Set by the internal loader (`GroupRegistry`); fresh
   * groups seed it from the current tip.
   */
  retained?: RetainedHistoryStore;
  /**
   * A full-fork history tree rehydrated from storage on load. When omitted, a
   * fresh tree is bound to storage and flushed on {@link GroupSession.save}.
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
  /** Rumor history the session writes decoded application messages into. */
  history?: GroupSessionHistory;
  onStateChanged?: (state: ClientState) => void;
  /** Lifecycle, convergence or membership authority changed. */
  onChanged?: () => void;
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

export class GroupSession {
  readonly ciphersuite: CiphersuiteImpl;
  /** This group's database. */
  readonly database: MarmotGroupDatabase;
  /**
   * Access to the database's singleton group record.
   * @internal
   */
  readonly records: GroupRecordStore;
  readonly history?: GroupSessionHistory;
  readonly #dropDatabase?: () => Promise<void>;

  readonly #engine: MarmotGroupEngine<NostrEvent>;
  readonly #peeler: NostrGroupPeeler;
  readonly #sentEventIds = new Map<
    string,
    {
      sourceEpoch: number;
      contentId: string;
      stateTag: string;
      pendingState?: PendingState;
    }
  >();
  readonly #pendingPublications = new Map<
    string,
    {
      sourceEpoch: number;
      contentId: string;
      stateTag: string;
      pendingState?: PendingState;
    }
  >();
  readonly #wrapperLedger: TerminalWrapperLedger;
  readonly #effectLedger: ConvergenceEffectLedger;
  /** Terminal wrapper records waiting for the next state commit. */
  readonly #stagedWrappers = new Map<string, StagedWrapper>();

  #groupData: MarmotGroupView | null = null;
  #dirty = false;
  #stateVersion = 0;
  #retentionVersion = 0;
  #destroyed = false;
  #disposed = false;
  readonly #localWrites = new Set<Promise<unknown>>();
  #saveInFlight: Promise<void> | undefined;
  #retentionInFlight: Promise<boolean> | undefined;
  #retentionPending = false;
  #terminalTombstone: DisbandTombstone | undefined;
  #terminalIntent: DisbandTerminalIntent | undefined;
  #terminalProjectionComplete = false;
  #terminalProjectionInFlight: Promise<void> | undefined;
  #removalEvidence: RemovalEvidence | undefined;
  #removalFenced = false;
  #removalRecoveryInFlight: Promise<void> | undefined;
  readonly #removalHydrated: Promise<void>;
  readonly #terminalHydrated: Promise<void>;
  #disbandNotificationInFlight:
    Promise<DisbandTombstone | undefined> | undefined;
  readonly #deliveredHydrated: Promise<void>;
  /** Persisted `deliveries` rows this session knows about, by row id. */
  readonly #deliveries = new Map<string, PersistedDelivery>();
  /** Invalidations reported by ingest, applied by the next save. */
  readonly #pendingInvalidations = new Map<
    string,
    DeliveredAppPayload<NostrEvent>
  >();
  /** Locally sent application payloads, written by the next save. */
  readonly #pendingMessages: Uint8Array[] = [];

  readonly #onStateChanged?: (state: ClientState) => void;
  readonly #onChanged?: () => void;
  readonly #onStateSaved?: () => void;
  readonly #onApplicationMessage?: (message: Uint8Array) => void;
  readonly #onHistoryError?: (error: Error) => void;
  readonly #onHistoryChanged?: () => void;

  constructor(options: GroupSessionOptions) {
    this.ciphersuite = options.ciphersuite;
    this.database = options.database;
    this.records = groupRecordStore(options.database);
    this.#dropDatabase = options.dropDatabase;
    this.history = options.history;
    this.#onStateChanged = options.onStateChanged;
    this.#onChanged = options.onChanged;
    this.#onStateSaved = options.onStateSaved;
    this.#onApplicationMessage = options.onApplicationMessage;
    this.#onHistoryError = options.onHistoryError;
    this.#onHistoryChanged = options.onHistoryChanged;

    this.#peeler = new NostrGroupPeeler(this.ciphersuite);
    this.#peeler.wrapGroupMessage = async (message, state, metadata) => {
      const sourceEpoch = framedEpoch(message);
      if (
        sourceEpoch === undefined ||
        sourceEpoch < 0n ||
        !Number.isSafeInteger(Number(sourceEpoch))
      )
        throw new Error("Unsafe local publication source epoch");
      // Capture authenticated inner identity and source before wrapping awaits.
      const record = {
        sourceEpoch: Number(sourceEpoch),
        contentId: contentDedupId(message),
        stateTag: bytesToHex(state.confirmationTag),
      };
      const envelope = await NostrGroupPeeler.prototype.wrapGroupMessage.call(
        this.#peeler,
        message,
        state,
        metadata,
      );
      if (
        !this.#destroyed &&
        !this.#disposed &&
        !this.#terminalTombstone &&
        !this.removalBlocked
      ) {
        this.#sentEventIds.set(envelope.id, record);
        this.#pendingPublications.set(envelope.id, record);
      }
      return envelope;
    };
    this.#wrapperLedger = new TerminalWrapperLedger(this.database);
    this.#effectLedger = new ConvergenceEffectLedger(this.database);
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
      storage: this.#disbandRecordStore(),
      onChanged: () => {
        if (!this.#destroyed && !this.#disposed) this.#onChanged?.();
      },
      onStateChanged: (newState) => {
        if (this.#destroyed || this.#disposed) return;
        this.#dirty = true;
        this.#stateVersion++;
        this.#groupData = null;
        this.#onStateChanged?.(newState);
      },
      onSelectedDisband: (evidence, state) =>
        this.#fenceDisband(evidence, state),
    });

    this.#registerRetentionOwners();

    // Persist the full-fork history tree to the rewind store. A rehydrated tree
    // (loaded form) is already bound; a fresh one is bound here so its nodes
    // flush on the next save.
    if (!options.historyTree)
      this.#engine.history.bindStore(groupTreeStore(this.database));
    this.#terminalHydrated = this.#hydrateDisbandTombstone();
    this.#deliveredHydrated = this.#hydrateDelivered();
    this.#removalHydrated = this.#hydrateRemovalEvidence();
  }

  get removalEvidence(): RemovalEvidence | undefined {
    const evidence = this.#removalEvidence;
    return (
      evidence && {
        ...evidence,
        recoveryPending: evidence.recoveryPending && {
          ...evidence.recoveryPending,
        },
      }
    );
  }

  /** Side-effect-free hydration used before a loaded facade becomes observable. */
  async hydrateRemovalEvidence(): Promise<void> {
    await this.#removalHydrated;
  }

  /** Public membership remains removed until every recovery write completes. */
  get removalBlocked(): boolean {
    return (
      this.#removalFenced ||
      this.state.groupActiveState.kind === "removedFromGroup"
    );
  }

  async #assertOutboundMembership(): Promise<void> {
    await this.#removalHydrated;
    if (this.removalBlocked)
      throw new Error("Group removed or removal recovery pending");
  }

  /**
   * The engine's disband records, kept in the group record. Engine lifecycle
   * writes also occur outside awaited session calls (for example when a
   * confirmed epoch refreshes a pending request), so every write goes through
   * the same destruction barrier.
   */
  #disbandRecordStore(): DisbandRecordStore {
    return {
      load: async () => {
        const record = await this.database.group();
        return {
          request: record.disbandRequest,
          convergence: record.disbandConvergence,
        };
      },
      saveRequest: async (request) => {
        await this.#write(() =>
          this.records.update({
            disbandRequest: request && { ...request },
          }),
        );
      },
      saveConvergence: async (convergence) => {
        await this.#write(() =>
          this.records.update({
            disbandConvergence: convergence && {
              ...convergence,
              candidates: convergence.candidates.map((candidate) => ({
                ...candidate,
              })),
            },
          }),
        );
      },
    };
  }

  async #hydrateRemovalEvidence(): Promise<void> {
    const stored = await this.database.group();
    const removal = stored.removal;
    const marker =
      this.state.groupActiveState.kind === "removedFromGroup"
        ? undefined
        : stored.removed;
    this.#removalFenced = !!removal || marker === true;
    this.#onChanged?.();
    if (!removal) return;
    try {
      const record = removal as RemovalEvidence;
      if (
        typeof record !== "object" ||
        ![1, 2].includes(record.version) ||
        (record.version === 2 &&
          (typeof record.removingCommitter !== "string" ||
            !/^([0-9a-f]{64})?$/.test(record.removingCommitter))) ||
        (record.removingPriority !== undefined &&
          record.removingPriority !== "privileged" &&
          record.removingPriority !== "ordinary") ||
        record.groupId !== bytesToHex(this.id) ||
        !/^[0-9a-f]{64}$/.test(record.removalDigest) ||
        !/^[0-9a-f]+$/.test(record.parentTag) ||
        !/^[0-9a-f]{64}$/.test(record.localIdentity) ||
        !Number.isSafeInteger(record.parentEpoch) ||
        record.parentEpoch < 0 ||
        !Number.isSafeInteger(record.localLeaf) ||
        record.localLeaf < 0 ||
        !["pending", "delivered"].includes(record.notificationState)
      )
        return;
      if (
        record.recoveryPending !== undefined &&
        (!record.recoveryPending ||
          typeof record.recoveryPending !== "object" ||
          record.recoveryPending.removalDigest !== record.removalDigest ||
          record.recoveryPending.parentTag !== record.parentTag ||
          typeof record.recoveryPending.selectedTip !== "string" ||
          !/^[0-9a-f]+$/.test(record.recoveryPending.selectedTip))
      )
        return;
      this.#removalEvidence = {
        ...record,
        recoveryPending: record.recoveryPending && {
          ...record.recoveryPending,
        },
      };
      this.#clearPublications();
    } catch {
      /* Legacy or malformed authority cannot restore membership. */
    }
  }

  async #persistRemovalEvidence(evidence: RemovalEvidence): Promise<void> {
    if (!this.#removalFenced) this.#clearPublications();
    this.#removalFenced = true;
    this.#onChanged?.();
    const removal: RemovalRecord = {
      ...evidence,
      recoveryPending: evidence.recoveryPending && {
        ...evidence.recoveryPending,
      },
    };
    if (!removal.recoveryPending) delete removal.recoveryPending;
    await this.#write(() => this.records.update({ removal }));
    this.#removalEvidence = evidence;
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

  /** Synchronous publication/preparation fence after admitted lifecycle hydration. */
  assertOutboundOpen(): void {
    this.assertOpen();
    if (this.#terminalTombstone) throw new Error("Group disbanded");
    if (this.removalBlocked)
      throw new Error("Group removed or removal recovery pending");
  }

  /** Serializable identity of the canonical parent, including same-epoch forks. */
  get parentToken(): string {
    return mediaSourceStateToken(this.state);
  }

  /** Resolve persisted authenticated delivery evidence, never an imeta epoch. */
  async mediaSourceForRumor(rumorId: string): Promise<string | undefined> {
    await this.#deliveredHydrated;
    if (
      this.#destroyed ||
      this.#disposed ||
      this.removalBlocked ||
      this.#terminalTombstone
    )
      return undefined;
    const states = [this.state, ...this.retainedStates()];
    for (const entry of this.#engine.exportDeliveredPayloads()) {
      if (entry.rumorId !== rumorId) continue;
      const epoch = framedEpoch(entry.message);
      const state = states.find(
        (candidate) =>
          candidate.groupContext.epoch === epoch &&
          epoch === BigInt(entry.epoch) &&
          bytesToHex(candidate.confirmationTag) === entry.stateTag,
      );
      if (state) return mediaSourceStateToken(state);
    }
    return undefined;
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
    while (this.#saveInFlight) {
      await this.#saveInFlight;
      if (
        !force &&
        !this.#dirty &&
        !this.#retentionPending &&
        !this.historyTree.isDirty
      )
        return;
    }
    const saving = this.#save(force);
    this.#saveInFlight = saving;
    try {
      await saving;
    } finally {
      if (this.#saveInFlight === saving) this.#saveInFlight = undefined;
    }
  }

  async #save(force: boolean): Promise<void> {
    await this.#terminalHydrated;
    await this.#deliveredHydrated;
    await this.#removalHydrated;
    if (this.#destroyed || this.#disposed || this.#terminalTombstone) return;
    const treeDirty = this.#engine.history.isDirty;
    this.#retentionPending ||=
      force || this.#dirty || treeDirty || this.#stagedWrappers.size > 0;
    if (!this.#retentionPending) {
      await this.#persistDelivered();
      return;
    }
    await this.#write(() => this.#engine.persistDisbandConvergence());
    const retentionVersion = this.#retentionVersion;
    const stateVersion = this.#stateVersion;
    if (await this.#pruneSettledRetention()) {
      this.#retentionPending = retentionVersion !== this.#retentionVersion;
      if (stateVersion === this.#stateVersion) this.#dirty = false;
      this.#onStateSaved?.();
      return;
    }
    // The history tree can grow without the canonical state changing — a fork
    // whose incoming branch is superseded still records the losing branch — so
    // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
    if (
      !force &&
      !this.#dirty &&
      !treeDirty &&
      this.#stagedWrappers.size === 0
    ) {
      await this.#persistDelivered();
      return;
    }

    // One atomic commit: fork-history nodes, deliveries and messages,
    // canonical state and the terminal wrapper records of the events that
    // produced it. After a crash either all of it is durable or none of it is.
    const writtenVersion = this.#stateVersion;
    const committed = await this.#write(async () => {
      const batch = new GroupBatch(this.database);
      const tree = await this.#engine.history.stageFlush();
      batch.tree(tree.write);
      const deliveries = this.#stageDeliveries(batch);
      batch.updateGroup({ state: serializeClientState(this.state) });
      const wrappers = this.#stageWrappers(batch);
      await batch.commit();
      tree.finish();
      await deliveries.finish();
      this.#unstageWrappers(wrappers);
      return true;
    });
    if (!committed || this.#destroyed || this.#disposed) return;
    if (writtenVersion === this.#stateVersion) this.#dirty = false;
    this.#onStateSaved?.();
  }

  /**
   * Stages delivery and message rows: new deliveries (with re-adoption
   * evidence unless `keep` excludes their state), locally sent messages, and
   * invalidated deliveries. A rumor's message row is removed in the same
   * transaction once no delivery supports it. Call `finish` after the commit.
   */
  #stageDeliveries(
    batch: GroupBatch,
    keep?: ReadonlySet<string>,
  ): {
    invalidated: DeliveredAppPayload<NostrEvent>[];
    finish: (options?: {
      acknowledge?: boolean;
      notify?: boolean;
    }) => Promise<void>;
    notify: () => Promise<void>;
  } {
    const engineInvalidated = this.#engine.exportInvalidatedPayloads();
    const reported = [...this.#pendingInvalidations];
    const locals = [...this.#pendingMessages];
    const current = this.#engine.exportDeliveredPayloads();
    const now = Math.floor(Date.now() / 1000);
    const changed = new Map<string, PersistedDelivery>();
    const deleted = new Set<string>();
    const saved: Uint8Array[] = [];
    const removed: string[] = [];

    const stageMessage = (payload: Uint8Array) => {
      let row: ReturnType<typeof messageRow>;
      try {
        row = messageRow(deserializeApplicationData(payload));
      } catch {
        return; // Invalid payloads have no rumor.
      }
      batch.then(async (tx) => {
        if (await tx.messages.get(row.id)) return;
        await tx.messages.put(row);
        saved.push(payload);
      });
    };

    for (const payload of locals) stageMessage(payload);
    const live = new Set<string>();
    for (const entry of current) {
      const id = deliveryId(entry);
      if (!id) continue;
      live.add(id);
      const evidence = !keep || keep.has(entry.stateTag);
      const known = this.#deliveries.get(id);
      if (known && known.evidence === evidence) continue;
      const record: PersistedDelivery = {
        rumorId: entry.rumorId!,
        stateTag: entry.stateTag,
        transportId: entry.transportId!,
        epoch: entry.epoch,
        createdAt: known?.createdAt ?? now,
        evidence,
      };
      batch.putDelivery(
        toDeliveryRow(entry, { createdAt: record.createdAt, evidence }),
      );
      changed.set(id, record);
      if (!known) stageMessage(entry.payload);
    }
    // Retention: evidence leaves the window even when the engine no longer
    // holds the entry; the row itself stays to count the rumor's support.
    if (keep)
      for (const [id, known] of this.#deliveries)
        if (known.evidence && !keep.has(known.stateTag) && !changed.has(id)) {
          const record = { ...known, evidence: false };
          batch.putDelivery({
            id,
            rumorId: record.rumorId,
            stateTag: record.stateTag,
            epoch: record.epoch,
            transportId: record.transportId,
            createdAt: record.createdAt,
          });
          changed.set(id, record);
        }
    for (const entry of [
      ...engineInvalidated,
      ...reported.map(([, entry]) => entry),
    ]) {
      const id = deliveryId(entry);
      if (!id) continue;
      const rumorId = entry.rumorId!;
      batch.deleteDelivery(id);
      deleted.add(id);
      batch.then(async (tx) => {
        if ((await tx.deliveries.countByRumor(rumorId)) > 0) return;
        if (!(await tx.messages.get(rumorId))) return;
        await tx.messages.delete(rumorId);
        removed.push(rumorId);
      });
    }

    const notify = async () => {
      if (!this.history || (!saved.length && !removed.length)) return;
      // The rows are durable; announce them to live history readers.
      try {
        for (const payload of saved) await this.history.saveMessage(payload);
        for (const rumorId of removed)
          await this.history.removeMessage(rumorId);
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
      this.#onHistoryChanged?.();
    };

    return {
      invalidated: engineInvalidated,
      notify,
      // Retention defers acknowledgement and notification until the engine
      // lease is released.
      finish: async ({ acknowledge = true, notify: announce = true } = {}) => {
        for (const [id, record] of changed) this.#deliveries.set(id, record);
        for (const id of deleted) this.#deliveries.delete(id);
        // Settled rows the engine has pruned need no further bookkeeping.
        for (const [id, record] of this.#deliveries)
          if (!record.evidence && !live.has(id)) this.#deliveries.delete(id);
        for (const [id, entry] of reported)
          if (this.#pendingInvalidations.get(id) === entry)
            this.#pendingInvalidations.delete(id);
        this.#pendingMessages.splice(0, locals.length);
        if (acknowledge)
          this.#engine.acknowledgeInvalidatedPayloads(engineInvalidated);
        if (announce) await notify();
      },
    };
  }

  #stageWrappers(batch: GroupBatch): Map<string, StagedWrapper> {
    const staged = new Map(this.#stagedWrappers);
    for (const [eventId, record] of staged)
      this.#wrapperLedger.stage(batch, eventId, record.outcome, record.epoch);
    return staged;
  }

  #unstageWrappers(staged: Map<string, StagedWrapper>): void {
    for (const [eventId, record] of staged)
      if (this.#stagedWrappers.get(eventId) === record)
        this.#stagedWrappers.delete(eventId);
  }

  async #pruneSettledRetention(): Promise<boolean> {
    if (this.#retentionInFlight) return this.#retentionInFlight;
    const pruning = this.#retainSettled();
    this.#retentionInFlight = pruning;
    try {
      return await pruning;
    } finally {
      if (this.#retentionInFlight === pruning)
        this.#retentionInFlight = undefined;
    }
  }

  async #retainSettled(): Promise<boolean> {
    if (this.#destroyed || this.#disposed) return false;
    const pins: HistoryRetentionPin[] = [];
    // Removal authority owns the exact pristine parent and every selected
    // replay snapshot until durable validation, marker clearing and attribution
    // deletion finish. A malformed/unresolved authority still postpones cleanup.
    const removal = this.#removalEvidence;
    let unresolvedRemoval = this.#removalFenced && !removal;
    if (removal) {
      const path = removal.recoveryPending
        ? this.historyTree.path(removal.recoveryPending.selectedTip)
        : [removal.parentTag];
      const parentIndex = path?.indexOf(removal.parentTag) ?? -1;
      if (
        parentIndex < 0 ||
        this.historyTree.epochOf(removal.parentTag) !== removal.parentEpoch ||
        (removal.recoveryPending &&
          (removal.recoveryPending.parentTag !== removal.parentTag ||
            removal.recoveryPending.removalDigest !== removal.removalDigest))
      )
        unresolvedRemoval = true;
      else
        for (const stateTag of path!.slice(parentIndex))
          pins.push({ stateTag, reason: "recovery" });
    }
    const publications = [...this.#pendingPublications.values()];
    for (const publication of publications)
      pins.push({ stateTag: publication.stateTag, reason: "publication" });
    let retentionInvalidated: DeliveredAppPayload<NostrEvent>[] = [];
    let retentionNotify: (() => Promise<void>) | undefined;
    const effects = await this.#effectLedger.pending();
    let unresolvedEffect = await this.#effectLedger.hasOpaqueDependency();
    for (const effect of effects) {
      const notifications =
        effect.kind === "stateInvalidated"
          ? effect.withdrawn
          : effect.notifications;
      for (const digest of [
        effect.commitDigest,
        ...notifications.map((notification) => notification.commitDigest),
      ]) {
        const matching = this.historyTree
          .tags()
          .filter(
            (tag) =>
              bytesToHex(
                this.historyTree.node(tag)?.edge?.commitDigest ??
                  new Uint8Array(),
              ) === bytesToHex(digest),
          );
        if (!matching.length) unresolvedEffect = true;
        for (const stateTag of matching)
          pins.push({ stateTag, reason: "recovery" });
      }
    }
    const result = await this.#engine.retainSettled(
      async (capture, publish) => {
        // Capture the live ratchet projection once while the engine lease owns revision.
        const stateBytes = projectHistoricalReceivers(
          serializeClientState(this.state),
          capture.appPayloadPastEpochLimit === Infinity
            ? 0
            : Math.max(
                0,
                Number(this.state.groupContext.epoch) -
                  capture.appPayloadPastEpochLimit,
              ),
          capture.pins!.filter(
            (pin) => pin.stateTag === capture.canonicalTipTag,
          ),
        ).snapshot;
        const plan = await this.historyTree.prepareRetention(capture);
        const keep = new Set(plan.retainedTags);
        const digests = new Set(
          plan.retainedTags.flatMap((tag) => {
            const digest = this.historyTree.node(tag)?.edge?.commitDigest;
            return digest ? [bytesToHex(digest)] : [];
          }),
        );
        // Tree nodes, the projected state, evidence, staged wrappers and
        // ledger compaction commit together.
        await this.#write(async () => {
          const batch = new GroupBatch(this.database);
          const tree = await this.historyTree.stageFlush();
          batch.tree(tree.write);
          batch.updateGroup({ state: stateBytes });
          const deliveries = this.#stageDeliveries(batch, keep);
          const wrappers = this.#stageWrappers(batch);
          this.#wrapperLedger.stageCompaction(
            batch,
            plan.floorEpoch,
            new Set([...this.#pendingPublications.keys(), ...wrappers.keys()]),
          );
          this.#effectLedger.stageCompaction(batch, digests);
          await batch.commit();
          tree.finish();
          await deliveries.finish({ acknowledge: false, notify: false });
          retentionInvalidated = deliveries.invalidated;
          retentionNotify = deliveries.notify;
          this.#unstageWrappers(wrappers);
        });
        if (this.#destroyed || this.#disposed)
          throw new Error("Group closed during retention");
        await publish(plan);
        return plan;
      },
      {
        pins,
        contentIds: publications.map((publication) => publication.contentId),
        unresolvedDependency:
          unresolvedRemoval || !!this.#terminalIntent || unresolvedEffect,
      },
    );
    if (result.kind === "committed") {
      this.#engine.acknowledgeInvalidatedPayloads(retentionInvalidated);
      await retentionNotify?.();
      for (const [id, record] of this.#sentEventIds)
        if (
          record.sourceEpoch < result.floorEpoch &&
          !this.#pendingPublications.has(id)
        )
          this.#sentEventIds.delete(id);
    }
    return result.kind === "committed";
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
    await this.#terminalHydrated;
    await this.#removalHydrated;
    await this.#deliveredHydrated;
    if (this.#destroyed) return [];
    if (this.#terminalTombstone) return this.#resumeTerminalWork();
    if (this.removalBlocked || this.#removalEvidence) {
      await this.finishRemovalRecovery();
      return [];
    }
    const results: DispositionedIngestResult[] = [];
    for (const result of await this.#engine.reconvergeFromHistory())
      results.push(...(await this.#reconcile(mapEngineIngestResult(result))));
    await this.save();
    return results;
  }

  /** Recoverable ordering over existing adapters; each interrupted prefix is restartable. */
  async #finishRemovalRecovery(): Promise<void> {
    let evidence = this.#removalEvidence;
    if (!evidence) return;
    this.#removalFenced = true;
    this.#onChanged?.();
    if (this.state.groupActiveState.kind === "removedFromGroup") {
      const removedState = this.state;
      const recovered = await this.#engine.recoverRemovedFromAnchor(
        evidence,
        evidence.recoveryPending?.selectedTip,
      );
      if (!recovered) return;
      try {
        evidence = { ...evidence, recoveryPending: recovered };
        // Authority precedes the fallible active projection write.
        await this.#persistRemovalEvidence(evidence);
        await this.save(true);
      } catch (error) {
        this.state = removedState;
        throw error;
      }
    }
    const authority = evidence.recoveryPending;
    if (
      !authority ||
      !(await this.#engine.validateRemovalRecovery(evidence, authority))
    )
      return;
    const bytes = (await this.database.group()).state;
    if (!bytes) return;
    let durable: ClientState;
    try {
      durable = deserializeClientState(bytes);
    } catch {
      return;
    }
    if (
      !(await this.#engine.validateRemovalRecovery(
        evidence,
        authority,
        durable,
      ))
    )
      return;
    // Keep notification identity and selection authority until the marker write settles.
    await this.#write(() =>
      this.records.update({ removed: null, removal: null }),
    );
    this.#removalEvidence = undefined;
    this.#removalFenced = false;
    this.#onChanged?.();
    this.#registerRetentionOwners();
  }

  async finishRemovalRecovery(): Promise<void> {
    await this.#removalHydrated;
    if (this.#removalRecoveryInFlight) return this.#removalRecoveryInFlight;
    const recovery = this.#whileOpen(() => this.#finishRemovalRecovery());
    this.#removalRecoveryInFlight = recovery;
    try {
      await recovery;
    } finally {
      if (this.#removalRecoveryInFlight === recovery)
        this.#removalRecoveryInFlight = undefined;
    }
  }

  /** Record removal delivery before callbacks; the stable identity is the removal digest. */
  async markRemovalNotificationDelivered(): Promise<void> {
    await this.#removalHydrated;
    if (
      this.#removalEvidence &&
      this.#removalEvidence.notificationState !== "delivered"
    ) {
      await this.#persistRemovalEvidence({
        ...this.#removalEvidence,
        notificationState: "delivered",
      });
    }
  }

  /** Runs one retained-input scheduler edge through the normal reconciliation seam. */
  async driveConvergence(): Promise<DispositionedIngestResult[]> {
    await this.#terminalHydrated;
    await this.#removalHydrated;
    if (this.removalBlocked || this.#removalEvidence) return this.reconverge();
    await this.#deliveredHydrated;
    if (this.#destroyed) return [];
    if (this.#terminalTombstone) return this.#resumeTerminalWork();
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
    this.#clearPublications();
    this.#engine.dispose();
    // A captured retention revision owns engine mutation until its adapter
    // finishes. Destruction fences admission now and wipes after that barrier.
    if (!this.#retentionInFlight) this.#engine.destroyDeliveredPayloads();
    this.#pendingInvalidations.clear();
    this.#pendingMessages.length = 0;
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
    await Promise.allSettled([this.#retentionInFlight, this.#saveInFlight]);
    await Promise.allSettled([...this.#localWrites]);
    this.#engine.destroyDeliveredPayloads();
    // Purge through the history so its in-memory rumor cache and live
    // subscribers see the removal, then delete the database itself.
    await this.history?.purgeMessages();
    if (this.#dropDatabase) {
      // Every group record lives in this database: nothing can be left behind.
      await this.#dropDatabase();
      return;
    }
    await this.#clearDatabase();
  }

  /** Deletes every record this session knows about (no database drop available). */
  async #clearDatabase(): Promise<void> {
    const tree = await GroupHistoryTree.stagePurge(
      groupTreeStore(this.database),
    );
    const clearRecord: Required<GroupRecordUpdate> = {
      state: null,
      registryState: null,
      removed: null,
      removal: null,
      disbandRequest: null,
      disbandConvergence: null,
      disbandTombstone: null,
      publication: null,
      checkpoint: null,
    };
    await this.database.transaction(async (tx) => {
      for (const tag of tree.deletes) await tx.treeNodes.delete(tag);
      await tx.wrappers.deleteBelow(Number.MAX_SAFE_INTEGER);
      await ConvergenceEffectLedger.clear(tx);
      for (const row of await tx.deliveries.withEvidence())
        await tx.deliveries.delete(row.id);
      for (const row of await tx.messages.query({})) {
        for (const delivery of await tx.deliveries.byRumor(row.id))
          await tx.deliveries.delete(delivery.id);
        await tx.messages.delete(row.id);
      }
      await tx.updateGroup(clearRecord);
    });
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

  /** Consumes the callback attempt before external code runs; it can be lost on crash. */
  async markDisbandNotificationDelivered(): Promise<
    DisbandTombstone | undefined
  > {
    if (this.#destroyed) return undefined;
    if (this.#disbandNotificationInFlight) {
      await this.#disbandNotificationInFlight;
      return undefined;
    }
    const notification = this.#whileOpen(() =>
      this.#markDisbandNotificationDelivered(),
    );
    this.#disbandNotificationInFlight = notification;
    try {
      return await notification;
    } finally {
      if (this.#disbandNotificationInFlight === notification)
        this.#disbandNotificationInFlight = undefined;
    }
  }

  async #markDisbandNotificationDelivered(): Promise<
    DisbandTombstone | undefined
  > {
    await this.#terminalHydrated;
    this.assertOpen();
    const current = this.#terminalTombstone;
    if (!current || current.notificationState === "delivered") return undefined;
    if (!this.#terminalProjectionComplete)
      await this.#finishDisbandProjection();
    const delivered: DisbandTombstone = {
      ...current,
      notificationState: "delivered",
    };
    await this.records.update({
      disbandTombstone: toStoredDisbandTombstone(delivered),
    });
    this.assertOpen();
    this.#terminalTombstone = delivered;
    return delivered;
  }

  /** Waits until both durable lifecycle namespaces have been decoded. */
  async hydrateLifecycleEvidence(): Promise<void> {
    await this.#write(async () => {
      await this.#terminalHydrated;
      await this.#removalHydrated;
      await this.#deliveredHydrated;
      if (this.#destroyed) return;
      await this.#engine.disbandRequest();
    });
  }

  /**
   * WR-02: the guarded, best-effort form of {@link persistSelectedDisband}
   * that every internal caller uses.
   *
   * `persistSelectedDisband` historically THREW without a lifecycle store, and that store
   * is optional in both `GroupSessionOptions` and `MarmotGroupOptions` — while
   * `#selectedDisbandEvidence` is set by the engine for any inbound disband
   * commit that wins selection, store or no store. Calling it unguarded at the
   * end of `ingest` therefore threw for every store-less session, after
   * results had been yielded and BEFORE `save()`, so the batch persisted
   * nothing and the next ingest repeated it.
   *
   * Selected evidence fences immediately even without optional storage. A
   * failed projection remains retryable until every cleanup step completes.
   */
  async #persistSelectedDisbandIfPossible(
    evidence: DisbandCandidateEvidence | undefined,
  ): Promise<void> {
    if (!evidence) return;
    await this.#terminalHydrated;
    if (this.#destroyed) return;
    this.#fenceDisband(evidence, this.state);
    if (this.#terminalProjectionComplete) return;
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
    this.#fenceDisband(evidence, this.state);
    if (!this.#terminalProjectionComplete)
      await this.#finishDisbandProjection();
    return this.#terminalTombstone!;
  }

  #fenceDisband(evidence: DisbandCandidateEvidence, state: ClientState): void {
    if (this.#terminalTombstone) return;
    this.#clearPublications();
    const tombstone: DisbandTombstone = {
      groupId: this.id.slice(),
      selectedEpoch: Math.max(
        Number(state.groupContext.epoch),
        evidence.sourceEpoch + 1,
      ),
      commitDigest: evidence.commitDigest.slice(),
      actorPubkey: evidence.actorPubkey,
      notificationState: "pending",
    };
    this.#terminalTombstone = tombstone;
    this.#terminalIntent = {
      tombstone,
      registryState: serializeClientState(scrubTerminalRegistryState(state)),
    };
    this.#onChanged?.();
  }

  async #finishDisbandProjection(): Promise<void> {
    if (this.#terminalProjectionComplete) return;
    if (this.#terminalProjectionInFlight)
      return this.#terminalProjectionInFlight;
    const projection = this.#writeDisbandProjection();
    this.#terminalProjectionInFlight = projection;
    try {
      await projection;
    } finally {
      if (this.#terminalProjectionInFlight === projection)
        this.#terminalProjectionInFlight = undefined;
    }
  }

  async #writeDisbandProjection(): Promise<void> {
    if (!this.#terminalIntent) return;
    const intent = this.#terminalIntent;
    // Terminal authority (tombstone + scrubbed registry shell) commits in one
    // record update; cleanup below is repeatable.
    await this.records.update({
      disbandTombstone: toStoredDisbandTombstone(this.#terminalTombstone!),
      registryState: intent.registryState,
    });
    this.assertOpen();
    await this.#cleanupAfterDisband();
    this.#terminalProjectionComplete = true;
  }

  async #hydrateDisbandTombstone(): Promise<void> {
    const idHex = bytesToHex(this.id);
    const stored = await this.database.group();
    if (!stored.disbandTombstone || this.#destroyed || this.#disposed) return;
    // The tombstone and registry shell are written together: they are the
    // terminal authority. The group id is implicit in the group database.
    const tombstone = fromStoredDisbandTombstone(
      stored.disbandTombstone,
      this.id,
    );
    let intent: DisbandTerminalIntent | undefined;
    if (stored.registryState !== undefined) {
      if (
        !(stored.registryState instanceof Uint8Array) ||
        !stored.registryState.length
      )
        throw new Error("Invalid disband terminal intent");
      if (
        bytesToHex(
          deserializeClientState(stored.registryState).groupContext.groupId,
        ) !== idHex
      )
        throw new Error("Invalid disband terminal intent shell group id");
      intent = { tombstone, registryState: stored.registryState };
    }
    this.#terminalTombstone = tombstone;
    this.#terminalIntent = intent ?? {
      tombstone,
      registryState: serializeClientState(
        scrubTerminalRegistryState(this.state),
      ),
    };
    this.#onChanged?.();
    await this.#write(() => this.#finishDisbandProjection());
  }

  async #cleanupAfterDisband(): Promise<void> {
    this.#engine.dispose();
    await this.#deliveredHydrated;
    // Retraction decoding still depends on the abandoned branch's nodes.
    await this.#engine.history.flush();
    await this.#persistDelivered();
    await this.records.update({
      disbandRequest: null,
      disbandConvergence: null,
      removed: null,
      state: null,
    });
    await this.#wrapperLedger.clear();
    await this.#cleanupTerminalHistory();
    this.#dirty = false;
  }

  async #cleanupTerminalHistory(): Promise<void> {
    await this.history?.purgeMessages();
    // Plaintext delivery evidence goes before the tree it is attributed to.
    const evidence = await this.database.deliveries.withEvidence();
    const treeStore = groupTreeStore(this.database);
    const tree = await GroupHistoryTree.stagePurge(treeStore);
    await this.database.transaction(async (tx) => {
      for (const row of evidence) await tx.deliveries.delete(row.id);
      // Plaintext goes even when no history object is attached.
      for (const row of await tx.messages.query({}))
        await tx.messages.delete(row.id);
      await applyTreeWrite(tx, tree);
      await tx.updateGroup({ publication: null });
    });
    this.#deliveries.clear();
  }

  async #resumeTerminalWork(): Promise<DispositionedIngestResult[]> {
    if (!this.#terminalProjectionComplete) {
      try {
        await this.#write(() => this.#finishDisbandProjection());
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
    }
    if (this.#terminalProjectionComplete)
      await this.#write(() => this.#cleanupTerminalHistory());
    return (await this.#effectLedger.pending()).map((pending) => ({
      ...pending,
      disposition: ingestResultDisposition(pending),
    }));
  }

  /** Releases engine resources (the settle-check timer); call on teardown (B5). */
  dispose(): void {
    this.#disposed = true;
    this.#clearPublications();
    this.#engine.dispose();
  }

  /** @internal Keep recovery writes inside the owner's destruction and retention barriers. */
  async persistPublication(operation: () => Promise<unknown>): Promise<void> {
    await this.#write(operation);
    this.assertOutboundOpen();
  }

  /** Restore the gate without making the retained pending state canonical. */
  restorePendingPublication(pending: PendingState): void {
    this.assertOutboundOpen();
    this.#engine.restorePendingPublication(pending);
  }

  confirmPublished(pending: PendingState): StateNotification[] {
    this.assertOpen();
    const historySizeBefore = this.#engine.history.size;
    const notifications = this.#engine.confirmPublished(pending);
    this.#finishPublication(pending);
    if (this.#engine.history.size !== historySizeBefore)
      this.#onHistoryChanged?.();
    return notifications;
  }

  publishFailed(pending: PendingState): void {
    if (this.#destroyed || this.#disposed) return;
    this.#engine.publishFailed(pending);
    this.#finishPublication(pending);
  }

  #associatePublication(result: SendResult<NostrEvent> | undefined): void {
    if (!result || !("pending" in result) || !("envelope" in result)) return;
    const record = this.#pendingPublications.get(result.envelope.id);
    if (record) record.pendingState = result.pending;
  }

  #releasePublications(ids: Iterable<string>): void {
    let released = false;
    for (const id of ids)
      released = this.#pendingPublications.delete(id) || released;
    if (released) this.#markRetentionPending();
  }

  /** Ownership transfers only after every session preparation step succeeds. */
  async #prepareOutbound(
    operation: (associate: AssociatePublication) => Promise<GroupEffects>,
    beforeHandoff?: () => void,
  ): Promise<GroupEffects> {
    const owned = new Map<string, PendingState | undefined>();
    const associate: AssociatePublication = (result) => {
      if (!result || !("envelope" in result)) return;
      owned.set(
        result.envelope.id,
        "pending" in result ? result.pending : undefined,
      );
      this.#associatePublication(result);
    };
    try {
      const effects = await this.#whileOpen(() => operation(associate));
      this.assertOutboundOpen();
      beforeHandoff?.();
      return effects;
    } catch (error) {
      // These exact results were never handed to any publisher. Other sends,
      // returned application retries and sent-content evidence keep ownership.
      try {
        if (!this.#destroyed && !this.#disposed)
          for (const pending of owned.values())
            if (pending) this.#engine.publishFailed(pending);
      } finally {
        this.#releasePublications(owned.keys());
      }
      throw error;
    }
  }

  #finishPublication(pending: PendingState): void {
    const contentId =
      pending.commitMessage && contentDedupId(pending.commitMessage);
    for (const [id, record] of this.#pendingPublications)
      if (
        record.pendingState === pending ||
        (contentId && record.contentId === contentId)
      )
        this.#pendingPublications.delete(id);
    this.#markRetentionPending();
  }

  #registerRetentionOwners(): void {
    if (this.#destroyed || this.#disposed || this.#terminalTombstone) return;
    registerPublicationRetention(this, (eventId) => {
      if (this.#pendingPublications.delete(eventId))
        this.#markRetentionPending();
    });
    registerPublicationPreparationOwner(this.#engine, (ids) =>
      this.#releasePublications(ids),
    );
    registerSettledRetentionOwner(this.#engine, async () => {
      if (this.#destroyed || this.#disposed || this.#terminalTombstone) return;
      try {
        await this.save();
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
    });
  }

  #clearPublications(): void {
    unregisterPublicationPreparationOwner(this.#engine);
    unregisterSettledRetentionOwner(this.#engine);
    unregisterPublicationRetention(this);
    this.#pendingPublications.clear();
    this.#sentEventIds.clear();
  }

  #markRetentionPending(): void {
    this.#retentionVersion++;
    this.#retentionPending = true;
  }

  proposalContext(): ProposalContext {
    const groupData = this.groupData;
    if (!groupData)
      throw new Error("MarmotGroupData not found in ClientState.");
    return { state: this.state, ciphersuite: this.ciphersuite, groupData };
  }

  async send(intent: GroupSessionSendIntent): Promise<GroupEffects> {
    await this.#retentionInFlight;
    await this.#assertOutboundMembership();
    const admitted = { ...intent };
    return this.#prepareOutbound(
      (associate) => this.#send(admitted, associate),
      () => {
        if (
          admitted.kind === "commit" ||
          admitted.kind === "applicationMessage"
        )
          admitted.signal?.throwIfAborted();
      },
    );
  }

  async #send(
    intent: GroupSessionSendIntent,
    associate: AssociatePublication,
  ): Promise<GroupEffects> {
    await this.#deliveredHydrated;
    this.assertOpen();
    switch (intent.kind) {
      case "applicationMessage": {
        intent.signal?.throwIfAborted();
        if (
          intent.expectedParent !== undefined &&
          intent.expectedParent !== this.parentToken
        )
          throw new StaleMediaPreparationError();
        const sendResult = await this.#engine.send({
          kind: "applicationMessage",
          payload: intent.payload,
          expectedParent: intent.expectedParent,
        });
        associate(sendResult);
        this.assertOpen();
        if (sendResult.kind !== "applicationMessage") {
          throw new Error(
            "Expected applicationMessage result from applicationMessage send",
          );
        }
        this.#pendingMessages.push(intent.payload);
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
        associate(sendResult);
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
        associate(sendResult);
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
        associate(sendResult);
        if (intent.signal?.aborted) {
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
    await this.#assertOutboundMembership();
    return this.#prepareOutbound((associate) =>
      this.#requestDisband(associate),
    );
  }

  async #requestDisband(
    associate: AssociatePublication,
  ): Promise<GroupEffects> {
    const sendResult = await this.#engine.requestDisband();
    associate(sendResult);
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
    await this.#assertOutboundMembership();
    return this.#prepareOutbound((associate) =>
      this.#enableGroupDisbanding(associate),
    );
  }

  async #enableGroupDisbanding(
    associate: AssociatePublication,
  ): Promise<GroupEffects> {
    const sendResult = await this.#engine.enableGroupDisbanding();
    associate(sendResult);
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
    await this.#assertOutboundMembership();
    return this.#prepareOutbound((associate) =>
      this.#leave(ownPubkey, associate),
    );
  }

  async #leave(
    ownPubkey: string,
    associate: AssociatePublication,
  ): Promise<GroupEffects> {
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
      associate(sendResult);
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
    await this.#removalHydrated;
    await this.#deliveredHydrated;
    if (this.#destroyed) return;
    if (
      this.#removalFenced &&
      this.state.groupActiveState.kind !== "removedFromGroup"
    ) {
      for (const event of events) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          reason: "self-evicted",
        };
        yield { ...skipped, disposition: ingestResultDisposition(skipped) };
      }
      return;
    }
    if (this.#terminalTombstone) {
      for (const pending of await this.#resumeTerminalWork()) yield pending;
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
    for (const pending of await this.#effectLedger.pending())
      yield { ...pending, disposition: ingestResultDisposition(pending) };
    const selfEcho: Array<{ event: NostrEvent; stateTag: string }> = [];
    const rest: NostrEvent[] = [];

    for (const event of events) {
      if (this.#destroyed) return;
      // Terminal wrapper records commit atomically with the state they
      // produced, so a durable record always means "already applied".
      if (await this.#wrapperLedger.get(event.id)) continue;
      const sent = this.#sentEventIds.get(event.id);
      if (sent) {
        this.#sentEventIds.delete(event.id);
        selfEcho.push({ event, stateTag: sent.stateTag });
      } else rest.push(event);
    }

    for (const { event, stateTag } of selfEcho) {
      if (this.#destroyed) return;
      const source = await this.historyTree.stateAt(stateTag);
      const peeled = await this.#peeler.peelGroupMessages(
        [event],
        source ?? this.state,
      );
      const message = peeled.read[0]?.message;
      if (message) {
        const skipped: SkippedIngestResult = {
          kind: "skipped",
          event,
          message,
          reason: "self-echo",
        };
        const disposition = ingestResultDisposition(skipped);
        await this.#write(() =>
          this.#wrapperLedger.record(
            event.id,
            "stale",
            this.#wrapperEpoch(message),
          ),
        );
        if (this.#destroyed) return;
        yield { ...skipped, disposition };
      }
    }

    for await (const result of this.#engine.ingest(rest, options)) {
      if (this.#destroyed) return;
      const mapped = mapEngineIngestResult(result);
      if (mapped.kind === "removed" && mapped.removalAttribution) {
        await this.#persistRemovalEvidence({
          ...mapped.removalAttribution,
          notificationState: "pending",
        });
      }

      if (mapped.kind === "processed")
        await this.#persistSelectedDisbandIfPossible(mapped.selectedTerminal);

      if (this.#destroyed) return;

      const reconciledResults = await this.#reconcile(mapped);
      const retryableUnreadable =
        mapped.kind === "unreadable" && mapped.decryptFailure === true;
      const terminal =
        "event" in mapped &&
        mapped.disposition.kind !== "deferred" &&
        !retryableUnreadable;
      // A live terminal fence is not a durable projection. Do not let wrapper
      // dedup suppress replay if the first recoverable terminal write failed.
      if (
        terminal &&
        (!this.#terminalTombstone || this.#terminalProjectionComplete)
      ) {
        const outcome =
          mapped.disposition.kind === "accepted"
            ? "accepted"
            : mapped.disposition.kind === "invalidated"
              ? "invalidated"
              : "stale";
        // The terminal record commits in the same batch as the state and
        // fork material it describes.
        this.#stagedWrappers.set(mapped.event.id, {
          outcome,
          epoch: this.#wrapperEpoch(
            "message" in mapped ? mapped.message : undefined,
          ),
        });
        await this.save(true);
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
        this.#pendingInvalidations.set(result.event.id, entry);
        await this.#persistDelivered();
      } catch (error) {
        this.#onHistoryError?.(error as Error);
      }
    }
    if (result.kind === "stateInvalidated") {
      return (await this.#write(() =>
        this.#effectLedger.prepareWithdrawal(
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
          this.#effectLedger.prepareAdoption(digest, group),
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
    await this.#retentionInFlight;
    await this.#write(() =>
      this.#effectLedger.acknowledge(
        result.commitDigest,
        result.kind === "stateInvalidated" ? "withdrawal" : "adoption",
      ),
    );
    this.#markRetentionPending();
  }

  /** The source epoch of a wrapper's message, else the epoch it completed at. */
  #wrapperEpoch(message?: import("ts-mls").MlsMessage): number {
    const epoch = message && framedEpoch(message);
    if (
      epoch !== undefined &&
      Number.isSafeInteger(Number(epoch)) &&
      epoch >= 0n
    )
      return Number(epoch);
    return Number(this.state.groupContext.epoch);
  }

  async #hydrateDelivered(): Promise<void> {
    const rows = await this.database.deliveries.withEvidence();
    if (this.#destroyed || this.#disposed) return;
    const entries = rows.map((row) =>
      fromDeliveryRow(row, this.#engine.history),
    );
    this.#engine.importDeliveredPayloads(entries);
    rows.forEach((row, index) =>
      this.#deliveries.set(row.id, {
        rumorId: row.rumorId,
        stateTag: entries[index]!.stateTag,
        transportId: entries[index]!.transportId!,
        epoch: row.epoch,
        createdAt: row.createdAt,
        evidence: true,
      }),
    );
  }

  /** Commits delivery bookkeeping that changed without a state save. */
  async #persistDelivered(): Promise<void> {
    await this.#retentionInFlight;
    if (this.#destroyed) return;
    await this.#write(async () => {
      const batch = new GroupBatch(this.database);
      const deliveries = this.#stageDeliveries(batch);
      await batch.commit();
      await deliveries.finish();
    });
  }
}

/** What the session remembers about a persisted `deliveries` row. */
type PersistedDelivery = {
  rumorId: string;
  stateTag: string;
  transportId: string;
  epoch: number;
  createdAt: number;
  /** Whether the row still holds re-adoption evidence. */
  evidence: boolean;
};

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
