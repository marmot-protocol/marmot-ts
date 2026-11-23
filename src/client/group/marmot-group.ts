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
  encode,
  getCredentialFromLeafIndex,
  type LeafIndex,
  mlsMessageEncoder,
  protocolVersions,
  Proposal,
  Welcome,
  wireformats,
} from "ts-mls";

import type { ProposalAction, ProposalContext } from "../../engine/types.js";
import type { GroupProfileSupport } from "../../core/components/account-identity-proof.js";
import type { MediaAttachment } from "../../core/media.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import { watchCurrent } from "../../utils/watch-current.js";
import { getGroupMemberPubkeys } from "../../core/group-members.js";
import type { MarmotGroupView } from "../../core/client-state.js";
import type { ConvergenceStatus } from "../../core/convergence-status.js";
import type { GroupLifecycleState } from "../../core/group-lifecycle.js";
import { mayReleaseOutbound } from "../../core/convergence-status.js";
import { groupLifecycleStates } from "../../core/group-lifecycle.js";
import { commitDigest } from "../../core/convergence.js";
import type { ConvergenceScheduler } from "../../engine/group-engine.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { GroupHistoryTree } from "../../engine/history-tree.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import type {
  DisbandFailureReason,
  DisbandRequest,
} from "../../engine/disband-request.js";
import type { DisbandTombstone } from "../../engine/disband-tombstone.js";
import { buildForkTreeView, type ForkTreeView } from "./fork-tree-view.js";
import { logger } from "../../utils/debug.js";
import type { MarmotGroupDatabase } from "../storage/database/types.js";
import {
  getMarmotGroupInfo,
  type MarmotGroupInfo,
} from "../../core/client-state.js";
import {
  evaluateKeyPackageForGroup,
  type KeyPackageEligibility,
} from "../../core/key-package-eligibility.js";
import { PendingPublicationStore } from "../storage/pending-publication.js";
import { GroupRuntime } from "../runtime/group-runtime.js";
import { linkPublicationRetention } from "../runtime/publication-retention.js";
import type {
  GroupPublishResult,
  GroupSessionSendIntent,
} from "../session/group-effects.js";
import {
  GroupSession,
  ingestResultDisposition,
  type AppliedNotificationsIngestResult,
  type DispositionedIngestResult,
  type ProposalBuilder,
} from "../session/group-session.js";
import { NostrNetworkInterface, PublishResponse } from "../nostr-interface.js";
import { NostrWelcomeDelivery } from "../transport/nostr/welcome-delivery.js";
import { GroupImageService } from "./group-image-service.js";
import type {
  WelcomeDeliveryOutcome,
  WelcomeRecipient,
} from "../transport/nostr/welcome-delivery.js";
import {
  GroupMediaService,
  type DecryptedMedia,
  type EncryptMediaMetadata,
} from "./group-media-service.js";
import { GroupHistory } from "../storage/group-history.js";
import { SessionDatabase } from "../session/session-database.js";
import { MemoryGroupDatabases } from "../storage/database/memory.js";
import { GroupHistoryTree as HistoryTree } from "../../engine/history-tree.js";
import { serializeClientState } from "../../core/client-state.js";
import { groupTreeStore } from "../storage/database/group-batch.js";
import { ConvergenceEffectLedger } from "../storage/wrapper-ledger.js";
import { getCredentialPubkey } from "../../core/credential.js";

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

export type MarmotGroupStatus = "active" | "removed" | "disbanded";

/** Read-only UI projection. Byte arrays are owned copies and must be treated as read-only. */
export type GroupSnapshotValue<T> = T extends Uint8Array
  ? Readonly<Uint8Array>
  : T extends object
    ? { readonly [K in keyof T]: GroupSnapshotValue<T[K]> }
    : T;

/** Cached UI state; never includes the MLS private state. */
export interface MarmotGroupSnapshot {
  readonly id: string;
  readonly version: number;
  readonly status: MarmotGroupStatus;
  readonly profileSupport: GroupSnapshotValue<GroupProfileSupport>;
  readonly groupData: GroupSnapshotValue<MarmotGroupView> | null;
  readonly members: readonly string[];
  readonly epoch: bigint;
  readonly convergenceStatus: ConvergenceStatus;
  readonly lifecycle: GroupLifecycleState;
  readonly welcomeDeliveries: readonly GroupSnapshotValue<WelcomeDeliveryOutcome>[];
  readonly pendingWelcomes: readonly GroupSnapshotValue<WelcomeDeliveryOutcome>[];
  /** Revision of the fork-history tree structure, including changes without a new epoch. */
  readonly historyVersion: number;
}

