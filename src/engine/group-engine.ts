/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { Debugger } from "debug";
import {
  CiphersuiteImpl,
  ClientState,
  contentTypes,
  createApplicationMessage,
  createCommit,
  CreateCommitOptions,
  createProposal,
  defaultProposalTypes,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  isSelfRemoveProposal,
  acceptAll,
  type LeafIndex,
  nodeTypes,
  Proposal,
  selfRemoveProposalType,
} from "ts-mls";

import { marmotAuthService } from "../core/auth-service.js";
import { getMarmotGroupView } from "../core/client-state.js";
import { getCredentialPubkey } from "../core/credential.js";
import { decideAutoCommit } from "./auto-committer.js";
import {
  type ConvergenceStatus,
  deriveConvergenceStatus,
} from "../core/convergence-status.js";
import { DEFAULT_CONVERGENCE_POLICY } from "../core/convergence.js";
import {
  canTransitionLifecycle,
  type GroupLifecycleState,
  groupLifecycleStates,
  mayPrepareLocalCommit,
  transitionLifecycle,
} from "../core/group-lifecycle.js";
import { framedContentType } from "./wire-format.js";
import { logger } from "../utils/debug.js";
import { createAdminCommitPolicyCallback } from "./admin-policy.js";
import { DeliveredPayloadLedger } from "./delivered-payloads.js";
import { ForkRecovery } from "./fork-recovery.js";
import { GroupHistoryTree } from "./history-tree.js";
import {
  type AppliedForkResolution,
  type IngestContext,
  ingestEnvelopes,
} from "./ingest.js";
import { ingestResultDisposition } from "./ingest-disposition.js";
import { RetainedHistoryStore } from "./retained-store.js";
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
   * A pre-populated retained-history store, rehydrated from persistence so the
   * rewind window survives a restart. When omitted the store is seeded with only
   * the current tip (no past-epoch rewind until new commits accrue).
   */
  retained?: RetainedHistoryStore;
  /**
   * A pre-populated full-fork history tree, rehydrated from persistence. When
   * omitted the tree is seeded with the current tip as its root and grows as
   * commits arrive.
   */
  historyTree?: GroupHistoryTree;
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

  /** Retained canonical states + applied commits for fork recovery. */
  readonly #retained: RetainedHistoryStore;
  /** Full-fork history tree: every observed state (canonical + every fork). */
  readonly #tree: GroupHistoryTree;
  /** Convergence candidate-branch construction and selection. */
  readonly #forkRecovery: ForkRecovery<TEnvelope>;
  /** App payloads delivered eagerly, retracted as `invalidated` on rewind (M7). */
  readonly #delivered = new DeliveredPayloadLedger<TEnvelope>();

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

    this.#retained =
      options.retained ?? new RetainedHistoryStore(options.state);
    this.#tree = options.historyTree ?? new GroupHistoryTree(options.state);
    this.#forkRecovery = new ForkRecovery(options.ciphersuite, options.peeler);
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
   * Records an applied commit into both retained history and the history tree.
   * The freshly-produced `newState` is captured pristine; a tree hiccup (e.g. a
   * parent not yet present) is logged and never breaks protocol processing.
   */
  #recordCommitNode(
    parentState: ClientState,
    message: Parameters<RetainedHistoryStore["record"]>[1],
    newState: ClientState,
  ): void {
    this.#retained.record(parentState, message, newState);
    try {
      const parentTag = bytesToHex(parentState.confirmationTag);
      if (!this.#tree.hasNode(parentTag)) this.#tree.setRoot(parentState);
      this.#tree.recordCommit(parentTag, message, newState);
    } catch (error) {
      this.#log()("history tree recordCommit failed: %o", error);
    }
  }

  get state(): ClientState {
    return this.#state;
  }

  set state(newState: ClientState) {
    this.#setState(newState);
  }

  /**
   * Serializes the retained-history rewind window for persistence (states +
   * applied commits, bounded to the rollback horizon). Pair with
   * {@link MarmotGroupEngineOptions.retained} to restore it on reload.
   */
  serializeRetained(): Uint8Array {
    return this.#retained.serialize();
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
        this.#setState(newState);
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

        const selectedProposals: Proposal[] = [];
        if (intent.proposalRefs) {
          for (const ref of intent.proposalRefs) {
            const proposalWithSender = this.state.unappliedProposals[ref];
            if (!proposalWithSender) {
              throw new Error(
                `Proposal reference not found in unappliedProposals: ${ref}`,
              );
            }
            selectedProposals.push(proposalWithSender.proposal);
          }
        }

        const allProposals = [...newProposals, ...selectedProposals];

        // MIP-03 admin-only commits, with the non-admin carve-out from
        // protocol-core/group-messaging.md: a non-admin may commit a
        // self-update-only commit (no proposals, or only self-targeted Update
        // proposals — an Update can only target the committer's own leaf) or a
        // self_remove-only commit (committing peers' departures — this is the
        // auto-committer path). Anything that changes other members or group
        // state needs admin. This mirrors the inbound admin policy
        // (admin-policy.ts) so a commit we emit is one a conformant peer accepts.
        if (!groupData.adminPubkeys.includes(intent.actorPubkey)) {
          const selfUpdateOnly = allProposals.every(
            (p) => p.proposalType === defaultProposalTypes.update,
          );
          const selfRemoveOnly =
            allProposals.length > 0 &&
            allProposals.every(
              (p) => p.proposalType === selfRemoveProposalType,
            );
          if (!selfUpdateOnly && !selfRemoveOnly) {
            throw new Error(
              "Not a group admin. Non-admins may only commit a self-update-only or self_remove-only commit.",
            );
          }
        }

        const commitOptions: CreateCommitOptions = {
          // Handshake content is wired as MLS PublicMessage (see wire-format.ts).
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
        };

        if (intent.extraProposals || intent.proposalRefs) {
          commitOptions.extraProposals = allProposals;
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

        this.#lifecycle = transitionLifecycle(
          this.#lifecycle,
          groupLifecycleStates.pendingPublish,
        );

        const envelope = await this.peeler.wrapGroupMessage(commit, this.state);

        return {
          kind: "groupEvolution",
          envelope,
          welcome,
          pending: {
            kind: "commit",
            newState,
            parentState,
            commitMessage: commit,
          },
        };
      }

      case "selfUpdate": {
        const { commit, newState } = await createCommit({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
          },
          state: this.state,
          // Handshake content is wired as MLS PublicMessage (see wire-format.ts).
          wireAsPublicMessage: true,
          ratchetTreeExtension: true,
          extraProposals: [],
        });

        const envelope = await this.peeler.wrapGroupMessage(commit, this.state);

        return {
          kind: "selfUpdate",
          envelope,
          pending: { kind: "selfUpdate", newState },
        };
      }
    }
  }

  /** Applies staged state after publish confirmation (publish-before-apply). */
  confirmPublished(pending: PendingState): void {
    if (pending.kind === "commit") {
      if (!pending.parentState || !pending.commitMessage) {
        throw new Error(
          "Commit pending state requires parentState and commitMessage",
        );
      }

      this.#lifecycle = transitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.merging,
      );
      this.#setState(pending.newState);
      this.#recordCommitNode(
        pending.parentState,
        pending.commitMessage,
        pending.newState,
      );
      this.#lifecycle = transitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.stable,
      );
      return;
    }

    this.#setState(pending.newState);
  }

  /** Reverts lifecycle when a staged commit publish fails or is abandoned. */
  publishFailed(pending: PendingState): void {
    if (pending.kind !== "commit") return;
    if (this.#lifecycle !== groupLifecycleStates.pendingPublish) return;
    this.#lifecycle = transitionLifecycle(
      this.#lifecycle,
      groupLifecycleStates.stable,
    );
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

    for await (const result of ingestEnvelopes(
      this.#ingestContext(),
      envelopes,
      options,
    )) {
      if (this.#isConvergenceRelevant(result)) convergenceRelevant = true;
      if (result.kind === "deferred") unresolved = true;
      if (
        result.kind === "skipped" &&
        result.reason === "missing-retained-anchor"
      )
        blocked = true;

      yield {
        ...result,
        disposition: ingestResultDisposition(result),
      };
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
    if (auto) yield { ...auto, disposition: ingestResultDisposition(auto) };
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
      case "skipped":
        return (
          result.reason === "past-epoch" ||
          result.reason === "beyond-anchor" ||
          result.reason === "missing-retained-anchor"
        );
      case "autoCommit":
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
      log: this.#log(),
      getState: () => this.#state,
      setState: (state) => this.#setState(state),
      recordCommit: (parentState, message, newState) =>
        this.#recordCommitNode(parentState, message, newState),
      recordProposalStaged: (state) => {
        try {
          const tag = bytesToHex(state.confirmationTag);
          if (this.#tree.hasNode(tag)) this.#tree.updateSnapshot(tag, state);
        } catch (error) {
          this.#log()("history tree recordProposalStaged failed: %o", error);
        }
      },
      createAdminCallback: () => this.#createAdminVerificationCallback(),
      resolveFork: (forkEpoch, pool, encrypted, witnessEnvelopes) =>
        this.#resolveFork(forkEpoch, pool, encrypted, witnessEnvelopes),
      recordDeliveredAppPayload: (epoch, stateTag, envelope, message) => {
        this.#delivered.record({ epoch, stateTag, envelope, message });
        const anchor = this.#retained.anchorEpoch();
        if (anchor !== undefined) this.#delivered.pruneBelow(anchor);
      },
      toUnrecoverable: () => this.#toUnrecoverable(),
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
      this.#lifecycle = transitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.recovering,
      );
    if (
      canTransitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.unrecoverable,
      )
    )
      this.#lifecycle = transitionLifecycle(
        this.#lifecycle,
        groupLifecycleStates.unrecoverable,
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
      return { outcome: resolution.outcome };
    }

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

    this.#lifecycle = transitionLifecycle(
      this.#lifecycle,
      groupLifecycleStates.recovering,
    );
    this.#setState(resolution.winnerTip);
    for (const link of resolution.winnerChain) {
      this.#retained.record(link.parent, link.message, link.child);
    }
    this.#lifecycle = transitionLifecycle(
      this.#lifecycle,
      groupLifecycleStates.stable,
    );

    const anchor = this.#retained.anchorEpoch();
    if (anchor !== undefined) this.#delivered.pruneBelow(anchor);

    return {
      outcome: "recovered",
      result: resolution.result,
      invalidated: invalidated.map(({ envelope, message }) => ({
        envelope,
        message,
      })),
    };
  }

  #createAdminVerificationCallback(): IncomingMessageCallback {
    const groupData = getMarmotGroupView(this.state);
    if (!groupData) return acceptAll;

    return createAdminCommitPolicyCallback({
      ratchetTree: this.state.ratchetTree,
      adminPubkeys: groupData.adminPubkeys,
      ciphersuiteId: this.ciphersuite.id,
      onUnverifiableCommit: "retry",
    });
  }
}
