/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { Debugger } from "debug";
import {
  appDataUpdateProposalType,
  CiphersuiteImpl,
  ClientState,
  contentTypes,
  createApplicationMessage,
  createCommit,
  CreateCommitOptions,
  createProposal,
  defaultProposalTypes,
  encode,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  isSelfRemoveProposal,
  acceptAll,
  type LeafIndex,
  type MlsFramedMessage,
  type MlsMessage,
  mlsMessageEncoder,
  nodeTypes,
  processMessage,
  type ProcessMessageResult,
  Proposal,
  proposalOrRefTypes,
  type ProposalWithSender,
  wireformats,
} from "ts-mls";

import { marmotAuthService } from "../core/auth-service.js";
import { getMarmotGroupView } from "../core/client-state.js";
import { decideCommitAuthorization } from "../core/commit-authorization.js";
import { encodeAdminPolicyV1 } from "../core/components/admin-policy.js";
import {
  type CommitIntegrityViolation,
  validateCommitLegality,
} from "../core/components/integrity.js";
import { GROUP_ADMIN_POLICY_COMPONENT_ID } from "../core/components/ids.js";
import { getCredentialPubkey } from "../core/credential.js";
import {
  getGroupMemberPubkeys,
  getPubkeyLeafNodeIndexes,
} from "../core/group-members.js";
import { decideAutoCommit } from "./auto-committer.js";
import {
  type ConvergenceStatus,
  deriveConvergenceStatus,
} from "../core/convergence-status.js";
import {
  type AppWitness,
  type BranchCandidate,
  commitDigest,
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
  isWitnessEligible,
  selectCanonicalBranch,
  validateConvergencePolicy,
} from "../core/convergence.js";
import {
  canTransitionLifecycle,
  type GroupLifecycleState,
  groupLifecycleStates,
  mayPrepareLocalCommit,
  transitionLifecycle,
} from "../core/group-lifecycle.js";
import {
  auditEpochStateName,
  createAuditEmitter,
  digestString,
  errorDetail,
  messageArtifactKindFromNostrKind,
  type AuditContextOptions,
  type AuditEmitter,
  type AuditEventKind,
  type AuditSink,
  type AuditTransportWireEnvelope,
} from "../audit/index.js";
import { framedContentType } from "./wire-format.js";
import { logger } from "../utils/debug.js";
import { createAdminCommitPolicyCallback } from "./admin-policy.js";
import { DeliveredPayloadLedger } from "./delivered-payloads.js";
import {
  type ChainLink,
  collectWitnessesAt,
  ForkRecovery,
  resolveCandidateParent,
  type ForkResolution,
} from "./fork-recovery.js";
import { GroupHistoryTree } from "./history-tree.js";
import { buildTreeBranchSet, type TreeBranchSet } from "./tree-convergence.js";
import { IngestionPool, type IngestionPoolOptions } from "./ingestion-pool.js";
import { contentDedupId } from "./message-dedup.js";
import {
  deriveStateNotifications,
  groupWithdrawnNotificationsByCommit,
  type StateNotification,
  StateNotificationLedger,
} from "./state-notifications.js";
import {
  type AppliedForkResolution,
  type IngestContext,
  ingestEnvelopes,
  isAuthenticApplicationMessage,
} from "./ingest.js";
import { ingestResultDisposition } from "./ingest-disposition.js";
import { RetainedHistoryStore } from "./retained-store.js";
import type {
  CommitOrderingPriority,
  OwnCommitConvergenceStamp,
} from "./own-commit-stamp.js";
import type {
  AutoCommitIngestResult,
  DispositionedIngestResult,
  GroupPeeler,
  IngestResult,
  PendingState,
  ProposalContext,
  SendIntent,
  SendResult,
} from "./types.js";

/**
 * Thrown by {@link MarmotGroupEngine.send} (`case "commit"`) when a removal
 * commit's auto-coupled admin-policy update would leave the resulting epoch
 * with no surviving admin account (D-07). Thrown BEFORE `createCommit` — no
 * proposal is staged and the lifecycle stays `Stable`. The message names only
 * the count of admins that would be orphaned, never pubkeys
 * (diagnostics-privacy rule, `foundation/errors.md`).
 *
 * @see refs/mdk/crates/cgka-engine/src/message_processor/send.rs `do_send_remove_members` `AdminDepletion` guard
 */
export class AdminDepletionError extends Error {
  constructor(orphanedAdminCount: number) {
    super(
      `This commit would remove the last member leaf of ${orphanedAdminCount} admin account(s), leaving the group with no admin. Refused before staging.`,
    );
    this.name = "AdminDepletionError";
  }
}

/**
 * Thrown when a locally-staged commit violates a Marmot component-integrity
 * rule. The structured violation is retained so callers can branch on its
 * stable reason without matching the human-readable diagnostic message.
 */
export class CommitLegalityError extends Error {
  constructor(readonly violation: CommitIntegrityViolation) {
    super(violation.detail);
    this.name = "CommitLegalityError";
  }
}

/** An opaque handle returned by {@link ConvergenceScheduler.setTimer}. */
export type TimerHandle = unknown;

/**
 * Injectable timer used to fire the convergence settle-check once the quiescence
 * window elapses (B5). Defaults to `setTimeout`/`clearTimeout`; tests pass a
 * controllable fake so the settle moment is deterministic.
 */
export interface ConvergenceScheduler {
  setTimer(ms: number, cb: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

const DEFAULT_SCHEDULER: ConvergenceScheduler = {
  setTimer: (ms, cb) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type MarmotGroupEngineOptions<TEnvelope> = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  peeler: GroupPeeler<TEnvelope>;
  onStateChanged?: (state: ClientState) => void;
  /**
   * The bounded convergence window (canonical states + applied commits within
   * the rollback horizon), derived from the history tree on load. When omitted
   * it is seeded with only the current tip (no past-epoch rewind until new
   * commits accrue). Never persisted separately — the tree is the source.
   */
  retained?: RetainedHistoryStore;
  /**
   * A pre-populated full-fork history tree, rehydrated from persistence. When
   * omitted the tree is seeded with the current tip as its root and grows as
   * commits arrive.
   */
  historyTree?: GroupHistoryTree;
  /**
   * The signed convergence policy governing branch selection and the rollback
   * horizon (`maxRewindCommits`). Defaults to {@link DEFAULT_CONVERGENCE_POLICY}.
   * Set `maxRewindCommits` to `Infinity` to never expire old forks (the full
   * history tree retains everything regardless). Validated on construction.
   */
  convergencePolicy?: ConvergencePolicy;
  /**
   * Tuning for the persistent ingestion pool — undecryptable events held and
   * retried as the history tree grows, instead of being dropped. Defaults to a
   * size- and epoch-age-bounded pool.
   */
  ingestionPool?: IngestionPoolOptions;
  /**
   * Injectable wall-clock (ms) for the convergence-status quiescence window
   * (B5). Defaults to `Date.now`; tests pass a fake clock for determinism.
   */
  now?: () => number;
  /**
   * Quiescence window (ms) before a convergence pass may be treated as settled
   * (`convergence.md` `settlementQuiescenceMs`). Defaults to the profile-1 value.
   */
  settlementQuiescenceMs?: number;
  /** Injectable timer for the settle-check; defaults to `setTimeout` (B5). */
  scheduler?: ConvergenceScheduler;
  /**
   * Called once the quiescence window elapses after convergence-relevant input,
   * so the owner can re-check {@link convergenceStatus} and release any queued
   * outbound work (B5). The engine itself holds no outbound queue.
   */
  onSettleCheck?: () => void | Promise<void>;
  /** Optional forensic audit sink. Omitted by default; audit logging is app opt-in. */
  audit?: AuditSink;
  /** Required when `audit` is set; contains stable engine/account/session metadata. */
  auditContext?: AuditContextOptions;
};

/**
 * Transport-agnostic MLS group state machine: ingest, send intents, fork
 * recovery, and publish-before-apply lifecycle for local commits.
 *
 * This class is a coordinator. The heavy concerns live in focused modules it
 * composes: retained history ({@link RetainedHistoryStore}), convergence fork
 * recovery ({@link ForkRecovery}), and the inbound pipeline ({@link
 * ingestEnvelopes}). The engine owns only the live state and lifecycle, the
 * send path, and the wiring between those modules — mirroring darkmatter's
 * `cgka-engine` split across `message_processor/{ingest,send,store}`,
 * `fork_recovery`, and `epoch_manager`.
 */
export class MarmotGroupEngine<TEnvelope> {
  readonly ciphersuite: CiphersuiteImpl;
  readonly peeler: GroupPeeler<TEnvelope>;

  #state: ClientState;
  /** Group lifecycle state (group-state.md); only `Stable` may prepare a commit. */
  #lifecycle: GroupLifecycleState = groupLifecycleStates.stable;
  /**
   * Source (parent) epoch of a staged local commit awaiting publish
   * confirmation. Set on entering `PendingPublish`, cleared once the commit
   * merges or its publish is abandoned. Pinned against retained-history pruning
   * while set, so an unrelated inbound commit advancing the tip cannot drop the
   * state needed to apply the staged commit on confirmation (`retained-history.md`
   * "Pruning").
   */
  #stagedCommitParentEpoch: number | undefined;

  /** Retained canonical states + applied commits for fork recovery. */
  readonly #retained: RetainedHistoryStore;
  /** Full-fork history tree: every observed state (canonical + every fork). */
  readonly #tree: GroupHistoryTree;
  /** The active convergence policy (branch selection + rollback horizon). */
  readonly #policy: ConvergencePolicy;
  /** Undecryptable events held for retry as the tree grows (cross-batch). */
  readonly #pool: IngestionPool<TEnvelope>;
  /** Convergence candidate-branch construction and selection. */
  readonly #forkRecovery: ForkRecovery<TEnvelope>;
  /** App payloads delivered eagerly, retracted as `invalidated` on rewind (M7). */
  readonly #delivered = new DeliveredPayloadLedger<TEnvelope>();
  /**
   * Group-state-change notifications derived from accepted commits, keyed by
   * commit digest, withdrawn on rewind supersession (D-10/D-11, CONV-03).
   * Structural sibling of {@link #delivered}.
   */
  readonly #stateNotifications = new StateNotificationLedger();

  /**
   * Content ids of inbound messages already terminally processed — replay dedup
   * (`inbound-processing.md`; reference `seen_message_ids`). Process-lifetime,
   * in-memory; an already-applied commit also re-dedups via epoch/canonical
   * state, so this primarily gives a clean `duplicate` disposition for re-wrapped
   * replays and stops a duplicate application message from re-delivering.
   */
  readonly #seenContentIds = new Set<string>();
  /**
   * Content ids of our own sends, so an echo re-wrapped in a fresh transport
   * envelope (new event id) is still recognized as our own (reference
   * `sent_message_ids`). The session also strips own echoes by outer event id
   * before ingest; this covers the re-wrapped case.
   */
  readonly #sentContentIds = new Set<string>();

  readonly #onStateChanged?: (state: ClientState) => void;

  /** Injectable wall-clock for the convergence quiescence window (B5). */
  readonly #now: () => number;
  /** Quiescence window (ms) before a convergence pass may be treated as settled. */
  readonly #settlementQuiescenceMs: number;
  /** Wall-clock (ms) of the most recent convergence-relevant inbound input. */
  #lastConvergenceRelevantInputMs = 0;
  /** Whether the last convergence pass left a non-proposal input undispositioned. */
  #lastPassUnresolved = false;
  /** Whether the last convergence pass hit a blocking (missing-anchor) error. */
  #lastPassBlocked = false;

  /** Injectable timer for the settle-check (B5). */
  readonly #scheduler: ConvergenceScheduler;
  /** Settle-window elapsed callback; re-checks status to release queued outbound. */
  readonly #onSettleCheck?: () => void | Promise<void>;
  /** Handle of the pending settle-check timer, if any (cleared/reset per pass). */
  #settleTimer: TimerHandle | undefined;
  readonly #audit?: AuditEmitter;

  constructor(options: MarmotGroupEngineOptions<TEnvelope>) {
    this.#state = options.state;
    this.ciphersuite = options.ciphersuite;
    this.peeler = options.peeler;
    this.#onStateChanged = options.onStateChanged;
    this.#now = options.now ?? (() => Date.now());
    this.#settlementQuiescenceMs =
      options.settlementQuiescenceMs ??
      DEFAULT_CONVERGENCE_POLICY.settlementQuiescenceMs;
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#onSettleCheck = options.onSettleCheck;

    this.#policy = options.convergencePolicy ?? DEFAULT_CONVERGENCE_POLICY;
    validateConvergencePolicy(this.#policy);
    this.#retained =
      options.retained ?? new RetainedHistoryStore(options.state, this.#policy);
    this.#tree = options.historyTree ?? new GroupHistoryTree(options.state);
    this.#forkRecovery = new ForkRecovery(
      options.ciphersuite,
      options.peeler,
      this.#policy,
    );
    this.#pool = new IngestionPool<TEnvelope>({
      maxRewindCommits: this.#policy.maxRewindCommits,
      ...options.ingestionPool,
    });
    this.#audit = createAuditEmitter(
      options.audit && options.auditContext
        ? { ...options.auditContext, sink: options.audit }
        : undefined,
    );
    this.#emitEngineContext();
    this.#emitGroupContext("engine_started");
  }

