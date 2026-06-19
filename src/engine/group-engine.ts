/** @module @category Engine */
import { bytesToHex } from "@noble/hashes/utils.js";
import { Debugger } from "debug";
import {
  CiphersuiteImpl,
  ClientState,
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
  canTransitionLifecycle,
  type GroupLifecycleState,
  groupLifecycleStates,
  mayPrepareLocalCommit,
  transitionLifecycle,
} from "../core/group-lifecycle.js";
import { logger } from "../utils/debug.js";
import { createAdminCommitPolicyCallback } from "./admin-policy.js";
import { DeliveredPayloadLedger } from "./delivered-payloads.js";
import { ForkRecovery } from "./fork-recovery.js";
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
  PendingState,
  ProposalContext,
  SendIntent,
  SendResult,
} from "./types.js";

export type MarmotGroupEngineOptions<TEnvelope> = {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  peeler: GroupPeeler<TEnvelope>;
  onStateChanged?: (state: ClientState) => void;
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
  /** Convergence candidate-branch construction and selection. */
  readonly #forkRecovery: ForkRecovery<TEnvelope>;
  /** App payloads delivered eagerly, retracted as `invalidated` on rewind (M7). */
  readonly #delivered = new DeliveredPayloadLedger<TEnvelope>();

  readonly #onStateChanged?: (state: ClientState) => void;
  private log: Debugger;

  constructor(options: MarmotGroupEngineOptions<TEnvelope>) {
    this.#state = options.state;
    this.ciphersuite = options.ciphersuite;
    this.peeler = options.peeler;
    this.#onStateChanged = options.onStateChanged;

    this.#retained = new RetainedHistoryStore(options.state);
    this.#forkRecovery = new ForkRecovery(options.ciphersuite, options.peeler);

    const idStr = bytesToHex(options.state.groupContext.groupId);
    this.log = logger.extend(`group-engine:${idStr.slice(0, 8)}`);
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
      this.#retained.record(
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
    for await (const result of ingestEnvelopes(
      this.#ingestContext(),
      envelopes,
      options,
    )) {
      yield {
        ...result,
        disposition: ingestResultDisposition(result),
      };
    }

    // After the batch, if this client is the deterministically-elected committer
    // for any pending self_remove proposals, build and stage a self_remove-only
    // commit (B6, member-departure.md). It is surfaced as an `autoCommit` result;
    // the layer that owns the transport publishes it (publish-before-apply).
    const auto = await this.#maybeAutoCommitSelfRemoves();
    if (auto) yield { ...auto, disposition: ingestResultDisposition(auto) };
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

    this.log(
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

  /** The dependency surface the ingest pipeline drives. */
  #ingestContext(): IngestContext<TEnvelope> {
    return {
      ciphersuite: this.ciphersuite,
      peeler: this.peeler,
      retained: this.#retained,
      log: this.log,
      getState: () => this.#state,
      setState: (state) => this.#setState(state),
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