function snapshotCopy<T>(value: T): GroupSnapshotValue<T> {
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || ArrayBuffer.isView(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  const copy = structuredClone(value);
  freeze(copy);
  return copy as GroupSnapshotValue<T>;
}

/** Stable typed refusal for every operation attempted after canonical disband. */
export class GroupTerminalError extends Error {
  readonly reason = "group_disbanded" as const;

  constructor() {
    super("Group is disbanded");
    this.name = "GroupTerminalError";
  }
}

export interface GroupDisbandedEvent {
  readonly actorPubkey: string;
  readonly commitDigest: Uint8Array;
}

export type EnableDisbandingResult =
  | { kind: "enabled"; publication: GroupPublishResult }
  | { kind: "alreadyEnabled" }
  | {
      kind: "rejected";
      reason: "unsupportedMembers" | "notAdmin" | "legality";
      error: string;
    }
  | { kind: "publishFailed"; error: string };

export type DisbandResult =
  | {
      kind: "acknowledged";
      request: Extract<DisbandRequest, { status: "pending" }>;
      publication: GroupPublishResult;
    }
  | {
      kind: "pending";
      request: Extract<DisbandRequest, { status: "pending" }>;
    }
  | { kind: "failed"; reason: DisbandFailureReason }
  | { kind: "rejected"; reason: "notEnabled" | "legality"; error: string }
  | {
      kind: "publishFailed";
      request: Extract<DisbandRequest, { status: "pending" }>;
      error: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One process-local recipient obligation shared by fanout and retry settlement. */
type FoundingWelcomeDelivery = {
  recipient: WelcomeRecipient;
  outcome?: WelcomeDeliveryOutcome;
  retry?: Promise<WelcomeDeliveryOutcome>;
};

export type {
  DispositionedIngestResult,
  IngestResult,
  ProcessedIngestResult,
  RejectedIngestResult,
  SkippedIngestResult,
  DeferredIngestResult,
  InvalidatedIngestResult,
  AutoCommitIngestResult,
  AppliedNotificationsIngestResult,
  RemovedIngestResult,
  UnreadableIngestResult,
} from "../session/group-session.js";
export { ingestResultDisposition } from "../session/group-session.js";

/**
 * Finds the first group-state commit that existed at settlement. The caller
 * still executes it through the engine's exact authorization gate; this helper
 * only assigns the bounded scheduling opportunity.
 */
export function selectFairQueuedStateIntent(
  queue: readonly { intent: { kind: string } }[],
  settledQueueLength: number,
): number | undefined {
  const limit = Math.min(queue.length, Math.max(0, settledQueueLength));
  for (let index = 0; index < limit; index++)
    if (queue[index]!.intent.kind === "commit") return index;
  return undefined;
}

export type MarmotGroupOptions = {
  /** This group's own database: protocol state, fork history and messages. */
  database: MarmotGroupDatabase;
  /** Permanently deletes this group's database when the group is destroyed. */
  dropDatabase?: () => Promise<void>;
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
   * Keep the finite profile-1 default for production. `Infinity` is an explicit
   * debugging/forensics choice that can retain unbounded fork evidence.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Tuning for the persistent ingestion pool (size + epoch-age bounds on
   * undecryptable events held for retry). Defaults bound it.
   */
  ingestionPool?: IngestionPoolOptions;
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
   * by the internal loader (`GroupRegistry`); not part of the public construction
   * API.
   */
  retained?: RetainedHistoryStore;
  /**
   * A full-fork history tree rehydrated from storage on load. Set by
   * the internal loader (`GroupRegistry`); not part of the public construction API.
   */
  historyTree?: GroupHistoryTree;
};

/** Map of events that can be emitted by a MarmotGroup */
export type MarmotGroupEvents = {
  /** Emitted synchronously after a distinct UI snapshot is installed. */
  changed: (group: MarmotGroup) => void;
  /** Reconciled results from ingestion, history recovery, and settlement. */
  ingestResult: (result: DispositionedIngestResult) => void;
  /** Emitted when the group state is updated */
  stateChanged: (state: ClientState) => void;
  /** Emitted when a new application message is received */
  applicationMessage: (message: Uint8Array) => void;
  /** Emitted when the group state is saved */
  stateSaved: (group: MarmotGroup) => void;
  /** Emitted once when in-memory resources and watchers are released. */
  disposed: (group: MarmotGroup) => void;
  /** Emitted when the group is destroyed */
  destroyed: (group: MarmotGroup) => void;
  /**
   * Emitted when an inbound commit removed this member from the group — an
   * admin's involuntary Remove, or a peer committing this member's own
   * self_remove. Local state is kept as a `removedFromGroup` tombstone (it is
   * persisted, but the group can no longer send or decrypt); the application
   * decides when to call {@link MarmotGroup.destroy} to purge it.
   */
  removed: (group: MarmotGroup) => void;
  /** At-most-once callback attempt after its durable record, when storage exists. */
  disbanded: (group: MarmotGroup, evidence: GroupDisbandedEvent) => void;
  /** Emitted when history persistence fails (best-effort, non-blocking) */
  historyError: (error: Error) => void;
  /**
   * Emitted when the fork-history tree grew during ingest — a new commit or a
   * newly observed fork branch. Fires even when the canonical state is
   * unchanged (a superseded fork still adds nodes). Read {@link MarmotGroup.forkTreeView}
   * to re-render.
   */
  historyChanged: (group: MarmotGroup) => void;
};

type RemovedListener = {
  fn: (group: MarmotGroup) => void;
  context: unknown;
  once: boolean;
};

/**
 * The main class for interacting with a MLS group
 */
export class MarmotGroup extends EventEmitter<MarmotGroupEvents> {
  #snapshot!: MarmotGroupSnapshot;
  #stateRevision = 0;
  #snapshotStateRevision = -1;
  #snapshotDeliveries: readonly WelcomeDeliveryOutcome[] = [];
  #snapshotTreeSize = -1;
  #snapshotTreeRoot?: string;
  #historyVersion = 0;
  #snapshotReady = false;
  readonly #watchController = new AbortController();

  /** Synchronous current UI state; reference-stable until `changed` fires. */
  get snapshot(): MarmotGroupSnapshot {
    return this.#snapshot;
  }

  /** Monotonically increasing revision of {@link snapshot}. */
  get version(): number {
    return this.#snapshot.version;
  }

  /** Yields the current snapshot first; abort/return/disposal ends the stream. */
  watch(options?: {
    signal?: AbortSignal;
  }): AsyncGenerator<MarmotGroupSnapshot> {
    return watchCurrent({
      read: () => this.snapshot,
      subscribe: (changed) => {
        this.on("changed", changed);
        return () => this.off("changed", changed);
      },
      signal: options?.signal,
      closed: this.#watchController.signal,
    });
  }

  #refreshSnapshot(): void {
    if (!this.#snapshotReady || this.#watchController.signal.aborted) return;
    const previous = this.#snapshot;
    const state = this.state;
    const status = this.status;
    const lifecycle = this.lifecycle;
    const convergenceStatus = this.convergenceStatus;
    const tree = this.session.historyTree;
    if (
      tree.size !== this.#snapshotTreeSize ||
      tree.rootTag !== this.#snapshotTreeRoot
    ) {
      if (previous) this.#historyVersion++;
      this.#snapshotTreeSize = tree.size;
      this.#snapshotTreeRoot = tree.rootTag;
    }
    const historyVersion = this.#historyVersion;
    const deliveries = this.welcomeDeliveries;
    const sameState = this.#snapshotStateRevision === this.#stateRevision;
    const sameDeliveries =
      deliveries.length === this.#snapshotDeliveries.length &&
      deliveries.every(
        (value, index) => value === this.#snapshotDeliveries[index],
      );
    if (
      previous &&
      sameState &&
      sameDeliveries &&
      previous.status === status &&
      previous.lifecycle === lifecycle &&
      previous.convergenceStatus === convergenceStatus &&
      previous.historyVersion === historyVersion
    )
      return;
    const welcomeDeliveries =
      sameDeliveries && previous
        ? previous.welcomeDeliveries
        : snapshotCopy(deliveries);
    this.#snapshotStateRevision = this.#stateRevision;
    this.#snapshotDeliveries = deliveries;
    this.#snapshot = Object.freeze({
      id: this.idStr,
      version: previous ? previous.version + 1 : 0,
      status,
      profileSupport:
        sameState && previous
          ? previous.profileSupport
          : snapshotCopy(this.profileSupport),
      groupData:
        sameState && previous?.status === status
          ? previous.groupData
          : snapshotCopy(this.groupData),
      members:
        sameState && previous?.status === status
          ? previous.members
          : Object.freeze(
              status === "disbanded" ? [] : getGroupMemberPubkeys(state),
            ),
      epoch: state.groupContext.epoch,
      lifecycle,
      convergenceStatus,
      welcomeDeliveries,
      pendingWelcomes:
        sameDeliveries && previous
          ? previous.pendingWelcomes
          : Object.freeze(
              welcomeDeliveries.filter((outcome) => outcome.kind === "failed"),
            ),
      historyVersion,
    });
    if (previous) this.emit("changed", this);
  }

  /** The key-value backend where serialized group state bytes are persisted */
  /** This group's database. */
  readonly database: MarmotGroupDatabase;

  /** The signer used for the clients identity */
  readonly signer: EventSigner;

  /** The ciphersuite implementation to use for the group */
  readonly ciphersuite: CiphersuiteImpl;

  /** The nostr relay pool to use for the group */
  readonly network: NostrNetworkInterface;

  /** The group's decrypted application messages (rumors). */
  readonly history: GroupHistory;

  /** Protocol state owner for this group. Prefer this over convenience methods. */
  #session!: GroupSession;
  get session(): GroupSession {
    return this.#session;
  }
  /** Runtime publisher for driving session effects through transport. */
  #runtime!: GroupRuntime;
  get runtime(): GroupRuntime {
    return this.#runtime;
  }
  readonly #options: MarmotGroupOptions;
  #sessionDatabase: SessionDatabase;
  #generation = 0;
  #adopting = false;
  #adoptionFinished?: Promise<void>;
  #ingestions = 0;
  /** Optional media helper for group encrypted attachments. */
  readonly mediaService: GroupMediaService;
  /** Dedicated canonical group-image source and retrieval service. */
  readonly image: GroupImageService;
  readonly #closeController = new AbortController();
  /** Aborted when this facade is unloaded, terminal or destroyed. */
  get closedSignal(): AbortSignal {
    return this.#closeController.signal;
  }

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

  /** Same-instance serialization for the marker transaction and public event. */
  #removalRealizationInFlight?: Promise<void>;
  /** Project-owned metadata for safe `removed` dispatch; never reads emitter internals. */
  readonly #removedListeners: RemovedListener[] = [];
  readonly #disbandedListeners: Array<{
    fn: (group: MarmotGroup, evidence: GroupDisbandedEvent) => void;
    context: unknown;
    once: boolean;
  }> = [];

  /**
   * FOUND-04 per-invitee Welcome delivery report, in the order recipients were
   * supplied to {@link deliverFoundingWelcomes}. In-memory only (D-04): not
   * serialized into `ClientState`, not persisted, not read on load. See
   * {@link welcomeDeliveries} / {@link pendingWelcomes} for the accepted R-04
   * consequence.
   */
  #foundingWelcome?: {
    welcome: Welcome;
    author: string;
    encoded?: string;
    deliveries: FoundingWelcomeDelivery[];
  };

  private log: Debugger;

  override on<T extends EventEmitter.EventNames<MarmotGroupEvents>>(
    event: T,
    fn: EventEmitter.EventListener<MarmotGroupEvents, T>,
    context?: unknown,
  ): this {
    if (event === "removed") {
      this.#removedListeners.push({
        fn: fn as (group: MarmotGroup) => void,
        context: context || this,
        once: false,
      });
    }
    if (event === "disbanded")
      this.#disbandedListeners.push({
        fn: fn as (group: MarmotGroup, evidence: GroupDisbandedEvent) => void,
        context: context || this,
        once: false,
      });
    return super.on(event, fn, context);
  }

  override once<T extends EventEmitter.EventNames<MarmotGroupEvents>>(
    event: T,
    fn: EventEmitter.EventListener<MarmotGroupEvents, T>,
    context?: unknown,
  ): this {
    if (event === "removed") {
      this.#removedListeners.push({
        fn: fn as (group: MarmotGroup) => void,
        context: context || this,
        once: true,
      });
    }
    if (event === "disbanded")
      this.#disbandedListeners.push({
        fn: fn as (group: MarmotGroup, evidence: GroupDisbandedEvent) => void,
        context: context || this,
        once: true,
      });
    return super.once(event, fn, context);
  }

  override removeListener<T extends EventEmitter.EventNames<MarmotGroupEvents>>(
    event: T,
    fn?: EventEmitter.EventListener<MarmotGroupEvents, T>,
    context?: unknown,
    once?: boolean,
  ): this {
    if (event === "removed") {
      if (!fn) {
        this.#removedListeners.length = 0;
      } else {
        const removedFn = fn as (group: MarmotGroup) => void;
        for (let i = this.#removedListeners.length - 1; i >= 0; i--) {
          const listener = this.#removedListeners[i];
          if (
            listener.fn === removedFn &&
            (!once || listener.once) &&
            (!context || listener.context === context)
          ) {
            this.#removedListeners.splice(i, 1);
          }
        }
      }
    }
    if (event === "disbanded") {
      if (!fn) this.#disbandedListeners.length = 0;
      else {
        const disbandedFn = fn as (
          group: MarmotGroup,
          evidence: GroupDisbandedEvent,
        ) => void;
        for (let i = this.#disbandedListeners.length - 1; i >= 0; i--) {
          const listener = this.#disbandedListeners[i]!;
          if (
            listener.fn === disbandedFn &&
            (!once || listener.once) &&
            (!context || listener.context === context)
          )
            this.#disbandedListeners.splice(i, 1);
        }
      }
    }
    return super.removeListener(event, fn, context, once);
  }

  override off<T extends EventEmitter.EventNames<MarmotGroupEvents>>(
    event: T,
    fn?: EventEmitter.EventListener<MarmotGroupEvents, T>,
    context?: unknown,
    once?: boolean,
  ): this {
    return this.removeListener(event, fn, context, once);
  }

  override removeAllListeners(
    event?: EventEmitter.EventNames<MarmotGroupEvents>,
  ): this {
    if (event === undefined || event === "removed")
      this.#removedListeners.length = 0;
    if (event === undefined || event === "disbanded")
      this.#disbandedListeners.length = 0;
    return super.removeAllListeners(event);
  }

  get id() {
    return this.session.id;
  }

  /** The group id as a hex string */
  idStr: string;

  /** Read the current group state */
  get state() {
    return this.session.state;
  }

  /** Public absorbing status; Unrecoverable deliberately remains active/repairable. */
  get status(): MarmotGroupStatus {
    if (this.session.terminalTombstone) return "disbanded";
    return this.session.removalBlocked ? "removed" : "active";
  }

  /**
   * Account-identity-proof profile support is orthogonal to membership
   * `status` (D-11): a stored group whose GroupContext does not classify as
   * the current profile (legacy, mixed, or missing the `0x8009` requirement)
   * stays listable and `destroy()`-able, but every outbound send and every
   * inbound event is refused. Delegates to `session.profileSupport`, which
   * recomputes from the engine on every access.
   */
  get profileSupport(): GroupProfileSupport {
    return this.session.profileSupport;
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
    return this.status === "disbanded" ? null : this.session.groupData;
  }

  /** Complete group info/debug model for chat panels and diagnostics. */
  get info(): MarmotGroupInfo {
    const info = getMarmotGroupInfo(this.state);
    if (this.status !== "disbanded") return info;
    return {
      ...info,
      mls: { ...info.mls, memberCount: 0, proposalCount: 0 },
      app: {
        view: null,
        components: [],
        componentCount: 0,
        requiredComponentIds: [],
      },
      nostr: { relays: [], relayCount: 0, hasRouting: false },
      members: { pubkeys: [], count: 0 },
    };
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
   * Group transport events received but not yet decrypted/processed into the
   * fork-history tree — the engine's ingestion pool (oldest-first). Normally
   * transient (a message awaiting its commit, a fork message awaiting its
   * branch); they are retried as the tree grows. An entry that lingers is a
   * received event the client could never read — a gap a full-history debugger
   * surfaces, since the unlocking state never arrived.
   */
  pendingEvents(): NostrEvent[] {
    return this.session.pendingEvents();
  }

  /**
   * Evaluates whether a candidate's KeyPackage event (kind 30443) can be added
   * to this group — cipher-suite match, `required_capabilities`,
   * agent-text-stream-QUIC `required_member_roles`, and already-a-member. Use
   * this before {@link GroupsManager.invite} to surface why a KeyPackage can't be
   * added; an `eligible: true` result is safe to invite. Never throws.
   */
  evaluateKeyPackage(keyPackageEvent: NostrEvent): KeyPackageEligibility {
    if (this.status === "disbanded") throw new GroupTerminalError();
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

  /**
   * The FOUND-04 per-invitee Welcome delivery report: one entry per recipient
   * a founding create attempted to deliver to, in delivery order.
   *
   * **This is in-memory only and is lost on restart or crash (D-04).** It is
   * discoverable state, not a returned value or a thrown error — a caller
   * that never reads it silently loses an invitee who is already a member at
   * epoch 1. The only recovery is the spec's re-invite path: the founding
   * creator MAY re-invite the unreachable member with a fresh KeyPackage
   * against the now-canonical group
   * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78). This is an
   * accepted consequence of D-04 + D-10 + D-12, not an oversight (R-04).
   */
  get welcomeDeliveries(): readonly WelcomeDeliveryOutcome[] {
    return (
      this.#foundingWelcome?.deliveries.flatMap((delivery) =>
        delivery.outcome ? [delivery.outcome] : [],
      ) ?? []
    );
  }

  /**
   * The failed subset of {@link welcomeDeliveries} — the invitees a founding
   * create has not yet reached. Retry with {@link retryWelcome}.
   *
   * Carries the same R-04 warning as {@link welcomeDeliveries}: this is
   * in-memory only, lost on restart, and ignorable by a caller that never
   * reads it. The only recovery beyond {@link retryWelcome} is the spec's
   * re-invite-with-a-fresh-KeyPackage path
   * (refs/marmot/protocol-core/publish-lifecycle.md lines 66-78).
   */
  get pendingWelcomes(): readonly WelcomeDeliveryOutcome[] {
    return this.welcomeDeliveries.filter(
      (outcome) => outcome.kind === "failed",
    );
  }

  #settleWelcomeDelivery(
    delivery: FoundingWelcomeDelivery,
    outcome: WelcomeDeliveryOutcome,
  ): WelcomeDeliveryOutcome {
    if (delivery.outcome?.kind !== "succeeded") delivery.outcome = outcome;
    this.#refreshSnapshot();
    return delivery.outcome;
  }

  /**
   * Fans out a founding Welcome to every invitee, one {@link
   * NostrWelcomeDelivery.deliverMany} call reached directly through
   * `runtime.welcomeDelivery` (D-05/D-07) — this bypasses `GroupRuntime`'s
   * publish path entirely, since a founding Add has no `GroupPublishWork` to
   * drive. Retains the Welcome and author so a failed recipient can be
   * retried later via {@link retryWelcome}.
   * Fanout and retry settlement preserve success for the same encoded Welcome,
   * author, recipient and KeyPackage event id. A replacement obligation has
   * independent outcomes and retry work; older attempts settle only their own
   * obligation. The report follows the most recently started fanout's order.
   *
   * Never throws and never saves: partial or total Welcome failure is a
   * normal outcome (D-12), reported through {@link pendingWelcomes} rather
   * than raised. `GroupFactory.create` refuses a founding create without
   * valid group relays (CR-01), so on the factory path this group always
   * carries relays; the group-relay list is forwarded both as each Welcome
   * rumor's required relays tag and as `deliver`'s inbox-lookup fallback, and
   * a recipient whose own inbox lookup resolves empty still fails
   * independently of the others.
   */
  async deliverFoundingWelcomes(options: {
    welcome: Welcome;
    author: string;
    recipients: WelcomeRecipient[];
  }): Promise<readonly WelcomeDeliveryOutcome[]> {
    let encoded: string | undefined;
    try {
      encoded = bytesToHex(
        encode(mlsMessageEncoder, {
          version: protocolVersions.mls10,
          wireformat: wireformats.mls_welcome,
          welcome: options.welcome,
        }),
      );
    } catch {
      // Leave malformed Welcomes to the transport's per-recipient failure
      // handling; they cannot reuse a previous obligation's success.
    }
    const previous = this.#foundingWelcome;
    const sameWelcome =
      encoded !== undefined &&
      previous?.encoded === encoded &&
      previous.author === options.author;
    const deliveries = options.recipients.map(
      (recipient): FoundingWelcomeDelivery =>
        (sameWelcome
          ? previous.deliveries.find(
              (delivery) =>
                delivery.recipient.pubkey === recipient.pubkey &&
                delivery.recipient.keyPackageEventId ===
                  recipient.keyPackageEventId,
            )
          : undefined) ?? { recipient },
    );
    // Capture recipient records before awaiting transport. Pending attempts
    // retain their own record even when a different obligation replaces it.
    this.#foundingWelcome = {
      welcome: options.welcome,
      author: options.author,
      encoded,
      deliveries,
    };
    this.#refreshSnapshot();
    const outcomes = await this.runtime.welcomeDelivery.deliverMany({
      welcome: options.welcome,
      author: options.author,
      groupRelays: this.relays ?? [],
      recipients: options.recipients,
    });
    return outcomes.map((outcome, index) =>
      this.#settleWelcomeDelivery(deliveries[index]!, outcome),
    );
  }

  /**
   * Re-delivers one invitee's founding Welcome. Throws naming `pubkey` when
   * there is no matching delivery outcome, or when no founding Welcome is
   * retained (for instance after a restart) — this fails loudly rather than
   * silently no-opping, since a silent no-op is exactly R-04's failure mode.
   * When the matching entry already succeeded, returns it unchanged without
   * performing another delivery. Overlapping retries share one attempt per
   * recipient; failed or rejected attempts clear so a later call can retry.
   *
   * Deliberately has **no epoch guard**: RESEARCH Priority Finding #1
   * establishes that a late epoch-1 Welcome is safe because the joiner's
   * backfill (`GroupsManager#connectGroup`) has no `since` bound, **provided
   * the group has relays**. `GroupFactory.create` no longer produces
   * relay-less founding groups (CR-01), so on the factory path the relays
   * precondition always holds.
   */
  async retryWelcome(pubkey: string): Promise<WelcomeDeliveryOutcome> {
    const founding = this.#foundingWelcome;
    const delivery = founding?.deliveries.find(
      (delivery) => delivery.recipient.pubkey === pubkey,
    );
    if (!founding?.author || !delivery?.outcome) {
      throw new Error(
        `retryWelcome: no retained founding Welcome delivery outcome for recipient ${pubkey}`,
      );
    }
    const existing = delivery.outcome;
    if (existing.kind === "succeeded") return existing;

    const inFlight = delivery.retry;
    if (inFlight) return inFlight;

    const options = {
      welcome: founding.welcome,
      author: founding.author,
      groupRelays: this.relays ?? [],
      recipients: [existing.recipient],
    };
    // Defer transport execution until the shared promise is installed, including
    // before a transport hook can synchronously reenter retryWelcome.
    const attempt = Promise.resolve()
      .then(() => this.runtime.welcomeDelivery.deliverMany(options))
      .then(([outcome]) => this.#settleWelcomeDelivery(delivery, outcome!))
      .finally(() => {
        if (delivery.retry === attempt) delivery.retry = undefined;
      });
    delivery.retry = attempt;
    return attempt;
  }

  constructor(state: ClientState, options: MarmotGroupOptions) {
    super();
    // Loaded cryptographic history belongs only to the initial session, never
    // to the reusable facade's construction template.
    this.#options = {
      ...options,
      retained: undefined,
      historyTree: undefined,
    };
    this.database = options.database;
    this.signer = options.signer;
    this.ciphersuite = options.ciphersuite;
    this.network = options.network;

    this.history = GroupHistory.forDatabase(options.database);
    this.#sessionDatabase = new SessionDatabase(this.database);
    this.#session = this.#createSession(state, options, this.#sessionDatabase);
    this.idStr = bytesToHex(this.id);
    this.log = logger.extend(`group:${this.idStr.slice(0, 8)}`);
    this.#runtime = this.#createRuntime(this.session, this.#sessionDatabase);
    this.mediaService = new GroupMediaService({
      assertOpen: () => this.session.assertOutboundOpen(),
      getState: () => this.state,
      getCiphersuite: () => this.ciphersuite,
      getRetainedStates: () => this.session.retainedStates(),
    });
    this.image = new GroupImageService({
      getState: () => this.state,
      getRetainedStates: () => this.session.retainedStates(),
      isClosed: () => this.closedSignal.aborted || this.session.destroyed,
    });
    this.#snapshotReady = true;
    this.#refreshSnapshot();
  }

  #createSession(
    state: ClientState,
    options: MarmotGroupOptions,
    database: SessionDatabase,
    generation = this.#generation,
  ): GroupSession {
    const current = () => generation === this.#generation && !this.#adopting;
    return new GroupSession({
      state,
      ciphersuite: this.ciphersuite,
      database: database.database,
      assertAdmission: () => database.assertOpen(),
      dropDatabase: options.dropDatabase,
      retained: options.retained,
      historyTree: options.historyTree,
      convergencePolicy: options.convergencePolicy,
      ingestionPool: options.ingestionPool,
      history: {
        saveMessage: (message) =>
          database.run(() => this.history.saveMessage(message)),
        removeMessage: (id) =>
          database.run(() => this.history.removeMessage(id)),
        purgeMessages: () => database.run(() => this.history.purgeMessages()),
      },
      now: options.now,
      settlementQuiescenceMs: options.settlementQuiescenceMs,
      scheduler: options.scheduler,
      audit: options.audit,
      auditContext: options.auditContext,
      // When the quiescence window elapses, release any queued outbound (B5).
      onSettleCheck: () => {
        if (current()) return this.#settleAndDrive();
        return undefined;
      },
      onChanged: () => {
        if (current()) this.#refreshSnapshot();
      },
      onStateChanged: (newState) => {
        if (!current()) return;
        this.#stateRevision++;
        this.#refreshSnapshot();
        this.emit("stateChanged", newState);
      },
      onStateSaved: () => {
        if (current()) this.emit("stateSaved", this);
      },
      onApplicationMessage: (message) => {
        if (current()) this.emit("applicationMessage", message);
      },
      onHistoryError: (error) => {
        if (current()) this.emit("historyError", error);
      },
      onHistoryChanged: () => {
        if (!current()) return;
        this.#refreshSnapshot();
        this.emit("historyChanged", this);
      },
    });
  }

  #createRuntime(
    session: GroupSession,
    database: SessionDatabase,
  ): GroupRuntime {
    const options = this.#options;
    const records = session.records;
    const runtime = new GroupRuntime({
      welcomeDelivery: new NostrWelcomeDelivery({
        signer: this.signer,
        network: this.network,
      }),
      pendingPublications: new PendingPublicationStore({
        get: () => records.get(),
        update: (update) =>
          session.persistPublication(() => records.update(update)),
      }),
      restorePending: (pending) => session.restorePendingPublication(pending),
      isApplied: (pending) =>
        bytesToHex(session.state.confirmationTag) ===
        bytesToHex(pending.newState.confirmationTag),
      getNetwork: () => this.network,
      getRelays: () => session.groupData?.relays,
      getGroupRef: () => this.idStr,
      getGroupData: () => session.groupData,
      assertOpen: () => {
        database.assertOpen();
        session.assertOutboundOpen();
      },
      confirmPublished: (pending) => {
        database.assertOpen();
        return session.confirmPublished(pending);
      },
      publishFailed: (pending) => session.publishFailed(pending),
      save: () => {
        database.assertOpen();
        return this.#isCurrent(session) ? this.save() : session.save();
      },
      log: this.log,
      audit: options.audit,
      auditContext: options.auditContext,
    });
    linkPublicationRetention(runtime, session);
    return runtime;
  }

  /**
   * Explicitly discards a removed copy's cryptographic history and installs a
   * validated, newer Welcome. The facade, decrypted history and watchers survive.
   * Welcome authentication/authorization belongs to the caller's tentative join.
   * This is not repair-by-Welcome for an active copy (protocol-core/joining.md).
   * @internal
   */
  async rejoinFromWelcome(
    state: ClientState,
    options: { beforeAdopt?: () => Promise<void>; adoptionId?: string } = {},
  ): Promise<void> {
    if (this.#adopting) throw new Error("Group rejoin already in progress");
    if (this.#ingestions > 0)
      throw new Error("Group ingestion must be fully drained before rejoining");
    state = structuredClone(state);
    this.session.assertOpen();
    if (this.closedSignal.aborted) throw new Error("Group closed");
    const validate = () => {
      if (
        this.status !== "removed" ||
        this.state.groupActiveState.kind !== "removedFromGroup"
      )
        throw new Error("Only a removed group can rejoin from a Welcome");
      if (bytesToHex(state.groupContext.groupId) !== this.idStr)
        throw new Error("Rejoin Welcome group id mismatch");
      if (
        state.groupContext.cipherSuite !== this.state.groupContext.cipherSuite
      )
        throw new Error("Rejoin Welcome ciphersuite mismatch");
      if (state.groupActiveState.kind !== "active")
        throw new Error("Rejoin Welcome must contain active membership");
      const removal = this.session.removalEvidence;
      const removalEpoch = removal
        ? BigInt(removal.parentEpoch) + 1n
        : this.state.groupContext.epoch + 1n;
      if (
        state.groupContext.epoch <= this.state.groupContext.epoch ||
        state.groupContext.epoch <= removalEpoch
      )
        throw new Error("Rejoin Welcome must be newer than the removed copy");
    };
    validate();
    this.#adopting = true;
    let finishAdoption!: () => void;
    this.#adoptionFinished = new Promise<void>((resolve) => {
      finishAdoption = resolve;
    });
    const previous = this.session;
    const previousDatabase = this.#sessionDatabase;
    let staged: GroupSession | undefined;
    let stagedDatabase: SessionDatabase | undefined;
    let committed = false;
    try {
      await previous.hydrateLifecycleEvidence();
      validate();
      const ownIdentity = getCredentialPubkey(
        getCredentialFromLeafIndex(
          state.ratchetTree,
          state.privatePath.leafIndex as LeafIndex,
        ),
      );
      const localIdentity = await this.signer.getPublicKey();
      if (
        ownIdentity !== localIdentity ||
        (previous.removalEvidence &&
          previous.removalEvidence.localIdentity !== localIdentity)
      )
        throw new Error("Rejoin Welcome local member identity mismatch");
      // Fence all old transactions, including adapter-queued transactions, and
      // wait until none can overlap the replacement commit.
      await previousDatabase.pause();
      validate();
      const memory = await new MemoryGroupDatabases().open(this.idStr);
      stagedDatabase = new SessionDatabase(memory);
      // Never carry historical receiver keys, retained states, forks or pending
      // proposals across this membership boundary.
      const fresh = structuredClone(state);
      fresh.historicalReceiverData.clear();
      fresh.unappliedProposals = {};
      staged = this.#createSession(
        fresh,
        { ...this.#options, retained: undefined, historyTree: undefined },
        stagedDatabase,
        this.#generation + 1,
      );
      await staged.hydrateLifecycleEvidence();
      await staged.save(true);
      const runtime = this.#createRuntime(staged, stagedDatabase);
      await runtime.hydratePublication();
      const record = await memory.group();
      const nodes = await memory.treeNodes.all!();
      const purge = await HistoryTree.stagePurge(groupTreeStore(this.database));
      if ((await this.database.group()).disbandTombstone)
        throw new GroupTerminalError();
      const oldRelays = this.relays ?? [];
      const serialized = serializeClientState(fresh);
      await options.beforeAdopt?.();
      if (previous.destroyed || this.closedSignal.aborted)
        throw new Error("Group closed");
      validate();
      await this.database.transaction(async (tx) => {
        const current = await tx.group();
        if (current.disbandTombstone) throw new GroupTerminalError();
        for (const tag of purge.deletes) await tx.treeNodes.delete(tag);
        for (const node of nodes) await tx.treeNodes.put(node);
        await tx.wrappers.deleteBelow(Number.MAX_SAFE_INTEGER);
        await ConvergenceEffectLedger.clear(tx);
        // Preserve rumor rows and non-secret delivery attribution, not replay
        // material that can be re-adopted by the discarded branch.
        for (const row of await tx.deliveries.withEvidence()) {
          const { evidence: _evidence, ...attribution } = row;
          await tx.deliveries.put(attribution);
        }
        const relays = tx.backfill.all
          ? (await tx.backfill.all()).map((row) => row.relay)
          : [...oldRelays, ...(staged!.groupData?.relays ?? [])];
        for (const relay of relays) await tx.backfill.delete(relay);
        await tx.updateGroup({
          state: serialized,
          adoptionIds: options.adoptionId
            ? [...new Set([...(current.adoptionIds ?? []), options.adoptionId])]
            : current.adoptionIds,
          checkpoint: record.checkpoint,
          registryState: null,
          removed: null,
          removal: null,
          disbandRequest: null,
          disbandConvergence: null,
          disbandTombstone: null,
          publication: null,
        });
        if (previous.destroyed || this.closedSignal.aborted)
          throw new Error("Group closed");
      });
      // No awaits between durable installation and publishing the new owner.
      committed = true;
      previousDatabase.revoke();
      stagedDatabase.activate(this.database);
      this.#session = staged;
      this.#sessionDatabase = stagedDatabase;
      this.#runtime = runtime;
      this.#generation++;
      this.#foundingWelcome = undefined;
      this.#removalRealizationInFlight = undefined;
      this.#rejectQueuedOutbound("Group rejoined; old outbound cancelled.");
      this.#stateRevision++;
      // Closing the facade can race the adapter's durable commit acknowledgement
      // after its callback returned. A committed replacement must inherit that
      // closure before it becomes available to any caller.
      if (this.closedSignal.aborted) {
        staged.beginDestroy();
        staged.dispose();
      }
      try {
        previous.beginDestroy();
        previous.dispose();
      } catch (error) {
        // The revoked database/callback capability is the authoritative fence;
        // optional scheduler/resource cleanup cannot undo durable adoption.
        this.log("retired session cleanup failed: %o", error);
      }
    } finally {
      this.#adopting = false;
      if (!committed) {
        stagedDatabase?.revoke();
        previousDatabase.resume();
        try {
          staged?.dispose();
        } catch (error) {
          this.log("staged session cleanup failed: %o", error);
        }
      }
      finishAdoption();
      this.#adoptionFinished = undefined;
    }
    if (this.closedSignal.aborted) return;
    // Observers cannot roll back an already committed cryptographic adoption.
    for (const notify of [
      () => this.image.retireRetained([this.state]),
      () => this.#refreshSnapshot(),
      () => this.emit("stateChanged", this.state),
      () => this.emit("historyChanged", this),
      () => this.emit("stateSaved", this),
    ]) {
      try {
        notify();
      } catch (error) {
        this.log("rejoin observer failed: %o", error);
      }
    }
  }

  /** Creates a new {@link MarmotGroup} instance from a {@link ClientState} object */
  static async fromClientState(
    state: ClientState,
    options: Omit<MarmotGroupOptions, "ciphersuite"> & {
      cryptoProvider?: CryptoProvider;
    },
  ): Promise<MarmotGroup> {
    const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
    const cipherSuite = await cryptoProvider.getCiphersuiteImpl(
      state.groupContext.cipherSuite,
    );

    const group = new MarmotGroup(state, {
      ...options,
      ciphersuite: cipherSuite,
    });
    try {
      await group.runtime.hydratePublication();
      return group;
    } catch (error) {
      group.dispose();
      throw error;
    }
  }

  /**
   * Realizes a persisted removal after the owning registry has attached its
   * forwarding listeners. This is idempotent across concurrent loads and
   * process restarts when a removal marker store is configured.
   */
  async realizeRemovalIfNeeded(): Promise<void> {
    await this.#realizeRemovalIfNeeded();
  }

  /** Consumes a durable at-most-once callback attempt; projection is authority. */
  async realizeDisbandIfNeeded(): Promise<void> {
    const session = this.session;
    if (this.#adopting) return;
    if (this.closedSignal.aborted) return;
    if (this.session.terminalTombstone)
      for (const result of await session.driveConvergence()) {
        if (!this.#isCurrent(session)) return;
        await this.#applyRemovalWithdrawal(result);
        if (!this.#isCurrent(session)) return;
        this.emit("ingestResult", result);
      }
    const tombstone = await session.markDisbandNotificationDelivered();
    if (!this.#isCurrent(session)) return;
    if (!tombstone) return;
    this.#closeController.abort();
    this.image.close();
    this.#rejectQueuedOutbound(new GroupTerminalError());
    this.#emitDisbandedSafely(tombstone);
  }

  #emitDisbandedSafely(tombstone: DisbandTombstone): void {
    const evidence: GroupDisbandedEvent = {
      actorPubkey: tombstone.actorPubkey,
      commitDigest: tombstone.commitDigest,
    };
    for (const listener of [...this.#disbandedListeners]) {
      if (listener.once) this.off("disbanded", listener.fn, undefined, true);
      try {
        listener.fn.call(listener.context, this, evidence);
      } catch (error) {
        this.log("disbanded listener failed: %o", error);
      }
    }
  }

  #assertNotDisbanded(): void {
    if (this.#adopting) throw new Error("Group rejoin in progress");
    // Destruction remains the strongest fence; retained terminal facades keep
    // their typed disband error even after releasing in-memory resources.
    if (this.session.destroyed) this.session.assertOpen();
    if (this.session.terminalTombstone) throw new GroupTerminalError();
    if (this.closedSignal.aborted) throw new Error("Group unloaded");
    this.session.assertOpen();
  }

  #isCurrent(session: GroupSession): boolean {
    return session === this.session && !this.#adopting;
  }

  #assertCurrent(session: GroupSession): void {
    if (!this.#isCurrent(session))
      throw new Error("Group session was replaced or is rejoining");
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
    const session = this.session;
    if (this.#adopting) throw new Error("Group rejoin in progress");
    await session.save(force);
    if (!this.#isCurrent(session)) return;
    // The canonical media view omits selectable sibling and exactly pinned
    // branches. Load the actual tree membership before releasing owned images.
    // Cache cleanup is optional: failed or changing captures defer retirement
    // without turning an already successful durable save into a failure.
    if (this.closedSignal.aborted || this.session.destroyed) return;
    const tags = this.forkTree.tags();
    try {
      const states = await Promise.all(
        tags.map((tag) => this.forkTree.stateAt(tag)),
      );
      if (!this.#isCurrent(session)) return;
      if (
        states.some((state) => !state) ||
        tags.join() !== this.forkTree.tags().join()
      )
        return;
      this.image.retireRetained(states as ClientState[]);
    } catch {
      // Retry on a later successful save; never infer absence from read failure.
    }
  }

  /**
   * Re-scores the persisted fork history against the current tip and switches to
   * the canonical branch if a competing fork now wins (`convergence.md`),
   * persisting a resulting switch. Candidates come from the {@link forkTree}, so a
   * client that diverged onto a losing fork converges from disk without waiting
   * for the network to re-deliver the winning branch. Called automatically on
   * load; safe to call explicitly to force a re-evaluation.
   *
   * CR-06: the pass's results are routed through the SAME marker-clearing
   * branch {@link ingest} uses, so a load-time rewind that supersedes the
   * commit which removed us clears the persisted removed-inactive marker.
   * Previously every result here was discarded, so the documented "called
   * automatically on load" path could never clear it and a client restored to
   * membership kept a stale marker that silently suppressed its next genuine
   * removal.
   */
  async reconverge(): Promise<void> {
    if (this.session.destroyed) return;
    this.#assertNotDisbanded();
    const session = this.session;
    const results = await session.reconverge();
    if (!this.#isCurrent(session)) return;
    for (const result of results) {
      if (!this.#isCurrent(session)) return;
      await this.#applyRemovalWithdrawal(result);
      if (!this.#isCurrent(session)) return;
      this.emit("ingestResult", result);
    }
    // A tree-fed switch can also land us ON a branch that removes us. The
    // realization obligation is state-derived (D-12), so re-assert it here;
    // idempotent, and a no-op unless canonical state is now the tombstone.
    // WR-16: `ingest()` runs this identical trailing step, so neither rewind
    // path can drift from the other.
    await this.#realizeRemovalIfNeeded();
    this.#refreshSnapshot();
  }

  /**
   * Performs a self-update commit (no proposals) to rotate this member's leaf key material.
   *
   * This is required by `refs/marmot/protocol-core/joining.md` for forward
   * secrecy after joining from a Welcome.
   *
   * Unlike admin commits (see {@link GroupsManager.commit}), this operation is
   * allowed for non-admin members.
   */
  async selfUpdate(): Promise<Record<string, PublishResponse>> {
    this.#assertNotDisbanded();
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
    this.#assertNotDisbanded();
    const session = this.session;
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
    this.#assertCurrent(session);

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
    this.#assertNotDisbanded();
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
    this.#assertNotDisbanded();
    const session = this.session;
    const runtime = this.runtime;
    await runtime.retryPendingPublication();
    this.#assertCurrent(session);
    await session.hydrateLifecycleEvidence();
    this.#assertCurrent(session);
    if (this.session.removalBlocked)
      throw new Error("Group removed or removal recovery pending");
    // Snapshot immutable expected-parent evidence before a convergence wait.
    intent = { ...intent };
    const signal = intent.kind === "commit" ? intent.signal : undefined;
    signal?.throwIfAborted();
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
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const item = {
        intent,
        resolve: (results: GroupPublishResult[]) => {
          cleanup();
          resolve(results);
        },
        reject: (error: unknown) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => {
        const index = this.#outboundQueue.indexOf(item);
        if (index < 0) return; // Preparation owns cancellation after dequeue.
        this.#outboundQueue.splice(index, 1);
        item.reject(signal!.reason);
      };
      this.#outboundQueue.push(item);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  /** Retry a retained commit after an uncertain relay result, without regenerating it. */
  retryPendingPublication(): Promise<GroupPublishResult[]> {
    this.#assertNotDisbanded();
    return this.runtime.retryPendingPublication();
  }

  /** Atomically enables lifecycle-v1 for a legacy group and publishes it once. */
  async enableDisbanding(): Promise<EnableDisbandingResult> {
    this.#assertNotDisbanded();
    const session = this.session;
    const runtime = this.runtime;
    let effects;
    try {
      effects = await session.enableGroupDisbanding();
      this.#assertCurrent(session);
    } catch (error) {
      const message = errorMessage(error);
      const reason =
        /not all members support|required capabilities|does not advertise lifecycle support/i.test(
          message,
        )
          ? "unsupportedMembers"
          : /only an active group admin/i.test(message)
            ? "notAdmin"
            : "legality";
      return { kind: "rejected", reason, error: message };
    }
    if (effects.publish.length === 0) return { kind: "alreadyEnabled" };
    try {
      const [publication] = await runtime.publishEffects(effects);
      if (!publication)
        return {
          kind: "rejected",
          reason: "legality",
          error: "Lifecycle enablement produced no publication result",
        };
      return { kind: "enabled", publication };
    } catch (error) {
      return { kind: "publishFailed", error: errorMessage(error) };
    }
  }

  /** Persists irreversible intent, publishes one candidate, and retains it until selection. */
  async disband(): Promise<DisbandResult> {
    this.#assertNotDisbanded();
    const session = this.session;
    const runtime = this.runtime;
    const existing = await session.disbandRequest();
    this.#assertCurrent(session);
    if (existing?.status === "failed")
      return { kind: "failed", reason: existing.reason };
    let effects;
    try {
      effects = await session.requestDisband();
      this.#assertCurrent(session);
    } catch (error) {
      const message = errorMessage(error);
      return {
        kind: "rejected",
        reason: /not enabled/i.test(message) ? "notEnabled" : "legality",
        error: message,
      };
    }
    const request = await session.disbandRequest();
    this.#assertCurrent(session);
    if (request?.status === "failed")
      return { kind: "failed", reason: request.reason };
    if (!request)
      return {
        kind: "rejected",
        reason: "legality",
        error: "Disband request was not persisted",
      };
    if (effects.publish.length === 0) return { kind: "pending", request };
    try {
      const [publication] = await runtime.publishEffects(effects);
      if (!publication) return { kind: "pending", request };
      return { kind: "acknowledged", request, publication };
    } catch (error) {
      return { kind: "publishFailed", request, error: errorMessage(error) };
    }
  }

  /** Builds + publishes an intent's effects immediately (no gating). */
  async #sendNow(
    intent: GroupSessionSendIntent,
  ): Promise<GroupPublishResult[]> {
    const session = this.session;
    const runtime = this.runtime;
    const signal = intent.kind === "commit" ? intent.signal : undefined;
    signal?.throwIfAborted();
    return new Promise<GroupPublishResult[]>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      const cleanup = () => signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      // Observe late preparation while releasing its caller/FIFO promptly.
      // Start publication in the same continuation that acquires the effects,
      // leaving no orphan staged commit between cancellation and runtime handoff.
      void session.send(intent).then(
        (effects) => {
          cleanup();
          if (!this.#isCurrent(session)) {
            reject(new Error("Group session replaced"));
            return;
          }
          if (signal?.aborted) {
            for (const work of effects.publish)
              if ("pending" in work) session.publishFailed(work.pending);
            reject(signal.reason);
            return;
          }
          resolve(runtime.publishEffects(effects));
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
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

  /** Gives one pre-existing state intent a preparation attempt, then resumes inbound. */
  async #settleAndDrive(): Promise<void> {
    if (this.#adopting) return;
    const session = this.session;
    const settledQueueLength = this.#outboundQueue.length;
    const fairIndex = selectFairQueuedStateIntent(
      this.#outboundQueue,
      settledQueueLength,
    );
    if (
      fairIndex !== undefined &&
      mayReleaseOutbound(this.session.convergenceStatus, this.lifecycle)
    ) {
      const [item] = this.#outboundQueue.splice(fairIndex, 1);
      try {
        item!.resolve(await this.#sendNow(item!.intent));
      } catch (error) {
        // The attempt is consumed even when authorization/signing/preparation
        // fails; reject its caller and continue rather than pinning liveness.
        item!.reject(error);
      }
    }

    if (!this.#isCurrent(session)) return;
    const resumed = await session.driveConvergence();
    if (!this.#isCurrent(session)) return;
    for (const result of resumed) {
      if (!this.#isCurrent(session)) return;
      await this.#applyRemovalWithdrawal(result);
      if (!this.#isCurrent(session)) return;
      if (result.kind === "removed") await this.#realizeRemovalIfNeeded();
      this.emit("ingestResult", result);
    }
    await this.realizeDisbandIfNeeded();
    if (!this.#isCurrent(session)) return;
    // CR-04: routed through the single resume seam rather than repeating its
    // predicate, so the profile gate (D-12) and the already-disbanded check
    // cannot be present on one resume path and missing on the other.
    await this.resumePendingDisband();
    if (!this.#isCurrent(session)) return;
    // Drain even when retained input was resumed (#109): `#drainOutbound`
    // re-checks the release gate, so it is a no-op if that input reopened the
    // window (which arms a fresh settle check). Resumed input that is not
    // convergence-relevant arms nothing, so this wake is the last chance.
    await this.#drainOutbound();
    this.#refreshSnapshot();
  }

  /**
   * Resumes a durable terminal intent after hydration when preparation is
   * eligible. Also the single seam `#settleAndDrive` uses to resume a pending
   * request mid-session, so both resume paths share one predicate.
   */
  async resumePendingDisband(): Promise<void> {
    if (this.#adopting) return;
    const session = this.session;
    if (this.session.removalBlocked) return;
    if (this.session.destroyed) return;
    // D-12: nothing is published automatically for a group outside the current
    // account identity proof profile. `MarmotGroupEngine.requestDisband` now
    // refuses such a group itself (CR-04), before it persists or prepares
    // anything; this early return keeps the refusal from surfacing to callers
    // as a `rejected` DisbandResult for work they never asked for.
    if (this.profileSupport.kind === "unsupported") return;
    if (
      this.status !== "disbanded" &&
      this.lifecycle === groupLifecycleStates.stable &&
      (await session.disbandRequest())?.status === "pending" &&
      this.#isCurrent(session)
    )
      await this.disband();
  }

  /** Rejects and clears every queued outbound intent (teardown / removal). */
  #rejectQueuedOutbound(reason: string | Error): void {
    if (this.#outboundQueue.length === 0) return;
    const error = typeof reason === "string" ? new Error(reason) : reason;
    for (const item of this.#outboundQueue.splice(0)) item.reject(error);
  }

  /**
   * Realizes involuntary removal as a state-derived obligation, not a
   * one-shot side effect of applying one commit (D-12,
   * `protocol-core/member-departure.md` "Realizing removal"): whenever
   * canonical state is the `removedFromGroup` tombstone AND realization has
   * not already happened (the marker is unset), sets the marker, fails any
   * queued outbound, and emits `removed` — exactly once. A no-op when state
   * is not the tombstone, and a no-op (no re-emit) when the marker is
   * already set.
   *
   * Called through {@link realizeRemovalIfNeeded} after registry listeners are
   * attached on load, and by the `ingest` handler's `result.kind === "removed"`
   * branch (the commit that produces the tombstone in a live process). Both
   * funnel through this single idempotent implementation.
   */
  async #realizeRemovalIfNeeded(): Promise<void> {
    if (this.#removalRealizationInFlight)
      return this.#removalRealizationInFlight;

    const realization = this.#performRemovalRealization();
    this.#removalRealizationInFlight = realization;
    try {
      await realization;
    } finally {
      if (this.#removalRealizationInFlight === realization)
        this.#removalRealizationInFlight = undefined;
    }
  }

  async #performRemovalRealization(): Promise<void> {
    if (this.#adopting) return;
    const session = this.session;
    if (this.session.terminalTombstone) return;
    if (this.state.groupActiveState.kind !== "removedFromGroup") return;

    const alreadyRealized = (await session.records.get()).removed;
    if (!this.#isCurrent(session)) return;
    if (alreadyRealized === true) return;
    await session.records.update({ removed: true });
    if (!this.#isCurrent(session)) return;
    await session.markRemovalNotificationDelivered();
    if (!this.#isCurrent(session)) return;

    this.#rejectQueuedOutbound("Removed from group; outbound cancelled.");
    this.#emitRemovedSafely();
  }

  /** Delivers the public removal signal without making callbacks transactional. */
  #emitRemovedSafely(): void {
    for (const listener of [...this.#removedListeners]) {
      // EventEmitter3 removes one-shot listeners before invoking them.
      if (listener.once) this.off("removed", listener.fn, undefined, true);
      try {
        listener.fn.call(listener.context, this);
      } catch (error) {
        this.log("removed listener failed: %o", error);
      }
    }
  }

  /**
   * ingests an array of group messages and applies commits to the group state.
   *
   * Processing happens in two stages:
   * 1. Process all non-commit messages (proposals, application messages)
   *    - If a message fails to process, it's added to unreadable for retry
   * 2. Process commits according to `refs/marmot/protocol-core/group-messaging.md`
   *    (sorted by epoch, timestamp, event id)
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
    this.#ingestions++;
    try {
      if (this.#adopting) throw new Error("Group rejoin in progress");
      const session = this.session;
      const runtime = this.runtime;
      await runtime.hydratePublication();
      if (!this.#isCurrent(session)) return;
      // The fork-history tree can grow during ingest (new commits / forks) without
      // the canonical state changing — track its size to emit `historyChanged`.
      const historySizeBefore = this.session.historyTree.size;
      for await (const result of session.ingest(events, options)) {
        if (!this.#isCurrent(session)) return;
        // The engine elected us to commit a peer's departure (B6): publish the
        // staged self_remove-only commit (publish-before-apply). On publish
        // failure the staged commit is rolled back and the self_remove stays
        // pending, so a later ingest re-elects and retries — swallow the throw so
        // it does not abort delivery of the rest of the batch.
        if (result.kind === "autoCommit") {
          let applied: AppliedNotificationsIngestResult | undefined;
          try {
            const [confirmed] = await runtime.publishEffects({
              publish: [
                {
                  kind: "groupEvolution",
                  envelope: result.event,
                  pending: result.pending,
                  actorPubkey: result.actorPubkey,
                },
              ],
            });
            if (!result.pending.commitMessage)
              throw new Error(
                "Auto-commit pending state has no commit message",
              );
            applied = {
              kind: "appliedNotifications" as const,
              commitDigest: commitDigest(
                encode(mlsMessageEncoder, result.pending.commitMessage),
              ),
              notifications: confirmed!.notifications,
            };
          } catch {
            /* rolled back; retried on a later ingest */
          }
          if (!this.#isCurrent(session)) return;
          this.emit("ingestResult", result);
          yield result;
          if (applied) {
            const reconciled = {
              ...applied,
              disposition: ingestResultDisposition(applied),
            };
            this.emit("ingestResult", reconciled);
            yield reconciled;
          }
          continue;
        }

        // An inbound commit removed us (involuntary Remove, or a peer committing
        // our own self_remove). The session has already applied + persisted the
        // `removedFromGroup` tombstone; surface it so the app can react. Per the
        // chosen policy we keep the tombstone rather than auto-destroying — the
        // app calls destroy() when it wants to purge. Realization (marker +
        // reject-queued-outbound + `removed` emit) is the single idempotent
        // `#realizeRemovalIfNeeded` (D-12), shared with the `fromClientState`
        // load-time path so the two can never diverge.
        if (result.kind === "removed") {
          this.log("removed from group by inbound commit");
          // CR-05: persist the tombstone BEFORE the marker is written. The
          // session only reaches its own trailing `save()` after this generator
          // is fully drained, so writing the marker first leaves a window —
          // a throwing `removed` listener, a consumer that `break`s out of the
          // `for await`, a process exit, or a rejected `save()` — in which the
          // marker says "already realized" while the persisted `ClientState` is
          // NOT the tombstone. On the next load `#realizeRemovalIfNeeded`
          // returns early (state is not the tombstone), and when the removing
          // commit is re-ingested it returns early again (marker set), so the
          // `removed` event is never emitted and queued outbound is never
          // rejected — the permanent silent suppression the marker exists to
          // prevent.
          //
          // Forced, because the removal may have arrived on a path that left
          // `#dirty` false. If it rejects, the marker is never written and the
          // removal simply realizes on the next load — the safe direction.
          await this.save(true);
          if (!this.#isCurrent(session)) return;
          await this.#realizeRemovalIfNeeded();
        }

        if (result.kind === "processed" && result.selectedTerminal)
          await this.realizeDisbandIfNeeded();

        await this.#applyRemovalWithdrawal(result);
        if (!this.#isCurrent(session)) return;
        this.emit("ingestResult", result);
        yield result;
      }

      // WR-16: same trailing re-assert as `reconverge()`, so the live and
      // load-time rewind paths run an identical sequence (per-result
      // withdrawal handling, then a state-derived realization check). A rewind
      // during ingest can land us ON a branch that removes us without producing
      // a `removed` result, and the realization obligation is state-derived
      // (D-12). Idempotent: a no-op unless canonical state is the tombstone and
      // realization has not happened yet.
      if (!this.#isCurrent(session)) return;
      await this.#realizeRemovalIfNeeded();
      if (!this.#isCurrent(session)) return;
      // WR-01: the same state-derived re-assert for a selected disband that
      // reached no `processed` result (the session persisted it from engine
      // state). Idempotent: a no-op unless a tombstone awaits notification.
      await this.realizeDisbandIfNeeded();
      if (!this.#isCurrent(session)) return;

      this.#refreshSnapshot();
      if (this.session.historyTree.size !== historySizeBefore)
        this.emit("historyChanged", this);
    } finally {
      this.#ingestions--;
    }
  }

  /**
   * CONV-03 (D-12): a rewind superseded the commit that removed us — canonical
   * membership is live again, so the persisted removed-inactive marker must be
   * cleared, or a later genuine removal would be silently suppressed by the
   * stale marker. This rides the same `stateInvalidated` result stream as the
   * withdrawal itself; no separate event is emitted (re-emission of state
   * notifications is deferred).
   *
   * Shared by {@link ingest} and {@link reconverge} so the live and load-time
   * rewind paths can never diverge (CR-06).
   */
  async #applyRemovalWithdrawal(result: DispositionedIngestResult) {
    if (
      result.kind !== "stateInvalidated" ||
      !result.withdrawn.some((n) => n.kind === "selfRemoved")
    )
      return;

    // WR-16: a withdrawn `selfRemoved` means the commit that removed us was
    // superseded — NOT necessarily that we are a member again. A rewind can
    // supersede removal-commit A and land on branch B which ALSO removes us.
    // Clearing unconditionally left `marker = false` while
    // `groupActiveState.kind === "removedFromGroup"`, with no re-emitted
    // `removed` — so the next load realized the removal all over again and
    // emitted a duplicate, violating the exactly-once contract from the other
    // side. Only clear once canonical state has actually left the tombstone.
    if (this.state.groupActiveState.kind === "removedFromGroup") {
      this.log(
        "rewind superseded one removal but canonical state is still removed — keeping the marker",
      );
      return;
    }

    await this.session.finishRemovalRecovery();
  }

  /**
   * Encrypts a media file for sharing in a group message (encrypted-media-v2).
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
   * 4. Preserve the returned `expectedParent` on the application send intent.
   */
  async encryptMedia(
    blob: Blob,
    metadata: EncryptMediaMetadata,
  ): Promise<{
    encrypted: Uint8Array;
    attachment: MediaAttachment;
    expectedParent: string;
  }> {
    return this.mediaService.encryptMedia(blob, metadata);
  }

  /**
   * Decrypts an encrypted-media-v2 attachment downloaded from a blob store.
   *
   * Pass the authenticated sourceParent from the processed message or
   * session.mediaSourceForRumor(). Omission selects the current state only.
   * Cached plaintext never bypasses ciphertext and metadata validation.
   */
  async decryptMedia(
    encrypted: Uint8Array,
    attachment: MediaAttachment,
    sourceParent?: string,
  ): Promise<DecryptedMedia> {
    return this.mediaService.decryptMedia(encrypted, attachment, sourceParent);
  }

  /**
   * Releases in-memory resources without touching persisted state (B5): cancels
   * the settle-check timer and fails any queued outbound. Call on unload so a
   * timer/promise does not outlive the cached instance.
   */
  dispose() {
    if (this.#watchController.signal.aborted) return;
    this.#watchController.abort();
    this.#closeController.abort();
    this.image.close();
    this.session.dispose();
    this.#rejectQueuedOutbound("Group unloaded; outbound cancelled.");
    this.emit("disposed", this);
  }

  /** Destroys the group and purges the group history */
  async destroy() {
    // Close admission immediately, but let an adapter acknowledge its in-flight
    // replacement before choosing the session/database owner to destroy.
    const adoption = this.#adoptionFinished;
    if (adoption) {
      this.dispose();
      await adoption;
    }
    this.log("destroying group");
    this.image.close();
    this.session.beginDestroy();

    // Stop the settle timer and fail queued outbound before tearing down (B5).
    this.dispose();

    this.log("removing group from store");
    await this.session.destroyLocalState();

    this.emit("destroyed", this);
  }
}