  /** Number of undecryptable events currently held in the ingestion pool. */
  get pendingCount(): number {
    return this.#pool.size;
  }

  /**
   * The undecryptable events currently held in the ingestion pool, oldest-first:
   * received transport envelopes that have not yet decrypted/processed into the
   * history tree (e.g. a newer-epoch message awaiting its commit, or a fork
   * message awaiting its branch). They are retried as the tree grows; an entry
   * that never clears is a received event the unlocking state never arrived for.
   */
  pendingEnvelopes(): TEnvelope[] {
    return this.#pool.envelopes();
  }

  /**
   * The full-fork history tree: every group state observed — the canonical
   * branch and every fork — keyed by MLS confirmation tag. Read-only structural
   * access; the engine grows it as commits and proposals arrive.
   */
  get history(): GroupHistoryTree {
    return this.#tree;
  }

  /**
   * The retained canonical states within the rollback horizon, newest epoch
   * first. Used for cross-epoch encrypted-media decryption: media is keyed by
   * its source-epoch exporter secret, which is not carried on the wire, so a
   * receiver tries each still-retained epoch's key. States older than
   * `max_rewind_commits` are pruned (`retained-history.md`); media from a pruned
   * epoch can no longer be decrypted.
   */
  retainedStates(): ClientState[] {
    return [...this.#retained.states()].sort(
      (a, b) => Number(b.groupContext.epoch) - Number(a.groupContext.epoch),
    );
  }

