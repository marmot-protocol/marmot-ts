/** @module @category Client - Session */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { CiphersuiteImpl, ClientState, Proposal } from "ts-mls";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  getMarmotGroupView,
  serializeClientState,
  type MarmotGroupView,
  type SerializedClientState,
} from "../../core/client-state.js";
import type { ConvergencePolicy } from "../../core/convergence.js";
import type { Disposition } from "../../core/inbound.js";
import type { AuditContextOptions, AuditSink } from "../../audit/index.js";
import type { IngestionPoolOptions } from "../../engine/ingestion-pool.js";
import { MarmotGroupEngine } from "../../engine/group-engine.js";
import { GroupHistoryTree } from "../../engine/history-tree.js";
import type { RetainedHistoryStore } from "../../engine/retained-store.js";
import { ingestResultDisposition as engineIngestResultDisposition } from "../../engine/ingest-disposition.js";
import type {
  DispositionedIngestResult as EngineDispositionedIngestResult,
  IngestResult as EngineIngestResult,
  PendingState,
  ProposalContext,
} from "../../engine/types.js";
import type { StateNotification } from "../../engine/state-notifications.js";
import type { GenericKeyValueStore } from "../../utils/key-value.js";
import { NostrGroupPeeler } from "../group/nostr-peeler.js";
import { TerminalWrapperLedger } from "../group/wrapper-ledger.js";
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

export type IngestResult = SessionIngestResult<EngineIngestResult<NostrEvent>>;

export type DispositionedIngestResult = IngestResult & {
  disposition: Disposition;
};

export interface GroupSessionHistory {
  saveMessage(message: Uint8Array): Promise<void>;
  purgeMessages(): Promise<void>;
}

export type GroupSessionOptions<
  THistory extends GroupSessionHistory | undefined = undefined,
> = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  store: GenericKeyValueStore<SerializedClientState>;
  ingestStateStore?: GenericKeyValueStore<Uint8Array>;
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
   * Defaults to the profile-1 policy; set `maxRewindCommits: Infinity` to retain
   * forks of any age for re-convergence.
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
    result.kind === "appliedNotifications"
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
    result.kind === "appliedNotifications"
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
  readonly #removedMarkerStore?: GenericKeyValueStore<boolean>;
  readonly history: THistory;

  readonly #engine: MarmotGroupEngine<NostrEvent>;
  readonly #peeler: NostrGroupPeeler;
  readonly #sentEventIds = new Set<string>();
  readonly #wrapperLedger?: TerminalWrapperLedger;

  #groupData: MarmotGroupView | null = null;
  #dirty = false;

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
    this.#removedMarkerStore = options.removedMarkerStore;
    this.history = options.history as THistory;
    this.#onStateChanged = options.onStateChanged;
    this.#onStateSaved = options.onStateSaved;
    this.#onApplicationMessage = options.onApplicationMessage;
    this.#onHistoryError = options.onHistoryError;
    this.#onHistoryChanged = options.onHistoryChanged;

    this.#peeler = new NostrGroupPeeler(this.ciphersuite);
    if (this.ingestStateStore)
      this.#wrapperLedger = new TerminalWrapperLedger(
        this.ingestStateStore,
        bytesToHex(options.state.groupContext.groupId),
      );
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
      onSettleCheck: options.onSettleCheck,
      audit: options.audit,
      auditContext: options.auditContext,
      onStateChanged: (newState) => {
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

  get unappliedProposals() {
    return this.state.unappliedProposals;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  async save(force = false): Promise<void> {
    // The history tree can grow without the canonical state changing — a fork
    // whose incoming branch is superseded still records the losing branch — so
    // a dirty tree must trigger a save even when `#dirty` (state-changed) is not.
    const treeDirty = !!this.rewindStore && this.#engine.history.isDirty;
    if (!force && !this.#dirty && !treeDirty) return;

    const idHex = bytesToHex(this.id);
    const stateBytes = serializeClientState(this.state);
    await this.store.setItem(idHex, stateBytes);
    // Persist the full-fork history tree — the single source for fork recovery
    // across restarts. Append-only flush of any new nodes (O(new nodes)). The
    // bounded convergence window is rebuilt from the tree on load.
    if (this.rewindStore) await this.#engine.history.flush();
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
    const results = (await this.#engine.reconvergeFromHistory()).map(
      mapEngineIngestResult,
    );
    await this.save();
    return results;
  }

  async destroyLocalState(): Promise<void> {
    await this.history?.purgeMessages();
    const idHex = bytesToHex(this.id);
    await this.#removedMarkerStore?.removeItem(`${idHex}/removed`);
    await this.store.removeItem(idHex);
    if (this.rewindStore) await GroupHistoryTree.purge(this.rewindStore, idHex);
  }

  /** Releases engine resources (the settle-check timer); call on teardown (B5). */
  dispose(): void {
    this.#engine.dispose();
  }

  confirmPublished(pending: PendingState): StateNotification[] {
    const historySizeBefore = this.#engine.history.size;
    const notifications = this.#engine.confirmPublished(pending);
    if (this.#engine.history.size !== historySizeBefore)
      this.#onHistoryChanged?.();
    return notifications;
  }

  publishFailed(pending: PendingState): void {
    this.#engine.publishFailed(pending);
  }

  proposalContext(): ProposalContext {
    const groupData = this.groupData;
    if (!groupData)
      throw new Error("MarmotGroupData not found in ClientState.");
    return { state: this.state, ciphersuite: this.ciphersuite, groupData };
  }

  async send(intent: GroupSessionSendIntent): Promise<GroupEffects> {
    switch (intent.kind) {
      case "applicationMessage": {
        const sendResult = await this.#engine.send({
          kind: "applicationMessage",
          payload: intent.payload,
        });
        this.#sentEventIds.add(sendResult.envelope.id);
        await this.#saveHistory(intent.payload);
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
        const sendResult = await this.#engine.send({
          kind: "commit",
          actorPubkey: intent.actorPubkey,
          extraProposals: intent.extraProposals,
          proposalRefs: intent.proposalRefs,
        });
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
            },
          ],
        };
      }
    }
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
    const removeProposals = await proposeLeaveGroup(ownPubkey)(
      this.proposalContext(),
    );

    const publish: GroupPublishWork[] = [];
    for (const proposal of removeProposals) {
      const sendResult = await this.#engine.send({
        kind: "proposal",
        proposal,
      });
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
    const selfEcho: NostrEvent[] = [];
    const rest: NostrEvent[] = [];

    for (const event of events) {
      if (await this.#wrapperLedger?.get(event.id)) continue;
      if (this.#sentEventIds.delete(event.id)) selfEcho.push(event);
      else rest.push(event);
    }

    for (const event of selfEcho) {
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
        await this.#wrapperLedger?.record(event.id, "stale");
        yield { ...skipped, disposition };
      }
    }

    for await (const result of this.#engine.ingest(rest, options)) {
      const mapped = mapEngineIngestResult(result);

      if (
        mapped.kind === "processed" &&
        mapped.result.kind === "applicationMessage"
      ) {
        await this.#saveHistory(mapped.result.message);
        this.#onApplicationMessage?.(mapped.result.message);
      }

      const retryableUnreadable =
        mapped.kind === "unreadable" && mapped.decryptFailure === true;
      if (
        "event" in mapped &&
        mapped.disposition.kind !== "deferred" &&
        !retryableUnreadable
      ) {
        await this.#wrapperLedger?.record(
          mapped.event.id,
          mapped.disposition.kind === "accepted"
            ? "accepted"
            : mapped.disposition.kind === "invalidated"
              ? "invalidated"
              : "stale",
        );
      }
      yield mapped;
    }

    await this.save();
  }

  async #saveHistory(message: Uint8Array): Promise<void> {
    if (!this.history) return;
    try {
      await this.history.saveMessage(message);
    } catch (err) {
      this.#onHistoryError?.(err as Error);
    }
  }
}

export type ProposalBuilder<
  Args extends unknown[],
  T extends Proposal | Proposal[],
> = (...args: Args) => import("../../engine/types.js").ProposalAction<T>;