  /**
   * Records an applied commit into both retained history and the history tree.
   * The freshly-produced `newState` is captured pristine; a tree hiccup (e.g. a
   * parent not yet present) is logged and never breaks protocol processing.
   */
  #recordCommitNode(
    parentState: ClientState,
    message: Parameters<RetainedHistoryStore["record"]>[1],
    newState: ClientState,
    ownCommitStamp?: OwnCommitConvergenceStamp,
  ): void {
    this.#retained.record(
      parentState,
      message,
      newState,
      this.#pinnedEpochs(),
      ownCommitStamp,
    );
    try {
      const parentTag = bytesToHex(parentState.confirmationTag);
      if (!this.#tree.hasNode(parentTag)) this.#tree.setRoot(parentState);
      this.#tree.recordCommit(
        parentTag,
        message,
        newState,
        undefined,
        ownCommitStamp,
      );
    } catch (error) {
      this.#log()("history tree recordCommit failed: %o", error);
    }
  }

  /**
   * Refreshes the history-tree node snapshot for a state whose
   * `unappliedProposals` just changed, so the persisted snapshot reflects the
   * proposals staged against it.
   *
   * CR-08: this MUST run for our OWN staged proposals as well as inbound ones.
   * A tree node snapshot is captured when its commit is recorded and is never
   * refreshed by `recordCommit`, so a proposal staged afterwards was invisible
   * to the persisted tree. After a restart `GroupRegistry.#retainedFromTree`
   * rebuilds `RetainedHistoryStore` purely from those snapshots, leaving
   * `retained.stateAt(forkEpoch).unappliedProposals === {}` — so
   * `framedCommitProposals` could not resolve the `ProposalRef` of a commit
   * that bundled our own staged proposal by reference, the CONV-04
   * short-circuit fell through to replay, replaying our own commit threw
   * (RFC 9420: an `UpdatePath` never encrypts a path secret to the committer's
   * own leaf), and our own deeper canonical branch was dropped as a candidate
   * entirely — handing the rewind to a shallower competitor.
   */
  #recordProposalStaged(state: ClientState): void {
    try {
      const tag = bytesToHex(state.confirmationTag);
      if (this.#tree.hasNode(tag)) this.#tree.updateSnapshot(tag, state);
    } catch (error) {
      this.#log()("history tree recordProposalStaged failed: %o", error);
    }
  }

  /**
   * Epochs the active lifecycle still needs and that retained-history pruning
   * MUST NOT drop, even when older than the rollback horizon (`retained-history.md`
   * "Pruning"). Currently a staged local commit awaiting publish confirmation
   * pins its source epoch; `Recovering` and `Unrecoverable` replay/observe
   * synchronously and need no separate prune-time pin.
   */
  #pinnedEpochs(): number[] {
    return [
      ...this.#pool.sourceEpochs(),
      ...(this.#stagedCommitParentEpoch === undefined
        ? []
        : [this.#stagedCommitParentEpoch]),
    ];
  }

  /** Oldest epoch that retained history or the full-fork tree can still name. */
  #ledgerHorizon(): number | undefined {
    const anchor = this.#retained.anchorEpoch();
    const oldestTreeEpoch = this.#tree.oldestEpoch();
    if (anchor === undefined) return oldestTreeEpoch;
    if (oldestTreeEpoch === undefined) return anchor;
    return Math.min(anchor, oldestTreeEpoch);
  }

  get state(): ClientState {
    return this.#state;
  }

  set state(newState: ClientState) {
    this.#setState(newState);
  }

  /**
   * The group's lifecycle state (`group-state.md`). A new local commit may only
   * be prepared while `Stable`; the commit flow moves through `PendingPublish`
   * (commit prepared, publish unconfirmed) and `Merging` (publish acked, staged
   * commit applying) and back to `Stable`.
   */
  get lifecycle(): GroupLifecycleState {
    return this.#lifecycle;
  }

  /**
   * The derived convergence status (`group-state.md` §Convergence status, B5):
   * `Syncing` while the quiescence window since the last convergence-relevant
   * input has not elapsed, then `Resolving` / `Blocked` / `Settled` per the last
   * pass. Recomputed on every read against the injected clock, so it advances to
   * `Settled` as wall-clock time passes even with no new input.
   */
  get convergenceStatus(): ConvergenceStatus {
    return deriveConvergenceStatus({
      nowMs: this.#now(),
      lastConvergenceRelevantInputMs: this.#lastConvergenceRelevantInputMs,
      settlementQuiescenceMs: this.#settlementQuiescenceMs,
      hasUnresolvedInput: this.#lastPassUnresolved,
      hasBlockingError: this.#lastPassBlocked,
    });
  }

  /** Executes a local send intent and returns the wrapped transport envelope. */
  async send(intent: SendIntent): Promise<SendResult<TEnvelope>> {
    // D-14: once canonical state is the removedFromGroup tombstone, no
    // outbound intent may proceed — checked before the audit `send_entry`
    // emit and before #sendInner, mirroring the `mayPrepareLocalCommit` throw
    // style below. Canonical state is serialized/persisted, so this also
    // blocks a fresh `send()` on a freshly-constructed engine after a
    // restart, not just within the process that observed the removal.
    if (this.#state.groupActiveState.kind === "removedFromGroup") {
      throw new Error(
        "Cannot send: this client has been removed from the group.",
      );
    }
    const intentKind = auditSendIntentKind(intent);
    this.#emitAudit({ type: "send_entry", intent_kind: intentKind });
    try {
      const result = await this.#sendInner(intent);
      this.#emitAudit({
        type: "send_outcome",
        intent_kind: intentKind,
        result_kind: auditSendResultKind(result),
        outbound_messages: [
          {
            msg_id: this.peeler.idOf(result.envelope),
            artifact_kind: this.#artifactKind(result.envelope, result.kind),
            transport: this.#transportEnvelope(result.envelope),
          },
        ],
      });
      return result;
    } catch (error) {
      this.#emitAudit({
        type: "send_error",
        intent_kind: intentKind,
        error_kind: "engine_error",
        detail: errorDetail(error),
      });
      throw error;
    }
  }

  async #sendInner(intent: SendIntent): Promise<SendResult<TEnvelope>> {
    switch (intent.kind) {
      case "applicationMessage": {
        const { newState, message } = await createApplicationMessage({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          message: intent.payload,
        });

        const envelope = await this.peeler.wrapGroupMessage(
          message,
          this.state,
        );
        this.#sentContentIds.add(contentDedupId(message));
        this.#setState(newState);
        this.#delivered.record({
          epoch: Number(newState.groupContext.epoch),
          stateTag: bytesToHex(newState.confirmationTag),
          envelope,
          message,
          payload: intent.payload,
        });
        const horizon = this.#ledgerHorizon();
        if (horizon !== undefined) this.#delivered.pruneBelow(horizon);
        return { kind: "applicationMessage", envelope, newState };
      }

      case "proposal": {
        const { message, newState } = await createProposal({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          proposal: intent.proposal,
          // Handshake content is wired as MLS PublicMessage (see wire-format.ts).
          wireAsPublicMessage: true,
        });

        const envelope = await this.peeler.wrapGroupMessage(
          message,
          this.state,
        );
        this.#sentContentIds.add(contentDedupId(message));
        return {
          kind: "proposal",
          envelope,
          pending: { kind: "proposal", newState },
        };
      }

      case "commit": {
        const groupData = getMarmotGroupView(this.state);
        if (!groupData) {
          throw new Error("MarmotGroupData not found in ClientState.");
        }

        if (!mayPrepareLocalCommit(this.#lifecycle)) {
          throw new Error(
            `Cannot prepare a commit while the group is ${this.#lifecycle}`,
          );
        }

        const context: ProposalContext = {
          state: this.state,
          ciphersuite: this.ciphersuite,
          groupData,
        };

        const newProposals: Proposal[] = [];
        if (intent.extraProposals && intent.extraProposals.length > 0) {
          for (const item of intent.extraProposals.flat()) {
            if (typeof item === "function") {
              newProposals.push(await item(context));
            } else {
              newProposals.push(item);
            }
          }
        }

        if (intent.proposalRefs) {
          for (const ref of intent.proposalRefs) {
            const proposalWithSender = this.state.unappliedProposals[ref];
            if (!proposalWithSender) {
              throw new Error(
                `Proposal reference not found in unappliedProposals: ${ref}`,
              );
            }
          }
        }

        const prepared = this.#prepareOutboundCommitProposals(
          this.state,
          groupData.adminPubkeys,
          newProposals,
        );

        const commitOptions: CreateCommitOptions = {
          // Handshake content is wired as MLS PublicMessage (see wire-format.ts).
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
        };

        if (prepared.extraProposals.length > 0) {
          commitOptions.extraProposals = prepared.extraProposals;
        }

        const parentState = this.state;
        const { commit, newState, welcome } = await createCommit({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
          },
          state: this.state,
          ...commitOptions,
        });

        // D-01/D-02: validate the staged commit before it is wrapped or
        // published, and before the lifecycle transitions to PendingPublish.
        // The throw happens before the lifecycle transition below, so the
        // engine is left in Stable with no pending state and no staged commit
        // to roll back.
        this.#assertStagedCommitLegal(
          parentState,
          newState,
          prepared.committedProposals,
        );

        const envelope = await this.peeler.wrapGroupMessage(commit, this.state);

        this.#transitionLifecycle(
          groupLifecycleStates.pendingPublish,
          "begin_pending",
          "commit",
        );
        this.#stagedCommitParentEpoch = Number(parentState.groupContext.epoch);
        this.#sentContentIds.add(contentDedupId(commit));

        return {
          kind: "groupEvolution",
          envelope,
          welcome,
          pending: {
            kind: "commit",
            newState,
            parentState,
            commitMessage: commit,
            ownCommitStamp: this.#ownCommitStamp(commit, prepared),
          },
        };
      }

      case "selfUpdate": {
        const parentState = this.state;

        // WR-17: a selfUpdate IS a commit — it advances the epoch and produces
        // a new confirmation tag — so it runs the same lifecycle gate as
        // `case "commit"`. Without it, a selfUpdate issued while another commit
        // is staged in PendingPublish builds a second commit off the same
        // parent and whichever `confirmPublished` lands second silently
        // overwrites the other's state, forking the group against itself.
        if (!mayPrepareLocalCommit(this.#lifecycle)) {
          throw new Error(
            `Cannot prepare a commit while the group is ${this.#lifecycle}`,
          );
        }

        // CR-03: `extraProposals: []` does NOT make this a proposal-free
        // commit. `createCommit` bundles every entry of
        // `state.unappliedProposals` by reference in addition to
        // `extraProposals`, so a selfUpdate can carry a peer's Remove that
        // de-leafs the last admin account, or an AppDataUpdate rewriting the
        // dictionary. This seam therefore runs the SAME D-05 auto-coupling
        // splice, D-07 depletion guard, and D-01/D-02 legality check as
        // `case "commit"` — otherwise the engine would wrap and publish a
        // commit that its own inbound seam (`ingest.ts`) and every conformant
        // peer reject (the mdk#707 "guard on one seam only" bug class).
        //
        // `MarmotGroup.selfUpdate()` is public and non-admin-callable, and
        // per refs/marmot/protocol-core/joining.md it is called right after
        // joining from a Welcome — a
        // moment when staged proposals from other members are plausible.
        const groupData = getMarmotGroupView(parentState);
        if (!groupData) {
          throw new Error("MarmotGroupData not found in ClientState.");
        }
        const prepared = this.#prepareOutboundCommitProposals(
          parentState,
          groupData.adminPubkeys,
          [],
        );

        const { commit, newState } = await createCommit({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
          },
          state: this.state,
          // Handshake content is wired as MLS PublicMessage (see wire-format.ts).
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
          extraProposals: prepared.extraProposals,
        });

        this.#assertStagedCommitLegal(
          parentState,
          newState,
          prepared.committedProposals,
        );

        // WR-17: same post-staging bookkeeping as `case "commit"` — the
        // throw above happens first, so a rejected selfUpdate leaves the
        // engine Stable with nothing to roll back. The parent-epoch pin keeps
        // retained pruning from dropping the epoch this commit branches from
        // while its publish is unconfirmed.
        const envelope = await this.peeler.wrapGroupMessage(commit, this.state);

        this.#transitionLifecycle(
          groupLifecycleStates.pendingPublish,
          "begin_pending",
          "selfUpdate",
        );
        this.#stagedCommitParentEpoch = Number(parentState.groupContext.epoch);

        this.#sentContentIds.add(contentDedupId(commit));

        // CR-09: carry `parentState` and `commitMessage` so `confirmPublished`
        // can record this commit into retained history and the fork tree. A
        // selfUpdate that is only `#setState`d leaves the tree with no node for
        // the new tip, which makes `GroupRegistry.#loadHistory` discard the
        // whole persisted fork history on the next load.
        return {
          kind: "selfUpdate",
          envelope,
          pending: {
            kind: "selfUpdate",
            newState,
            parentState,
            commitMessage: commit,
            ownCommitStamp: this.#ownCommitStamp(commit, prepared),
          },
        };
      }
    }
  }

  /**
   * Resolves the exact proposal union `createCommit` will commit, applies the
   * D-05 coupling splice once, and runs the same actor authorization callback
   * used by inbound processing before MLS construction begins.
   *
   * Unapplied proposals remain references in `createCommit`; selected refs are
   * therefore validated by the caller but are never copied into
   * `extraProposals`. This preserves proposal identity and prevents a selected
   * reference from being counted a second time as a by-value proposal.
   */
  #prepareOutboundCommitProposals(
    state: ClientState,
    adminPubkeys: readonly string[],
    byValueProposals: readonly Proposal[],
  ): {
    extraProposals: Proposal[];
    committedProposals: Proposal[];
    committer: string;
    priority: CommitOrderingPriority;
  } {
    const actorLeaf = state.privatePath.leafIndex as LeafIndex;
    const actorPubkey = getCredentialPubkey(
      getCredentialFromLeafIndex(state.ratchetTree, actorLeaf),
    );

    const referenced: ProposalWithSender[] = Object.values(
      state.unappliedProposals,
    );
    const localByValue: ProposalWithSender[] = byValueProposals.map(
      (proposal) => ({ proposal, senderLeafIndex: Number(actorLeaf) }),
    );
    const committedWithSenders = [...referenced, ...localByValue];
    const committedProposals = committedWithSenders.map((p) => p.proposal);
    const extraProposals = [...byValueProposals];

    const adminPolicySplice = this.#adminPolicySpliceFor(
      state,
      adminPubkeys,
      committedProposals,
    );
    if (adminPolicySplice) {
      extraProposals.push(adminPolicySplice);
      committedProposals.push(adminPolicySplice);
      committedWithSenders.push({
        proposal: adminPolicySplice,
        senderLeafIndex: Number(actorLeaf),
      });
    }

    const authorization = decideCommitAuthorization({
      actorPubkey,
      actorLeafIndex: Number(actorLeaf),
      adminPubkeys,
      proposals: committedWithSenders,
    });
    if (!authorization.authorized) {
      throw new Error(
        "Not a group admin. Non-admins may only commit a self-update-only or self_remove-only commit. Wait for the staged proposal to be committed, or ask an admin to commit it.",
      );
    }

    const nonAdminShape = decideCommitAuthorization({
      actorPubkey,
      actorLeafIndex: Number(actorLeaf),
      adminPubkeys: [],
      proposals: committedWithSenders,
    });
    return {
      extraProposals,
      committedProposals,
      committer: actorPubkey,
      priority: nonAdminShape.authorized ? "ordinary" : "privileged",
    };
  }

  /** Captures recovery evidence from the exact staged public commit. */
  #ownCommitStamp(
    commit: MlsMessage,
    prepared: { committer: string; priority: CommitOrderingPriority },
  ): OwnCommitConvergenceStamp {
    if (
      commit.wireformat !== wireformats.mls_public_message ||
      commit.publicMessage.content.contentType !== contentTypes.commit
    )
      throw new Error("Own commit stamp requires a public MLS commit");
    const consumedProposalRefs = commit.publicMessage.content.commit.proposals
      .filter(
        (entry) => entry.proposalOrRefType === proposalOrRefTypes.reference,
      )
      .map((entry) => entry.reference.slice());
    return {
      committer: prepared.committer,
      priority: prepared.priority,
      consumedProposalRefs,
    };
  }

  /**
   * D-05/D-06/D-07/D-08: the shared admin-leaf-coupling guard both
   * commit-producing send seams (`case "commit"` and `case "selfUpdate"`) run
   * before `createCommit`. Returns the admin-policy `AppDataUpdate` proposal
   * that MUST be spliced into this commit so the resulting epoch stays legal,
   * or `undefined` when no admin account loses its last member leaf.
   *
   * `committedProposals` is the already-normalized exact proposal union from
   * {@link #prepareOutboundCommitProposals}. It includes every unapplied
   * reference exactly once plus caller-supplied by-value proposals.
   *
   * Deliberately EXCLUDES `selfRemoveProposalType` entries (SelfRemove
   * carve-out, Pitfall 4): a SelfRemove must not trigger auto-coupling or the
   * depletion guard. An admin's SelfRemove is already refused by
   * `createAdminCommitPolicyCallback`, and a non-admin's SelfRemove cannot
   * change the admin set.
   *
   * @throws AdminDepletionError when the commit would leave the resulting
   * epoch with no surviving admin account (D-07) — refused before any staging,
   * before `createCommit`, and before the wrong-layer `encodeAdminPolicyV1`
   * "at least one admin" error could fire.
   * @see refs/mdk/crates/cgka-engine/src/message_processor/send.rs `do_send_remove_members`
   */
  #adminPolicySpliceFor(
    state: ClientState,
    currentAdmins: readonly string[],
    committedProposals: readonly Proposal[],
  ): Proposal | undefined {
    const removedLeaves = new Set<number>();
    for (const proposal of committedProposals) {
      if (
        proposal.proposalType === defaultProposalTypes.remove &&
        "remove" in proposal
      ) {
        removedLeaves.add(Number(proposal.remove.removed));
      }
    }
    if (removedLeaves.size === 0) return undefined;

    // D-08: account-level survival — an account survives if at least one of
    // its leaves is NOT in removedLeaves; leaf-level would diverge the moment
    // an account has two leaves, which the wire format already permits.
    const survivingAccounts = new Set<string>();
    for (const pubkey of getGroupMemberPubkeys(state)) {
      const leaves = getPubkeyLeafNodeIndexes(state, pubkey);
      if (leaves.some((leaf) => !removedLeaves.has(leaf))) {
        survivingAccounts.add(pubkey);
      }
    }

    const resultingAdmins = currentAdmins.filter((pk) =>
      survivingAccounts.has(pk),
    );

    if (currentAdmins.length > 0 && resultingAdmins.length === 0) {
      throw new AdminDepletionError(currentAdmins.length);
    }

    // D-05 splice: same commit — never a follow-up commit.
    if (resultingAdmins.length === currentAdmins.length) return undefined;

    return {
      proposalType: appDataUpdateProposalType,
      appDataUpdate: {
        componentId: GROUP_ADMIN_POLICY_COMPONENT_ID,
        operation: "update",
        update: encodeAdminPolicyV1(resultingAdmins),
      },
    };
  }

  /**
   * D-01/D-02: the shared send/staging commit-legality gate, run by both
   * commit-producing send seams against the SAME proposal union
   * `createCommit` actually bundles — the by-reference unapplied proposals
   * plus this call's `byValueProposals` (including any spliced admin-policy
   * update).
   *
   * Validating only `byValueProposals` would be a false-positive generator: a
   * caller who staged an AppDataUpdate proposal separately and committed with
   * no explicit refs has it bundled by reference, and the integrity validator
   * would otherwise see a dictionary change with no backing op.
   *
   * @throws CommitLegalityError carrying the structured violation.
   */
  #assertStagedCommitLegal(
    parentState: ClientState,
    resultingState: ClientState,
    committedProposals: readonly Proposal[],
  ): void {
    const violation = validateCommitLegality({
      parentState,
      resultingState,
      proposals: committedProposals,
    });
    if (violation) throw new CommitLegalityError(violation);
  }

  /**
   * Applies staged state after publish confirmation (publish-before-apply).
   *
   * CR-09: `selfUpdate` takes the identical path to `commit` — it is a commit
   * in every sense that matters here (it advances the epoch and produces a new
   * confirmation tag), so it must be recorded into retained history and the
   * fork tree. Recording it only via `#setState` left `RetainedHistoryStore`
   * with no `stateAt(newEpoch)` (so `resolveFork` could never rebuild across a
   * selfUpdate) and the tree with no node for the new tip (so the next
   * `GroupRegistry.#loadHistory` discarded the entire persisted fork history).
   * Since `refs/marmot/protocol-core/joining.md` tells clients to selfUpdate
   * immediately after joining from a Welcome, the normal join path destroyed
   * its own convergence persistence.
   */
  confirmPublished(pending: PendingState): StateNotification[] {
    if (pending.kind === "commit" || pending.kind === "selfUpdate") {
      if (!pending.parentState || !pending.commitMessage) {
        throw new Error(
          "Commit pending state requires parentState and commitMessage",
        );
      }

      const fromEpoch = Number(pending.parentState.groupContext.epoch);
      const toEpoch = Number(pending.newState.groupContext.epoch);
      this.#transitionLifecycle(
        groupLifecycleStates.merging,
        "publish_confirmed",
        pending.kind,
      );
      try {
        this.#setState(pending.newState);
        this.#recordCommitNode(
          pending.parentState,
          pending.commitMessage,
          pending.newState,
          pending.ownCommitStamp,
        );
        const digest = commitDigest(
          encode(mlsMessageEncoder, pending.commitMessage),
        );
        let notifications: StateNotification[];
        try {
          notifications = deriveStateNotifications({
            parentState: pending.parentState,
            resultingState: pending.newState,
            commitDigest: digest,
          });
        } catch (error) {
          this.#log()(
            "state notification derivation failed for local commit: %o",
            error,
          );
          notifications = [];
        }
        this.#stateNotifications.record(digest, toEpoch, notifications);
        const horizon = this.#ledgerHorizon();
        if (horizon !== undefined) this.#stateNotifications.pruneBelow(horizon);
        this.#emitAudit({
          type: "epoch_confirmed",
          from_epoch: fromEpoch,
          to_epoch: toEpoch,
          pending_kind: pending.kind,
        });
        return notifications;
      } finally {
        this.#transitionLifecycle(
          groupLifecycleStates.stable,
          "merge_complete",
          pending.kind,
        );
        this.#stagedCommitParentEpoch = undefined;
      }
    }

    this.#setState(pending.newState);
    // CR-08: a proposal WE staged must land in the tree node snapshot exactly
    // as an inbound one does (`ingest.ts` → `recordProposalStaged`). Without
    // this, the persisted snapshot for the current tip keeps
    // `unappliedProposals === {}` and a later commit that bundles this
    // proposal by reference becomes unvalidatable — and therefore unbuildable
    // as a candidate — after a restart.
    if (pending.kind === "proposal") this.#recordProposalStaged(this.#state);
    return [];
  }

  /**
   * Reverts lifecycle when a staged commit publish fails or is abandoned.
   * Covers both commit-producing seams (CR-09/WR-17): a selfUpdate now also
   * transitions to `PendingPublish`, so a failed publish must roll it back or
   * the engine would be stuck unable to prepare any further commit.
   */
  publishFailed(pending: PendingState): void {
    if (pending.kind !== "commit" && pending.kind !== "selfUpdate") return;
    if (this.#lifecycle !== groupLifecycleStates.pendingPublish) return;
    const pendingEpoch = Number(pending.newState.groupContext.epoch);
    const restoredEpoch = Number(this.#state.groupContext.epoch);
    this.#emitAudit({
      type: "epoch_rolled_back",
      pending_epoch: pendingEpoch,
      restored_epoch: restoredEpoch,
      pending_kind: pending.kind,
    });
    this.#transitionLifecycle(
      groupLifecycleStates.stable,
      "publish_failed",
      pending.kind,
    );
    this.#stagedCommitParentEpoch = undefined;
  }

  /**
   * Ingests transport envelopes and applies MLS messages to group state.
   *
   * @yields DispositionedIngestResult - processing result plus inbound
   *   {@link Disposition}.
   */
  async *ingest(
    envelopes: TEnvelope[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<DispositionedIngestResult<TEnvelope>> {
    // Track this batch's convergence signal (B5): whether it carried any
    // convergence-relevant input (commits / fork material), whether anything was
    // left undispositioned (a deferred commit ⇒ Resolving), and whether it hit a
    // blocking missing-anchor error (⇒ Blocked).
    let convergenceRelevant = false;
    let unresolved = false;
    let blocked = false;
    for (const envelope of envelopes) this.#emitIngestEntry(envelope);

    for await (const result of this.#ingestWithPool(envelopes, options)) {
      if (this.#isConvergenceRelevant(result)) convergenceRelevant = true;
      if (result.kind === "deferred") unresolved = true;
      if (
        result.kind === "skipped" &&
        result.reason === "missing-retained-anchor"
      )
        blocked = true;

      const dispositioned = {
        ...result,
        disposition: ingestResultDisposition(result),
      };
      this.#emitIngestOutcome(dispositioned);
      yield dispositioned;
      if (
        (result.kind === "processed" || result.kind === "removed") &&
        result.notifications !== undefined
      ) {
        for (const group of groupWithdrawnNotificationsByCommit(
          result.notifications,
        )) {
          const appliedNotifications = {
            kind: "appliedNotifications" as const,
            commitDigest: group.commitDigest,
            notifications: group.withdrawn,
          };
          const appliedDispositioned = {
            ...appliedNotifications,
            disposition: ingestResultDisposition(appliedNotifications),
          };
          this.#emitIngestOutcome(appliedDispositioned);
          yield appliedDispositioned;
        }
      }
    }

    // A convergence pass ran only if convergence-relevant input arrived; a batch
    // of pure application messages or lone proposals MUST NOT reset the
    // quiescence window or overwrite the last pass's status inputs.
    if (convergenceRelevant) {
      this.#lastConvergenceRelevantInputMs = this.#now();
      this.#lastPassUnresolved = unresolved;
      this.#lastPassBlocked = blocked;
      // The window just reset; arm the settle-check so queued outbound is
      // re-evaluated once it elapses (B5). Reschedules any prior pending check.
      this.#scheduleSettleCheck();
    }

    // After the batch, if this client is the deterministically-elected committer
    // for any pending self_remove proposals, build and stage a self_remove-only
    // commit (B6, member-departure.md). It is surfaced as an `autoCommit` result;
    // the layer that owns the transport publishes it (publish-before-apply).
    const auto = await this.#maybeAutoCommitSelfRemoves();
    if (auto) {
      const dispositioned = {
        ...auto,
        disposition: ingestResultDisposition(auto),
      };
      this.#emitIngestOutcome(dispositioned);
      yield dispositioned;
    }
  }

  /**
   * Runs the ingest pipeline, but instead of surfacing a decrypt failure as
   * terminal `unreadable`, holds the event in the {@link IngestionPool} and
   * retries the whole pool whenever the canonical tip advances (a new epoch may
   * unlock a pooled event's key). This is what lets a newer-epoch message that
   * streamed in before its commit be read once the commit arrives, across ingest
   * batches. Entries the tip ages past the retention window are finally surfaced
   * as terminal `unreadable`.
   */
  async *#ingestWithPool(
    envelopes: TEnvelope[],
    options?: { maxRetries?: number },
  ): AsyncGenerator<IngestResult<TEnvelope>> {
    const MAX_SWEEPS = 16;
    let pass = envelopes;
    let sweeps = 0;
    while (pass.length > 0) {
      const tipBefore = bytesToHex(this.#state.confirmationTag);
      for await (const result of ingestEnvelopes(
        this.#ingestContext(),
        pass,
        options,
      )) {
        if (result.kind === "unreadable" && result.decryptFailure) {
          // Hold for retry rather than dropping; suppress the terminal yield.
          this.#pool.add(this.peeler.idOf(result.envelope), result.envelope);
          continue;
        }
        if (result.kind === "deferred") {
          this.#pool.add(
            this.peeler.idOf(result.envelope),
            result.envelope,
            result.sourceEpoch,
          );
          // Both retained and capacity-refused work remains visibly retryable;
          // neither path enters terminal wrapper deduplication.
          yield result;
          continue;
        }
        if (result.kind === "processed" || result.kind === "removed")
          this.#pool.remove(this.peeler.idOf(result.envelope));
        yield result;
      }
      const tipAfter = bytesToHex(this.#state.confirmationTag);
      // Re-feed the pool only when the tip advanced — an unchanged tip would
      // reproduce the same failures. Bounded by MAX_SWEEPS per ingest call.
      pass =
        tipAfter !== tipBefore && this.#pool.size > 0 && ++sweeps < MAX_SWEEPS
          ? this.#pool.envelopes()
          : [];
    }

    // Tree-targeted sweep: read/apply pooled events against any retained fork or
    // past-epoch node state, so late-arriving old-epoch and divergent-fork
    // messages are read and all reachable forks are grown into the tree.
    if (this.#pool.size > 0) yield* this.#sweepTree();

    // Re-score the persisted forks and switch branches if a competitor now wins
    // — e.g. pooled/late fork material the sweep just grew into the tree, or a
    // fork that only lived on disk. On a switch, re-sweep once so messages held
    // on the now-canonical branch are delivered as `processed`. Witness envelopes
    // are this batch plus the pool, so re-convergence sees at least the witnesses
    // pool-replay recovery saw and never reverts a witness-boosted decision.
    //
    // Deliberate asymmetry (D-12/CONV-02, CONV-03): when canonical state is the
    // removedFromGroup tombstone, `ingestEnvelopes` above short-circuits fresh
    // transport input as `self-evicted` (D-13), so the pool re-feed loop is a
    // no-op for a removed group. This tree-fed re-convergence pass must still
    // run regardless — it evaluates already-retained/persisted fork material,
    // not fresh input — so a later rewind can supersede the removing commit and
    // clear the removal marker (CONV-03, plan 03-07).
    const tipBeforeReconverge = bytesToHex(this.#state.confirmationTag);
    yield* this.#reconvergeFromTree([...envelopes, ...this.#pool.envelopes()]);
    if (
      bytesToHex(this.#state.confirmationTag) !== tipBeforeReconverge &&
      this.#pool.size > 0
    )
      yield* this.#sweepTree();

    // Give up on entries aged past the retention window — surface them terminal.
    const evicted = this.#pool.evictStale(
      Number(this.#state.groupContext.epoch),
    );
    for (const entry of evicted) {
      yield {
        kind: "unreadable",
        envelope: entry.envelope,
        errors: [
          new Error(
            "ingestion pool gave up: undecryptable within the retention window",
          ),
        ],
      };
    }
  }

  /**
   * Reads/applies pooled events against retained history-tree node states (not
   * just the current tip): an app message that decrypts on a node is read
   * (`processed` if that node is on the canonical path, else `invalidated` per
   * M7); a commit/proposal is applied against its node to grow that fork into
   * the tree. Each `(event, node)` pair is tried at most once (memoized on the
   * pool entry); growing the tree can unlock further pooled events, so it loops
   * to a fixed point. This is the "read epoch-1 messages while on epoch 15" and
   * "capture every reachable fork" path.
   */
  async *#sweepTree(): AsyncGenerator<IngestResult<TEnvelope>> {
    const MAX_ITERS = 32;
    const log = this.#log();
    for (let iter = 0; iter < MAX_ITERS && this.#pool.size > 0; iter++) {
      const canonicalPath = new Set(
        this.#tree.path(bytesToHex(this.#state.confirmationTag)) ?? [],
      );
      // Recent epochs first — most pooled events sit near the current tip.
      const tags = this.#tree
        .tags()
        .sort(
          (a, b) => (this.#tree.epochOf(b) ?? 0) - (this.#tree.epochOf(a) ?? 0),
        );

      let progress = false;
      for (const entry of this.#pool.entries()) {
        for (const tag of tags) {
          if (entry.triedTags.has(tag)) continue;
          entry.triedTags.add(tag);
          const state = await this.#tree.stateAt(tag);
          if (!state) continue;

          let message: MlsMessage | undefined;
          try {
            const peeled = await this.peeler.peelGroupMessages(
              [entry.envelope],
              state,
            );
            message = peeled.read[0]?.message;
          } catch {
            message = undefined;
          }
          // Only framed messages (commit/proposal/application) are processable.
          if (
            !message ||
            (message.wireformat !== wireformats.mls_private_message &&
              message.wireformat !== wireformats.mls_public_message)
          )
            continue;

          const result = await this.#sweepResult(
            entry.envelope,
            tag,
            state,
            message,
            canonicalPath.has(tag),
            log,
          );
          if (!result) continue;
          this.#pool.remove(entry.id);
          progress = true;
          yield result;
          break;
        }
      }
      if (!progress) break;
    }
  }

  /**
   * Processes a pooled message that decrypted against retained node `tag` and
   * classifies the outcome. Returns `undefined` to keep trying other nodes (the
   * message did not process against this state); otherwise the ingest result.
   */
  async #sweepResult(
    envelope: TEnvelope,
    tag: string,
    state: ClientState,
    message: MlsMessage,
    onCanonical: boolean,
    log: Debugger,
  ): Promise<IngestResult<TEnvelope> | undefined> {
    // Narrow to a framed message (the caller already guards this).
    if (
      message.wireformat !== wireformats.mls_private_message &&
      message.wireformat !== wireformats.mls_public_message
    )
      return undefined;
    const isCommit = framedContentType(message) === contentTypes.commit;
    let result: ProcessMessageResult;
    try {
      result = await processMessage({
        context: {
          cipherSuite: this.ciphersuite,
          authService: marmotAuthService,
          externalPsks: {},
        },
        state,
        message,
        callback: isCommit
          ? this.#createAdminVerificationCallback(state)
          : acceptAll,
      });
    } catch {
      return undefined; // decrypted but not processable against this node
    }

    if (result.kind === "newState") {
      if (result.actionTaken === "reject")
        return { kind: "rejected", result, envelope, message };
      try {
        if (isCommit) {
          // Grow this fork into the tree (capture it, off node `tag`).
          this.#tree.recordCommit(tag, message, result.newState);
        } else {
          // A proposal staged onto this node (its tag is unchanged).
          this.#tree.updateSnapshot(tag, result.newState);
        }
      } catch (error) {
        log("history tree sweep update failed: %o", error);
      }
      return { kind: "processed", result, envelope, message };
    }

    if (result.kind === "applicationMessage") {
      if (!isAuthenticApplicationMessage(result, state, log, "sweep"))
        return {
          kind: "skipped",
          envelope,
          message,
          reason: "invalid-app-payload",
        };
      // A read on the canonical path is delivered. One that only decrypts on a
      // non-canonical fork is HELD silently — retained in the pool, not surfaced —
      // until either we switch to that branch (a later sweep then delivers it as
      // `processed`, after `#applyForkResolution` resets the tried-tag memo) or it
      // ages out. Returning `undefined` keeps the entry pooled and moves on.
      // `invalidated` is reserved for retracting a payload previously delivered as
      // `accepted` when a rewind abandons its branch (`#applyForkResolution`).
      return onCanonical &&
        this.#state.groupActiveState.kind !== "removedFromGroup"
        ? { kind: "processed", result, envelope, message }
        : undefined;
    }

    return undefined;
  }

  /**
   * Whether an ingest result represents convergence-relevant input — a commit
   * (applied, rejected, deferred, or one that removed us), fork material
   * (past-epoch / beyond-anchor / missing-anchor skips), or a rewind retraction.
   * Application messages, lone proposals, self-echoes, our own staged
   * auto-commit, and undecryptable garbage are NOT convergence-relevant and MUST
   * NOT reset the quiescence window (B5; lone-proposal exemption darkmatter#154).
   */
  #isConvergenceRelevant(result: IngestResult<TEnvelope>): boolean {
    switch (result.kind) {
      case "processed":
      case "rejected":
        return framedContentType(result.message) === contentTypes.commit;
      case "deferred":
      case "invalidated":
      case "removed":
        return true;
      case "stateInvalidated":
        // A rewind retraction is convergence-relevant, matching "invalidated".
        return true;
      case "skipped":
        return (
          result.reason === "past-epoch" ||
          result.reason === "beyond-anchor" ||
          result.reason === "missing-retained-anchor"
        );
      case "autoCommit":
      case "appliedNotifications":
      case "unreadable":
        return false;
    }
  }

  /**
   * Arms (or re-arms) the settle-check timer to fire when the quiescence window
   * since the last convergence-relevant input elapses (B5). Cancels any pending
   * check first, so a fresh input always restarts the window. A no-op when no
   * settle callback is wired (the engine has nothing to notify).
   */
  #scheduleSettleCheck(): void {
    if (!this.#onSettleCheck) return;
    if (this.#settleTimer !== undefined) {
      this.#scheduler.clearTimer(this.#settleTimer);
      this.#settleTimer = undefined;
    }
    const elapsed = this.#now() - this.#lastConvergenceRelevantInputMs;
    const delay = Math.max(0, this.#settlementQuiescenceMs - elapsed);
    this.#settleTimer = this.#scheduler.setTimer(delay, () => {
      this.#settleTimer = undefined;
      // Fire-and-forget; the owner's drain handles and logs its own errors.
      void this.#onSettleCheck?.();
    });
  }

  /**
   * Releases engine resources — currently the pending settle-check timer.
   * Called on group teardown (destroy/unload) so no timer outlives the group.
   */
  dispose(): void {
    if (this.#settleTimer !== undefined) {
      this.#scheduler.clearTimer(this.#settleTimer);
      this.#settleTimer = undefined;
    }
  }

  /**
   * If pending proposals are exactly a set of `self_remove`s this client is
   * elected to commit (lowest eligible leaf, {@link decideAutoCommit}), builds
   * and stages a `self_remove`-only commit by reference. Returns the staged
   * commit for the caller to publish, or `undefined` when this client should
   * just observe.
   */
  async #maybeAutoCommitSelfRemoves(): Promise<
    AutoCommitIngestResult<TEnvelope> | undefined
  > {
    if (!mayPrepareLocalCommit(this.#lifecycle)) return undefined;

    const state = this.#state;
    const unapplied = Object.values(state.unappliedProposals);
    if (unapplied.length === 0) return undefined;

    // createCommit bundles ALL unapplied proposals by reference, so only
    // auto-commit when every pending proposal is a self_remove — otherwise we
    // would fold foreign proposals into a commit that is no longer
    // self_remove-only. Mixed sets are left for an admin's explicit commit.
    if (!unapplied.every((p) => isSelfRemoveProposal(p.proposal)))
      return undefined;

    const groupData = getMarmotGroupView(state);
    const adminPubkeys = groupData?.adminPubkeys ?? [];

    const leaverLeafIndices: number[] = [];
    let anyLeaverIsActiveAdmin = false;
    for (const p of unapplied) {
      if (p.senderLeafIndex === undefined) return undefined;
      leaverLeafIndices.push(Number(p.senderLeafIndex));
      try {
        const leaverPubkey = getCredentialPubkey(
          getCredentialFromLeafIndex(
            state.ratchetTree,
            p.senderLeafIndex as LeafIndex,
          ),
        );
        if (adminPubkeys.includes(leaverPubkey)) anyLeaverIsActiveAdmin = true;
      } catch {
        anyLeaverIsActiveAdmin = true; // fail-closed
      }
    }

    let ownPubkey: string;
    try {
      ownPubkey = getCredentialPubkey(
        getCredentialFromLeafIndex(
          state.ratchetTree,
          state.privatePath.leafIndex as LeafIndex,
        ),
      );
    } catch {
      return undefined;
    }

    const decision = decideAutoCommit({
      leaverLeafIndices,
      ownLeafIndex: Number(state.privatePath.leafIndex),
      memberLeafIndices: this.#occupiedLeafIndices(),
      anyLeaverIsActiveAdmin,
    });
    if (decision !== "commit") return undefined;

    // No extraProposals/refs: createCommit bundles the pending self_removes by
    // reference (required — an inline self_remove inherits the committer as
    // sender and is rejected). The send-path admin gate sees no extra proposals
    // and treats it as a self-update-only commit, which a non-admin may make.
    const result = await this.send({ kind: "commit", actorPubkey: ownPubkey });
    if (result.kind !== "groupEvolution") return undefined;

    this.#log()(
      "auto-committing %d self_remove proposal(s)",
      leaverLeafIndices.length,
    );
    return {
      kind: "autoCommit",
      envelope: result.envelope,
      pending: result.pending,
      actorPubkey: ownPubkey,
    };
  }

  /** Leaf indices of all occupied leaves in the current ratchet tree. */
  #occupiedLeafIndices(): number[] {
    const out: number[] = [];
    const tree = this.#state.ratchetTree;
    for (let nodeIndex = 0; nodeIndex < tree.length; nodeIndex++) {
      const node = tree[nodeIndex];
      if (node && node.nodeType === nodeTypes.leaf)
        out.push(Math.floor(nodeIndex / 2));
    }
    return out;
  }

  #setState(newState: ClientState): void {
    this.#state = newState;
    this.#onStateChanged?.(newState);
  }

  #emitAudit(kind: AuditEventKind): void {
    this.#audit?.emit(kind, {
      groupRef: bytesToHex(this.#state.groupContext.groupId),
      context: {
        group: this.#auditGroupContext(),
      },
    });
  }

  #emitEngineContext(): void {
    this.#emitAudit({
      type: "engine_context",
      context: {
        ciphersuite: Number(this.#state.groupContext.cipherSuite),
        convergence_max_rewind_commits: finiteAuditNumber(
          this.#policy.maxRewindCommits,
        ),
      },
    });
  }

  #emitGroupContext(reason: string): void {
    this.#emitAudit({
      type: "group_context",
      reason,
      context: this.#auditGroupContext(),
    });
  }

  #auditGroupContext() {
    const groupData = getMarmotGroupView(this.#state);
    return {
      epoch: Number(this.#state.groupContext.epoch),
      member_count: this.#occupiedLeafIndices().length,
      admin_count: groupData?.adminPubkeys.length ?? 0,
      convergence_max_rewind_commits: finiteAuditNumber(
        this.#policy.maxRewindCommits,
      ),
    };
  }

  #transitionLifecycle(
    next: GroupLifecycleState,
    reason: string,
    pendingKind?: string,
  ): void {
    const previous = this.#lifecycle;
    this.#lifecycle = transitionLifecycle(this.#lifecycle, next);
    this.#emitAudit({
      type: "epoch_state_changed",
      previous_state: auditEpochStateName(previous),
      new_state: auditEpochStateName(this.#lifecycle),
      epoch: Number(this.#state.groupContext.epoch),
      reason,
      pending_kind: pendingKind,
    });
  }

  #emitIngestEntry(envelope: TEnvelope): void {
    const raw = JSON.stringify(envelope);
    this.#emitAudit({
      type: "ingest_entry",
      msg_id: this.peeler.idOf(envelope),
      envelope_kind: this.#artifactKind(envelope),
      transport_source: "nostr",
      transport: this.#transportEnvelope(envelope),
      payload_len: raw.length,
      payload_digest: digestString(raw),
    });
  }

  #emitIngestOutcome(result: DispositionedIngestResult<TEnvelope>): void {
    // A withdrawal has no triggering transport envelope to attribute an audit
    // msg_id to (D-11); audit wiring for `stateInvalidated` is deferred to the
    // seam-wiring plan that actually produces this variant.
    // Envelope-less state outcomes cannot be assigned a transport msg_id.
    // Audit emission remains deferred while the schema requires msg_id; do
    // not fabricate transport attribution for either result variant.
    if (!("envelope" in result)) return;
    const msgId = this.peeler.idOf(result.envelope);
    const outcome = auditIngestOutcome(result);
    if (outcome) {
      this.#emitAudit({
        type: "ingest_outcome",
        msg_id: msgId,
        outcome_kind: outcome.kind,
        stale_reason: outcome.staleReason,
        epoch: auditResultEpoch(result),
      });
    }
    if (result.kind === "invalidated") {
      this.#emitAudit({
        type: "message_state_changed",
        msg_id: msgId,
        artifact_kind: this.#artifactKind(result.envelope),
        new_state: "epoch_invalidated",
        epoch: result.epoch,
        reason: "convergence_rewind",
      });
    }
    if (result.kind === "rejected") {
      this.#emitAudit({
        type: "rejection",
        msg_id: msgId,
        reason: (result.reason ?? "admin-policy").replaceAll("-", "_"),
      });
    }
  }

  #transportEnvelope(envelope: TEnvelope): AuditTransportWireEnvelope {
    const candidate = envelope as {
      id?: string;
      kind?: number;
      pubkey?: string;
      tags?: string[][];
    };
    const groupTag = candidate.tags?.find((tag) => tag[0] === "h")?.[1];
    return {
      transport: "nostr",
      wire_id: candidate.id,
      wire_kind: candidate.kind?.toString(),
      wire_pubkey_hex: candidate.pubkey,
      transport_group_id: groupTag,
      nostr_event_id: candidate.id,
      nostr_kind: candidate.kind,
      nostr_pubkey_hex: candidate.pubkey,
    };
  }

  #artifactKind(
    envelope: TEnvelope,
    resultKind?: SendResult<TEnvelope>["kind"],
  ) {
    if (resultKind === "applicationMessage") return "application_message";
    if (resultKind === "groupEvolution" || resultKind === "selfUpdate")
      return "commit";
    if (resultKind === "proposal") return "proposal";
    const candidate = envelope as { kind?: number };
    return messageArtifactKindFromNostrKind(candidate.kind);
  }

  #log(): Debugger {
    const idStr = bytesToHex(this.#state.groupContext.groupId);
    return logger.extend(`group-engine:${idStr.slice(0, 8)}`);
  }

  /** The dependency surface the ingest pipeline drives. */
  #ingestContext(): IngestContext<TEnvelope> {
    return {
      ciphersuite: this.ciphersuite,
      peeler: this.peeler,
      retained: this.#retained,
      maxRewindCommits: this.#policy.maxRewindCommits,
      log: this.#log(),
      getState: () => this.#state,
      setState: (state) => this.#setState(state),
      recordCommit: (parentState, message, newState) =>
        this.#recordCommitNode(parentState, message, newState),
      recordProposalStaged: (state) => this.#recordProposalStaged(state),
      createAdminCallback: () => this.#createAdminVerificationCallback(),
      resolveFork: (forkEpoch, pool, encrypted, witnessEnvelopes) =>
        this.#resolveFork(forkEpoch, pool, encrypted, witnessEnvelopes),
      recordDeliveredAppPayload: (
        epoch,
        stateTag,
        envelope,
        message,
        payload,
      ) => {
        this.#delivered.record({ epoch, stateTag, envelope, message, payload });
        const horizon = this.#ledgerHorizon();
        if (horizon !== undefined) this.#delivered.pruneBelow(horizon);
      },
      recordStateNotifications: (digest, epoch, notifications) => {
        this.#stateNotifications.record(digest, epoch, notifications);
        const horizon = this.#ledgerHorizon();
        if (horizon !== undefined) this.#stateNotifications.pruneBelow(horizon);
      },
      toUnrecoverable: () => this.#toUnrecoverable(),
      dedup: {
        classify: (message) => {
          const id = contentDedupId(message);
          if (this.#sentContentIds.has(id)) return "own-echo";
          if (this.#seenContentIds.has(id)) return "duplicate";
          return undefined;
        },
        remember: (message) => {
          this.#seenContentIds.add(contentDedupId(message));
        },
      },
    };
  }

  /**
   * Drives the lifecycle to the terminal `Unrecoverable` state, routing through
   * `Recovering` when needed (the only legal predecessor per group-state.md).
   * Idempotent: a no-op once already `Unrecoverable`.
   */
  #toUnrecoverable(): void {
    if (this.#lifecycle === groupLifecycleStates.unrecoverable) return;
    if (this.#lifecycle === groupLifecycleStates.stable)
      this.#transitionLifecycle(
        groupLifecycleStates.recovering,
        "missing_retained_anchor",
      );
    if (
      canTransitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.unrecoverable,
      )
    )
      this.#transitionLifecycle(
        groupLifecycleStates.unrecoverable,
        "missing_retained_anchor",
      );
  }

  /**
   * Resolves a fork via {@link ForkRecovery} and applies the rewind: on a
   * canonical-branch win, transitions through `Recovering`, adopts the winning
   * tip, records the replayed chain into retained history, and returns to
   * `Stable`. Lifecycle ownership stays here in the engine.
   */
  async #resolveFork(
    forkEpoch: number,
    pool: Parameters<ForkRecovery<TEnvelope>["resolveFork"]>[0]["pool"],
    encrypted: TEnvelope[],
    witnessEnvelopes: TEnvelope[],
  ): Promise<AppliedForkResolution<TEnvelope>> {
    const resolution = await this.#forkRecovery.resolveFork({
      forkEpoch,
      pool,
      encrypted,
      witnessEnvelopes,
      currentState: this.state,
      retained: this.#retained,
      adminCallback: this.#createAdminVerificationCallback(),
    });

    // Retain every branch built while resolving — the winner and every loser —
    // so the full fork tree survives even when we do not change branches. Edges
    // are in DFS order (parents first); a dangling edge is skipped, not fatal.
    if (resolution.outcome !== "skip") {
      try {
        for (const edge of resolution.edges) this.#tree.recordEdge(edge);
      } catch (error) {
        this.#log()("history tree recordEdge failed: %o", error);
      }
    }

    if (resolution.outcome !== "recovered") {
      this.#emitAudit({
        type: "convergence_decision",
        current_tip_epoch: Number(this.state.groupContext.epoch),
        max_rewind_commits: finiteAuditNumber(this.#policy.maxRewindCommits),
        candidates: [],
        error_kinds:
          resolution.outcome === "skip" ? ["candidate_state_unavailable"] : [],
      });
      return { outcome: resolution.outcome };
    }

    return this.#applyForkResolution(forkEpoch, resolution);
  }

  /**
   * Adopts a recovered fork resolution — the shared rewind-apply path used by
   * both pool-replay recovery ({@link #resolveFork}) and tree-fed re-convergence
   * ({@link #reconvergeFromTree}). Computes the abandoned app payloads to retract
   * (M7), transitions `Recovering → setState(winner) → Stable`, records the
   * winner chain into retained history, prunes the ledger below the new anchor,
   * and resets the pool's tried-tag memo so a fork message previously held on the
   * losing branch can now be delivered on the canonical one.
   */
  #applyForkResolution(
    forkEpoch: number,
    resolution: Extract<ForkResolution, { outcome: "recovered" }>,
  ): AppliedForkResolution<TEnvelope> {
    // The canonical branch's state identities (root + every applied child +
    // the tip). Any app payload delivered above the fork epoch whose delivery
    // state is not on this chain decrypted only on the abandoned branch, so it
    // is retracted as `invalidated` (M7, convergence.md).
    const canonicalTags = new Set<string>();
    if (resolution.winnerChain.length > 0)
      canonicalTags.add(
        bytesToHex(resolution.winnerChain[0].parent.confirmationTag),
      );
    for (const link of resolution.winnerChain)
      canonicalTags.add(bytesToHex(link.child.confirmationTag));
    canonicalTags.add(bytesToHex(resolution.winnerTip.confirmationTag));
    const invalidated = this.#delivered.invalidatedByRewind(
      forkEpoch,
      canonicalTags,
    );

    // D-11: the canonical commit digests for THIS rewind — every digest on
    // the winning chain — so a notification recorded for a commit that is
    // NOT among them (i.e. superseded) gets withdrawn. Computed from
    // `resolution.winnerChain` link messages, the same bytes `commitDigest`
    // already hashes elsewhere in this file (`fork-recovery.ts`).
    const canonicalDigests = new Set<string>();
    for (const link of resolution.winnerChain)
      canonicalDigests.add(
        bytesToHex(commitDigest(encode(mlsMessageEncoder, link.message))),
      );
    const withdrawnNotifications = this.#stateNotifications.invalidatedByRewind(
      forkEpoch,
      canonicalDigests,
    );

    this.#emitAudit({
      type: "convergence_decision",
      current_tip_epoch: Number(this.state.groupContext.epoch),
      max_rewind_commits: finiteAuditNumber(this.#policy.maxRewindCommits),
      candidates: [
        {
          branch_id: bytesToHex(resolution.winnerTip.confirmationTag),
          fork_epoch: forkEpoch,
          tip_epoch: Number(resolution.winnerTip.groupContext.epoch),
        },
      ],
      selected_branch_id: bytesToHex(resolution.winnerTip.confirmationTag),
      selected_fork_epoch: forkEpoch,
      selected_tip_epoch: Number(resolution.winnerTip.groupContext.epoch),
    });
    this.#transitionLifecycle(groupLifecycleStates.recovering, "fork_detected");
    this.#setState(resolution.winnerTip);
    for (const link of resolution.winnerChain) {
      this.#retained.record(
        link.parent,
        link.message,
        link.child,
        this.#pinnedEpochs(),
      );
    }
    this.#transitionLifecycle(groupLifecycleStates.stable, "branch_applied");
    // The canonical path moved; let held fork messages re-decrypt on it.
    this.#pool.resetTried();

    // D-10/D-11: derive and ledger-record the notifications produced by EVERY
    // commit on the winning chain — so a *later* rewind that supersedes any of
    // them (e.g. a subsequent tree-fed switch, `#reconvergeFromTree`) can
    // withdraw exactly what this rewind emitted, closing the loop for commits
    // that land via a rewind rather than the direct in-order ingest branch
    // (`ingest.ts` records notifications there; this is the rewind-landed
    // counterpart).
    //
    // CR-07: a rewind that adopts an N-commit branch really does apply N
    // commits. Diffing only the tip link dropped every intermediate commit's
    // membership/component changes (a 3-commit branch that added Alice, then
    // removed Bob, then rotated a key reported only the rotation, with
    // `epochAdvanced` understating the jump) and — because
    // `invalidatedByRewind` can only withdraw what was `record()`ed — left
    // those notifications permanently non-withdrawable, breaking CONV-03's
    // stated invariant.
    //
    // Each link is diffed parent -> child (never parent -> winnerTip), so an
    // intermediate link reports its own transition rather than a collapsed one.
    // `undefined` only when the winner tip is the fork root itself (no chain
    // applied), mirroring `tipCommitMessage`.
    let chainNotifications: StateNotification[] | undefined;
    if (resolution.winnerChain.length > 0) {
      chainNotifications = [];
      for (const link of resolution.winnerChain) {
        const linkDigest = commitDigest(
          encode(mlsMessageEncoder, link.message),
        );
        const linkEpoch = Number(link.child.groupContext.epoch);
        // WR-14: `invalidatedByRewind` KEEPS entries whose digest is on the
        // winning chain, so a prefix link that was already applied and
        // ledger-recorded in-order (`ingest.ts`) is still recorded here. It
        // must not be reported to the caller a second time — the fork root can
        // sit below the divergence point, e.g. competing commits at epochs F
        // and F+1 give a winner chain of [F->c1 (already applied), F+1->peer].
        // `record` is idempotent, but the caller-facing `chainNotifications`
        // needs the same filter or the app sees a duplicate delivery for a
        // commit it already processed.
        const alreadyRecorded = this.#stateNotifications.has(
          linkDigest,
          linkEpoch,
        );
        // WR-15: this is the ONE derivation site that runs after state has
        // already advanced — `#setState(resolution.winnerTip)` above — so an
        // escaping throw would abandon the rewind mid-flight, before
        // `GroupSession.ingest` can persist it. Its sibling seams
        // (`fork-recovery.ts`, `#treeResolution`) all wrap their validators
        // for exactly this reason. `deriveStateNotifications` reaches
        // `getGroupMembers` → `getCredentialPubkey`, which throws for a leaf
        // whose identity is not a valid 32-byte hex key; that leaf is now
        // skipped at the source, but log-and-continue here keeps one bad link
        // from taking down the whole chain.
        let derived: StateNotification[];
        try {
          derived = deriveStateNotifications({
            parentState: link.parent,
            resultingState: link.child,
            commitDigest: linkDigest,
          });
        } catch (error) {
          this.#log()(
            "state notification derivation failed for link %s: %o",
            bytesToHex(link.child.confirmationTag),
            error,
          );
          derived = [];
        }
        this.#stateNotifications.record(linkDigest, linkEpoch, derived);
        if (!alreadyRecorded) chainNotifications.push(...derived);
      }
    }

    const horizon = this.#ledgerHorizon();
    if (horizon !== undefined) {
      this.#delivered.pruneBelow(horizon);
      this.#stateNotifications.pruneBelow(horizon);
    }

    return {
      outcome: "recovered",
      result: resolution.result,
      // D-10/D-12: the winning chain's own tip commit, so a caller attributing
      // a `selfRemoved` notification to a rewind-landed removal digests the
      // commit that actually produced it, not an arbitrary forkPool entry.
      tipCommitMessage: resolution.winnerChain.at(-1)?.message,
      notifications: chainNotifications,
      withdrawnNotifications,
      invalidated: invalidated.map(
        ({ envelope, message, payload, stateTag, epoch }) => ({
          envelope,
          message,
          payload,
          tag: stateTag,
          epoch,
        }),
      ),
    };
  }

  /**
   * Re-scores the persisted fork history against the current tip and switches to
   * the canonical branch when a competitor wins (`convergence.md`). Every
   * candidate is sourced from the history tree, so a fork known only on disk is
   * re-evaluated without the transport re-delivering it — the load-time and
   * post-sweep path for dynamic fork switching. A switch reuses
   * {@link #applyForkResolution}; only the resulting `invalidated` retractions are
   * yielded (a tree-fed switch has no triggering envelope, so it is never a
   * `processed` result — the now-canonical branch's app messages surface via a
   * follow-up sweep). No-op unless `Stable` and the tree holds a competing tip.
   */
  async *#reconvergeFromTree(
    witnessEnvelopes: TEnvelope[],
  ): AsyncGenerator<IngestResult<TEnvelope>> {
    if (this.#lifecycle !== groupLifecycleStates.stable) return;
    if (this.#tree.tips().length <= 1) return;

    const currentTipTag = bytesToHex(this.#state.confirmationTag);
    const set = buildTreeBranchSet(this.#tree, currentTipTag, this.#policy);
    if (!set) return;

    // Witnesses are best-effort: layered on when envelopes are resident (live),
    // absent on load where the structural keys (depth + lower tip digest) decide.
    const witnessesByTip =
      witnessEnvelopes.length > 0
        ? await this.#gatherTreeWitnesses(set, witnessEnvelopes)
        : undefined;
    const candidates: BranchCandidate[] = witnessesByTip
      ? set.candidates.map((c) => ({
          ...c,
          appWitnesses: witnessesByTip.get(c.id) ?? [],
        }))
      : set.candidates;

    const winner = selectCanonicalBranch(
      Number(this.#state.groupContext.epoch),
      candidates,
      this.#policy,
    );
    if (!winner || winner.id === currentTipTag) return;

    const resolution = await this.#treeResolution(set.rootTag, winner.id);
    if (!resolution) return;

    const forkEpoch = this.#tree.epochOf(set.rootTag) ?? winner.forkEpoch;
    const applied = this.#applyForkResolution(forkEpoch, resolution);
    if (applied.outcome === "recovered") {
      // Tree-fed adoption has no transport envelope to carry notifications on.
      // Surface each commit's already-recorded notifications as its own named
      // result before any later withdrawal can retract the same identity.
      for (const group of groupWithdrawnNotificationsByCommit(
        applied.notifications ?? [],
      )) {
        yield {
          kind: "appliedNotifications",
          commitDigest: group.commitDigest,
          notifications: group.withdrawn,
        };
      }
      // D-11: withdrawn state notifications are yielded BEFORE the
      // app-payload `invalidated` retractions below, matching the pool-replay
      // rewind site (`ingest.ts`) so the two retraction streams have a
      // deterministic relative order regardless of which rewind path fired.
      for (const group of groupWithdrawnNotificationsByCommit(
        applied.withdrawnNotifications,
      )) {
        yield {
          kind: "stateInvalidated",
          commitDigest: group.commitDigest,
          forkEpoch,
          withdrawn: group.withdrawn,
        };
      }
      for (const inv of applied.invalidated)
        yield {
          kind: "invalidated",
          envelope: inv.envelope,
          message: inv.message,
          payload: inv.payload,
          tag: inv.tag,
          epoch: inv.epoch,
        };
    }
  }

  /**
   * Drives one tree-fed re-convergence pass to completion, switching to the
   * canonical branch if the persisted history now favors a competing fork. Public
   * entry for the load path (after the engine hydrates from the tree) and any
   * caller wanting an explicit re-evaluation. Witness-free — the structural keys
   * decide; witnesses refine on the next live ingest/sweep.
   *
   * Returns every result the pass produced, dispositioned and audited exactly
   * as {@link ingest} does, so a caller can route them through the identical
   * handler.
   *
   * CR-06: these results MUST reach the caller. `#reconvergeFromTree` is the
   * only site that can yield the `stateInvalidated` withdrawal proving a
   * rewind superseded the commit that removed us, and that withdrawal is what
   * clears the persisted removed-inactive marker (CONV-03, D-12). While this
   * method drained into `void _`, a client that was removed on a losing fork,
   * restarted, and re-converged onto a branch where it is still a member ended
   * up with canonical membership restored AND a stale marker still set —
   * silently suppressing the next genuine removal.
   */
  async reconvergeFromHistory(): Promise<
    DispositionedIngestResult<TEnvelope>[]
  > {
    const results: DispositionedIngestResult<TEnvelope>[] = [];
    for await (const result of this.#reconvergeFromTree([])) {
      const dispositioned = {
        ...result,
        disposition: ingestResultDisposition(result),
      };
      this.#emitIngestOutcome(dispositioned);
      results.push(dispositioned);
    }
    return results;
  }

  /**
   * Assembles a recovered {@link ForkResolution} for a tree-fed switch directly
   * from the persisted history tree — the path `rootTag → winnerTipTag`, with a
   * fresh {@link ClientState} snapshot fetched per chain endpoint (so no two links
   * alias an object) and the stored commit per edge. No `processMessage` replay
   * for chain ASSEMBLY: the tree already holds each branch state. It DOES replay
   * each link once, below, to re-derive the commit's own proposals and
   * re-validate commit legality before adoption (D-04/D-09) — a persisted tree
   * edge may have been written by a pre-upgrade build that never enforced
   * `validateCommitLegality`, so adopting it without re-checking would be
   * grandfathering a violation the send/inbound/replay seams would all now
   * refuse. Fails closed: any link that cannot be re-validated abandons the
   * whole switch (returns `undefined`), leaving the current tip in place. The
   * accepted consequence (D-04/D-09) is that such a branch becomes
   * unselectable and, if it was the only candidate, the group stays on its
   * current tip. Returns `undefined` if any snapshot or commit is missing.
   */
  async #treeResolution(
    rootTag: string,
    winnerTipTag: string,
  ): Promise<Extract<ForkResolution, { outcome: "recovered" }> | undefined> {
    const fullPath = this.#tree.path(winnerTipTag);
    if (!fullPath) return undefined;
    const rootIndex = fullPath.indexOf(rootTag);
    if (rootIndex < 0) return undefined;
    const segment = fullPath.slice(rootIndex);

    const winnerChain: ChainLink[] = [];
    for (let i = 1; i < segment.length; i++) {
      const parent = await this.#tree.stateAt(segment[i - 1]);
      const child = await this.#tree.stateAt(segment[i]);
      const message = await this.#tree.commitMessageOf(segment[i]);
      if (!parent || !child || !message) return undefined;
      winnerChain.push({ parent, message, child });
    }
    const winnerTip = await this.#tree.stateAt(winnerTipTag);
    if (!winnerTip) return undefined;

    // D-04/D-09: re-derive and re-validate every link's commit legality
    // before adopting this winner chain, so a persisted tree edge written by
    // a pre-upgrade build (before this gate existed) is never grandfathered
    // in. Fail closed on any link.
    for (const link of winnerChain) {
      const childTag = bytesToHex(link.child.confirmationTag);
      // Commit messages are framed (private or public); anything else stored
      // against a chain link cannot be replayed — fail closed.
      if (
        link.message.wireformat !== wireformats.mls_private_message &&
        link.message.wireformat !== wireformats.mls_public_message
      ) {
        this.#log()(
          "tree-fed re-convergence: abandoning winner chain — link %s has a non-framed stored message",
          childTag,
        );
        return undefined;
      }
      const stamp = await this.#tree.ownCommitStampOf(childTag);
      const parentResolution = await resolveCandidateParent({
        ciphersuite: this.ciphersuite,
        parent: link.parent,
        message: link.message as MlsFramedMessage,
        callback: this.#createAdminVerificationCallback(link.parent),
        known: stamp
          ? {
              parentTag: bytesToHex(link.parent.confirmationTag),
              state: link.child,
            }
          : undefined,
      });
      if (parentResolution.kind !== "resolved") {
        this.#log()(
          "tree-fed re-convergence: deferring winner chain — link %s parent resolution:%s",
          childTag,
          parentResolution.kind,
        );
        return undefined;
      }
      const replayed = parentResolution.result;

      if (
        bytesToHex(replayed.newState.confirmationTag) !==
        bytesToHex(link.child.confirmationTag)
      ) {
        this.#log()(
          "tree-fed re-convergence: abandoning winner chain — link %s replayed to a different confirmationTag than the stored snapshot",
          childTag,
        );
        return undefined;
      }
    }

    return {
      outcome: "recovered",
      winnerTip,
      winnerChain,
      edges: [],
      result: {
        kind: "newState",
        newState: winnerTip,
        actionTaken: "accept",
        consumed: [],
        aad: new Uint8Array(),
      },
    };
  }

  /**
   * Gathers app-payload witnesses for each tree candidate branch by re-decrypting
   * `witnessEnvelopes` against the states on the branch path above the shared fork
   * root, filtered to the convergence-eligible window (`convergence.md`). Keyed by
   * candidate tip tag.
   */
  async #gatherTreeWitnesses(
    set: TreeBranchSet,
    witnessEnvelopes: TEnvelope[],
  ): Promise<Map<string, AppWitness[]>> {
    const forkEpoch = this.#tree.epochOf(set.rootTag) ?? 0;
    const callback = this.#createAdminVerificationCallback();
    const byTip = new Map<string, AppWitness[]>();
    for (const candidate of set.candidates) {
      const path = this.#tree.path(candidate.id);
      const rootIndex = path?.indexOf(set.rootTag) ?? -1;
      if (!path || rootIndex < 0) {
        byTip.set(candidate.id, []);
        continue;
      }
      const witnesses: AppWitness[] = [];
      // States strictly after the fork root — a witness must decrypt past it.
      for (const tag of path.slice(rootIndex + 1)) {
        const state = await this.#tree.stateAt(tag);
        if (!state) continue;
        for (const witness of await collectWitnessesAt({
          peeler: this.peeler,
          ciphersuite: this.ciphersuite,
          state,
          witnessEnvelopes,
          callback,
        }))
          if (
            isWitnessEligible(
              witness,
              forkEpoch,
              candidate.tipEpoch,
              this.#policy,
            )
          )
            witnesses.push(witness);
      }
      byTip.set(candidate.id, witnesses);
    }
    return byTip;
  }

  #createAdminVerificationCallback(
    state: ClientState = this.state,
  ): IncomingMessageCallback {
    const groupData = getMarmotGroupView(state);
    if (!groupData) return acceptAll;

    return createAdminCommitPolicyCallback({
      ratchetTree: state.ratchetTree,
      adminPubkeys: groupData.adminPubkeys,
      ciphersuiteId: this.ciphersuite.id,
      onUnverifiableCommit: "retry",
    });
  }
}

function finiteAuditNumber(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function auditSendIntentKind(intent: SendIntent): string {
  switch (intent.kind) {
    case "applicationMessage":
      return "app_message";
    case "proposal":
      return "proposal";
    case "commit":
      return "group_evolution";
    case "selfUpdate":
      return "self_update";
  }
}

function auditSendResultKind<TEnvelope>(result: SendResult<TEnvelope>): string {
  switch (result.kind) {
    case "applicationMessage":
      return "application_message";
    case "proposal":
      return "proposal";
    case "groupEvolution":
      return "group_evolution";
    case "selfUpdate":
      return "self_update";
  }
}

function auditIngestOutcome<TEnvelope>(
  result: DispositionedIngestResult<TEnvelope>,
): { kind: string; staleReason?: string } | undefined {
  switch (result.disposition.kind) {
    case "accepted":
      return { kind: "processed" };
    case "deferred":
      return { kind: "buffered" };
    case "stale":
      return { kind: "stale", staleReason: auditStaleReason(result) };
    case "invalidated":
      return undefined;
  }
}

function auditStaleReason<TEnvelope>(
  result: DispositionedIngestResult<TEnvelope>,
): string | undefined {
  switch (result.kind) {
    case "skipped":
      return result.reason;
    case "unreadable":
      return result.decryptFailure ? "decrypt_failed" : "unreadable";
    case "rejected":
      return "rejected";
    case "removed":
      return "removed";
    case "processed":
    case "deferred":
    case "invalidated":
    case "autoCommit":
    case "appliedNotifications":
    case "stateInvalidated":
      return undefined;
  }
}

function auditResultEpoch<TEnvelope>(
  result: DispositionedIngestResult<TEnvelope>,
): number | undefined {
  switch (result.kind) {
    case "invalidated":
      return result.epoch;
    case "stateInvalidated":
      return result.forkEpoch;
    case "appliedNotifications":
      return undefined;
    case "deferred":
    case "processed":
    case "rejected":
    case "skipped":
    case "unreadable":
    case "autoCommit":
    case "removed":
      return undefined;
  }
}
