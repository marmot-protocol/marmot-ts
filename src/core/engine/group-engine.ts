/** @module @category Core - Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { Debugger } from "debug";
import {
  acceptAll,
  CiphersuiteImpl,
  ClientState,
  contentTypes,
  createApplicationMessage,
  createCommit,
  CreateCommitOptions,
  createProposal,
  encode,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  type LeafIndex,
  mlsMessageEncoder,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  Proposal,
  wireformats,
} from "ts-mls";

import { marmotAuthService } from "../auth-service.js";
import { getMarmotGroupView } from "../client-state.js";
import { getCredentialPubkey } from "../credential.js";
import {
  type AppWitness,
  type BranchCandidate,
  commitDigest,
  compareCommitOrderingKeys,
  DEFAULT_CONVERGENCE_POLICY,
  selectCanonicalBranch,
  type CommitOrderingKey,
} from "../convergence.js";
import {
  canTransitionLifecycle,
  type GroupLifecycleState,
  groupLifecycleStates,
  mayPrepareLocalCommit,
  transitionLifecycle,
} from "../group-lifecycle.js";
import { classifyLateCommit } from "../retained-history.js";
import { logger } from "../../utils/debug.js";
import { createAdminCommitPolicyCallback } from "./admin-policy.js";
import { ingestResultDisposition } from "./ingest-disposition.js";
import type {
  DispositionedIngestResult,
  GroupPeeler,
  IngestResult,
  PendingState,
  PeeledMessagePair,
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
 */
export class MarmotGroupEngine<TEnvelope> {
  readonly ciphersuite: CiphersuiteImpl;
  readonly peeler: GroupPeeler<TEnvelope>;

  #state: ClientState;
  /** Group lifecycle state (group-state.md); only `Stable` may prepare a commit. */
  #lifecycle: GroupLifecycleState = groupLifecycleStates.stable;

  /**
   * Retained canonical states keyed by epoch number, used to rebuild candidate
   * branches for fork recovery (retained-history.md). Bounded to the rollback
   * horizon. Holds the state *at* each epoch (its parent for the next commit).
   */
  readonly #retainedStates = new Map<number, ClientState>();
  /**
   * The commit message applied to advance *from* each source epoch on our
   * current canonical branch, retained (within the rollback horizon) so the
   * branch can be rebuilt and re-scored against competing commits during
   * convergence fork resolution (convergence.md "Candidate branches").
   */
  readonly #appliedCommitMessages = new Map<number, MlsMessage>();

  /** The reached tip state for a candidate branch. */
  #branchTip = new WeakMap<BranchCandidate, ClientState>();
  /** The applied (parent, message, child) chain for a candidate branch. */
  #branchChain = new WeakMap<
    BranchCandidate,
    { parent: ClientState; message: MlsMessage; child: ClientState }[]
  >();

  readonly #onStateChanged?: (state: ClientState) => void;
  private log: Debugger;

  constructor(options: MarmotGroupEngineOptions<TEnvelope>) {
    this.#state = options.state;
    this.ciphersuite = options.ciphersuite;
    this.peeler = options.peeler;
    this.#onStateChanged = options.onStateChanged;

    this.#retainedStates.set(
      Number(options.state.groupContext.epoch),
      options.state,
    );

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
          wireAsPublicMessage: false,
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
        if (!groupData.adminPubkeys.includes(intent.actorPubkey)) {
          throw new Error("Not a group admin. Cannot commit proposals.");
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

        const commitOptions: CreateCommitOptions = {
          wireAsPublicMessage: false,
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

        const envelope = await this.peeler.wrapGroupMessage(
          commit,
          this.state,
        );

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
          wireAsPublicMessage: false,
          ratchetTreeExtension: true,
          extraProposals: [],
        });

        const envelope = await this.peeler.wrapGroupMessage(
          commit,
          this.state,
        );

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
      this.#retainAppliedCommit(
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
    for await (const result of this.#ingestRaw(envelopes, options)) {
      yield {
        ...result,
        disposition: ingestResultDisposition(result),
      };
    }
  }

  /** The `commit_digest` (SHA-256 of the MLS message bytes) for a commit. */
  #commitDigestOf(message: MlsMessage): Uint8Array {
    return commitDigest(encode(mlsMessageEncoder, message));
  }

  #setState(newState: ClientState): void {
    this.#state = newState;
    this.#onStateChanged?.(newState);
  }

  #envelopeLabel(envelope: TEnvelope): string {
    if (
      envelope &&
      typeof envelope === "object" &&
      "id" in envelope &&
      typeof (envelope as { id: unknown }).id === "string"
    ) {
      return (envelope as { id: string }).id.slice(0, 8);
    }
    return "?";
  }

  /**
   * Records the retained parent state and the applied commit message after
   * advancing an epoch, then prunes retained material beyond the rollback
   * horizon (retained-history.md).
   */
  #retainAppliedCommit(
    parentState: ClientState,
    appliedMessage: MlsMessage,
    newState: ClientState,
  ): void {
    const parentEpoch = Number(parentState.groupContext.epoch);
    const newEpoch = Number(newState.groupContext.epoch);
    this.#retainedStates.set(parentEpoch, parentState);
    this.#retainedStates.set(newEpoch, newState);
    this.#appliedCommitMessages.set(parentEpoch, appliedMessage);

    const floor = newEpoch - DEFAULT_CONVERGENCE_POLICY.maxRewindCommits;
    for (const epoch of this.#retainedStates.keys())
      if (epoch < floor) this.#retainedStates.delete(epoch);
    for (const epoch of this.#appliedCommitMessages.keys())
      if (epoch < floor) this.#appliedCommitMessages.delete(epoch);
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
   * Builds every candidate branch reachable by replaying the commit `pool` from
   * the retained `root` state (convergence.md "Candidate branches").
   */
  async #buildBranches(
    root: ClientState,
    pool: MlsMessage[],
    encrypted: TEnvelope[] = [],
    witnessEnvelopes: TEnvelope[] = [],
  ): Promise<BranchCandidate[]> {
    const forkEpoch = Number(root.groupContext.epoch);
    const branches: BranchCandidate[] = [];
    const callback = this.#createAdminVerificationCallback();
    let counter = 0;

    const witnessesAt = async (state: ClientState): Promise<AppWitness[]> => {
      const epoch = Number(state.groupContext.epoch);
      const out: AppWitness[] = [];
      for (const envelope of witnessEnvelopes) {
        try {
          const decrypted = await this.peeler.peelGroupMessages(
            [envelope],
            state,
          );
          for (const pair of decrypted.read) {
            if (pair.message.wireformat !== wireformats.mls_private_message)
              continue;
            const r = await processMessage({
              context: {
                cipherSuite: this.ciphersuite,
                authService: marmotAuthService,
                externalPsks: {},
              },
              state,
              message: pair.message,
              callback,
            });
            if (
              r.kind === "applicationMessage" &&
              r.senderLeafIndex !== undefined
            ) {
              const credential = getCredentialFromLeafIndex(
                state.ratchetTree,
                r.senderLeafIndex as LeafIndex,
              );
              out.push({
                epoch,
                sender: hexToBytes(getCredentialPubkey(credential)),
              });
            }
          }
        } catch {
          /* not a witness on this state */
        }
      }
      return out;
    };

    const candidatesAt = async (state: ClientState): Promise<MlsMessage[]> => {
      const epoch = Number(state.groupContext.epoch);
      const out: MlsMessage[] = [];
      const seenDigests = new Set<string>();
      const add = (m: MlsMessage) => {
        if (
          m.wireformat !== wireformats.mls_private_message ||
          Number(m.privateMessage.epoch) !== epoch
        )
          return;
        const d = bytesToHex(this.#commitDigestOf(m));
        if (!seenDigests.has(d)) {
          seenDigests.add(d);
          out.push(m);
        }
      };
      for (const m of pool) add(m);
      for (const envelope of encrypted) {
        try {
          const r = await this.peeler.peelGroupMessages([envelope], state);
          for (const pair of r.read) add(pair.message);
        } catch {
          /* not decryptable under this state */
        }
      }
      return out;
    };

    type ChainLink = {
      parent: ClientState;
      message: MlsMessage;
      child: ClientState;
    };
    const explore = async (
      state: ClientState,
      tipMessage: MlsMessage | undefined,
      seen: ReadonlySet<string>,
      chain: ChainLink[],
      witnesses: AppWitness[],
    ): Promise<void> => {
      const accumulated = [...witnesses, ...(await witnessesAt(state))];
      let extended = false;
      for (const message of await candidatesAt(state)) {
        if (message.wireformat !== wireformats.mls_private_message) continue;
        let next: ProcessMessageResult;
        try {
          next = await processMessage({
            context: {
              cipherSuite: this.ciphersuite,
              authService: marmotAuthService,
              externalPsks: {},
            },
            state,
            message,
            callback,
          });
        } catch {
          continue;
        }
        if (next.kind !== "newState" || next.actionTaken === "reject") continue;
        const tag = bytesToHex(next.newState.confirmationTag);
        if (seen.has(tag)) continue;
        extended = true;
        await explore(
          next.newState,
          message,
          new Set([...seen, tag]),
          [...chain, { parent: state, message, child: next.newState }],
          accumulated,
        );
      }
      if (!extended && tipMessage !== undefined) {
        const branch: BranchCandidate = {
          id: `branch-${counter++}`,
          forkEpoch,
          tipEpoch: Number(state.groupContext.epoch),
          tipDigest: this.#commitDigestOf(tipMessage),
          appWitnesses: accumulated,
        };
        this.#branchTip.set(branch, state);
        this.#branchChain.set(branch, chain);
        branches.push(branch);
      }
    };

    await explore(
      root,
      undefined,
      new Set([bytesToHex(root.confirmationTag)]),
      [],
      [],
    );
    return branches;
  }

  /**
   * Resolves a fork at `forkEpoch` (convergence.md): rebuilds candidate branches
   * by replaying retained applied commits plus the competing `pool`, selects the
   * canonical branch, and rewinds if it differs from our current tip.
   */
  async #resolveFork(
    forkEpoch: number,
    pool: MlsMessage[],
    encrypted: TEnvelope[] = [],
    witnessEnvelopes: TEnvelope[] = [],
  ): Promise<
    | { outcome: "recovered"; result: ProcessMessageResult }
    | { outcome: "superseded" | "skip" }
  > {
    const root = this.#retainedStates.get(forkEpoch);
    if (!root) return { outcome: "skip" };

    const currentTipEpoch = Number(this.state.groupContext.epoch);
    const ours: MlsMessage[] = [];
    for (let e = forkEpoch; e < currentTipEpoch; e++) {
      const msg = this.#appliedCommitMessages.get(e);
      if (msg) ours.push(msg);
    }
    if (ours.length === 0) return { outcome: "skip" };

    const branches = await this.#buildBranches(
      root,
      [...ours, ...pool],
      encrypted,
      witnessEnvelopes,
    );
    if (branches.length === 0) return { outcome: "skip" };

    const winner = selectCanonicalBranch(
      currentTipEpoch,
      branches,
      DEFAULT_CONVERGENCE_POLICY,
    );
    const winnerTip = winner ? this.#branchTip.get(winner) : undefined;
    if (!winner || !winnerTip) return { outcome: "superseded" };

    if (
      bytesToHex(winnerTip.confirmationTag) ===
      bytesToHex(this.state.confirmationTag)
    )
      return { outcome: "superseded" };

    this.#lifecycle = transitionLifecycle(
      this.#lifecycle,
      groupLifecycleStates.recovering,
    );
    this.#setState(winnerTip);
    for (const link of this.#branchChain.get(winner) ?? []) {
      this.#retainAppliedCommit(link.parent, link.message, link.child);
    }
    this.#lifecycle = transitionLifecycle(
      this.#lifecycle,
      groupLifecycleStates.stable,
    );
    return {
      outcome: "recovered",
      result: {
        kind: "newState",
        newState: winnerTip,
        actionTaken: "accept",
        consumed: [],
        aad: new Uint8Array(),
      },
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

  #sortPeeledCommits(
    commits: PeeledMessagePair<TEnvelope>[],
  ): PeeledMessagePair<TEnvelope>[] {
    const keyed = commits.map((pair) => {
      const sourceEpoch =
        pair.message.wireformat === wireformats.mls_private_message
          ? Number(pair.message.privateMessage.epoch)
          : 0;
      const key: CommitOrderingKey = {
        sourceEpoch,
        commitDigest: commitDigest(encode(mlsMessageEncoder, pair.message)),
      };
      return { pair, key };
    });
    keyed.sort((a, b) => compareCommitOrderingKeys(a.key, b.key));
    return keyed.map((entry) => entry.pair);
  }

  async *#ingestRaw(
    envelopes: TEnvelope[],
    options?: {
      retryCount?: number;
      maxRetries?: number;
      _errors?: Array<{ envelope: TEnvelope; error: unknown }>;
    },
  ): AsyncGenerator<IngestResult<TEnvelope>> {
    const log = this.log.extend(`ingest:${Date.now().toString(36).slice(-5)}`);

    const retryCount = options?.retryCount ?? 0;
    const maxRetries = options?.maxRetries ?? 5;
    const errorList: Array<{ envelope: TEnvelope; error: unknown }> =
      options?._errors ?? [];

    if (retryCount === 0) {
      log("start – %d envelope(s), maxRetries=%d", envelopes.length, maxRetries);
    } else {
      log(
        "retry %d/%d – %d envelope(s) remaining",
        retryCount,
        maxRetries,
        envelopes.length,
      );
    }

    if (retryCount > maxRetries) {
      log(
        "max retries exceeded – yielding %d envelope(s) as unreadable",
        envelopes.length,
      );
      for (const envelope of envelopes) {
        yield {
          kind: "unreadable",
          envelope,
          errors: errorList
            .filter((e) => e.envelope === envelope)
            .map((e) => e.error),
        };
      }
      return;
    }

    if (envelopes.length === 0) return;

    let { read, unreadable: decryptFailed } =
      await this.peeler.peelGroupMessages(envelopes, this.state);

    if (decryptFailed.length > 0 && this.#retainedStates.size > 0) {
      const stillFailed: TEnvelope[] = [];
      for (const envelope of decryptFailed) {
        let recovered = false;
        for (const retained of this.#retainedStates.values()) {
          if (retained === this.state) continue;
          const retry = await this.peeler.peelGroupMessages(
            [envelope],
            retained,
          );
          if (retry.read.length > 0) {
            read = [...read, ...retry.read];
            recovered = true;
            break;
          }
        }
        if (!recovered) stillFailed.push(envelope);
      }
      decryptFailed = stillFailed;
    }

    log(
      "decryption: %d/%d readable, %d failed",
      read.length,
      envelopes.length,
      decryptFailed.length,
    );

    for (const envelope of decryptFailed) {
      log("decrypt failed envelope:%s", this.#envelopeLabel(envelope));
      errorList.push({
        envelope,
        error: new Error("Failed to decrypt group message"),
      });
    }

    if (read.length === 0) {
      log(
        "nothing readable – yielding %d decrypt failure(s) as unreadable",
        decryptFailed.length,
      );
      for (const envelope of decryptFailed) {
        yield {
          kind: "unreadable",
          envelope,
          errors: errorList
            .filter((e) => e.envelope === envelope)
            .map((e) => e.error),
        };
      }
      return;
    }

    const unreadable: TEnvelope[] = [...decryptFailed];

    let commits: PeeledMessagePair<TEnvelope>[] = [];
    const nonCommits: PeeledMessagePair<TEnvelope>[] = [];

    for (const pair of read) {
      if (
        pair.message.wireformat === wireformats.mls_private_message &&
        pair.message.privateMessage.contentType === contentTypes.commit
      ) {
        commits.push(pair);
      } else {
        nonCommits.push(pair);
      }
    }

    log(
      "split: %d commit(s), %d non-commit(s)",
      commits.length,
      nonCommits.length,
    );

    for (const { envelope, message } of nonCommits) {
      try {
        if (
          message.wireformat !== wireformats.mls_private_message &&
          message.wireformat !== wireformats.mls_public_message
        ) {
          log(
            "skip envelope:%s reason:wrong-wireformat",
            this.#envelopeLabel(envelope),
          );
          yield {
            kind: "skipped",
            envelope,
            message,
            reason: "wrong-wireformat",
          };
          continue;
        }

        const result = await processMessage({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          message,
          callback: acceptAll,
        });

        if (result.kind === "newState") {
          log(
            "proposal accepted envelope:%s epoch:%d",
            this.#envelopeLabel(envelope),
            this.state.groupContext.epoch,
          );
          this.#setState(result.newState);
          yield { kind: "processed", result, envelope, message };
        } else if (result.kind === "applicationMessage") {
          log(
            "application message envelope:%s",
            this.#envelopeLabel(envelope),
          );
          this.#setState(result.newState);
          yield { kind: "processed", result, envelope, message };
        }
      } catch (error) {
        log(
          "non-commit failed envelope:%s – queued for retry: %O",
          this.#envelopeLabel(envelope),
          error,
        );
        errorList.push({ envelope, error });
        unreadable.push(envelope);
      }
    }

    commits = this.#sortPeeledCommits(commits);

    const adminCallback = this.#createAdminVerificationCallback();

    const forkPool: {
      envelope: TEnvelope;
      message: MlsMessage;
      epoch: number;
    }[] = [];

    for (const { envelope, message } of commits) {
      if (message.wireformat !== wireformats.mls_private_message) {
        log(
          "skip commit envelope:%s reason:wrong-wireformat",
          this.#envelopeLabel(envelope),
        );
        yield {
          kind: "skipped",
          envelope,
          message,
          reason: "wrong-wireformat",
        };
        continue;
      }

      const commitEpoch =
        typeof message.privateMessage.epoch === "bigint"
          ? message.privateMessage.epoch
          : BigInt(message.privateMessage.epoch);
      const currentEpoch = this.state.groupContext.epoch;

      if (commitEpoch < currentEpoch) {
        forkPool.push({ envelope, message, epoch: Number(commitEpoch) });
        continue;
      }

      if (commitEpoch > currentEpoch + 1n) {
        log(
          "defer commit envelope:%s epoch:%d too far ahead (current=%d)",
          this.#envelopeLabel(envelope),
          commitEpoch,
          currentEpoch,
        );
        forkPool.push({ envelope, message, epoch: Number(commitEpoch) });
        errorList.push({
          envelope,
          error: new Error(
            `Commit epoch ${commitEpoch} is too far ahead of current epoch ${currentEpoch}`,
          ),
        });
        unreadable.push(envelope);
        continue;
      }

      log(
        "processing commit envelope:%s epoch:%d->%d",
        this.#envelopeLabel(envelope),
        currentEpoch,
        commitEpoch,
      );

      try {
        const result = await processMessage({
          context: {
            cipherSuite: this.ciphersuite,
            authService: marmotAuthService,
            externalPsks: {},
          },
          state: this.state,
          message,
          callback: adminCallback,
        });

        if (result.kind === "newState") {
          if (result.actionTaken === "reject") {
            log(
              "commit envelope:%s rejected by admin policy",
              this.#envelopeLabel(envelope),
            );
            yield { kind: "rejected", result, envelope, message };
            continue;
          }

          const parentState = this.state;
          this.#setState(result.newState);
          this.#retainAppliedCommit(parentState, message, result.newState);
          log(
            "commit envelope:%s applied – new epoch:%d",
            this.#envelopeLabel(envelope),
            this.state.groupContext.epoch,
          );
          yield { kind: "processed", result, envelope, message };
        }
      } catch (error) {
        log(
          "commit failed envelope:%s – queued for retry: %O",
          this.#envelopeLabel(envelope),
          error,
        );
        errorList.push({ envelope, error });
        unreadable.push(envelope);
      }
    }

    if (forkPool.length > 0) {
      const retainedPool = forkPool.filter((p) =>
        this.#retainedStates.has(p.epoch),
      );
      const orphanPool = forkPool.filter(
        (p) => !this.#retainedStates.has(p.epoch),
      );

      if (retainedPool.length > 0) {
        const minForkEpoch = Math.min(...retainedPool.map((p) => p.epoch));
        const resolution = await this.#resolveFork(
          minForkEpoch,
          retainedPool.map((p) => p.message),
          decryptFailed,
          envelopes,
        );
        if (resolution.outcome === "recovered") {
          log(
            "convergence rewound to canonical branch – epoch:%d",
            this.state.groupContext.epoch,
          );
          const rep = retainedPool[0];
          yield {
            kind: "processed",
            result: resolution.result,
            envelope: rep.envelope,
            message: rep.message,
          };
          for (let i = 1; i < retainedPool.length; i++)
            yield {
              kind: "skipped",
              envelope: retainedPool[i].envelope,
              message: retainedPool[i].message,
              reason: "past-epoch",
            };
        } else {
          for (const p of retainedPool)
            yield {
              kind: "skipped",
              envelope: p.envelope,
              message: p.message,
              reason: "past-epoch",
            };
        }
      }

      if (orphanPool.length > 0) {
        const currentTipEpoch = Number(this.state.groupContext.epoch);
        const anchorEpoch =
          this.#retainedStates.size > 0
            ? Math.min(...this.#retainedStates.keys())
            : currentTipEpoch;
        for (const p of orphanPool) {
          if (p.epoch >= currentTipEpoch) {
            yield {
              kind: "skipped",
              envelope: p.envelope,
              message: p.message,
              reason: "past-epoch",
            };
            continue;
          }
          const outcome = classifyLateCommit({
            sourceEpoch: p.epoch,
            anchorEpoch,
            currentTipEpoch,
            maxRewindCommits: DEFAULT_CONVERGENCE_POLICY.maxRewindCommits,
            parentArrived: true,
            retainedParentStateAvailable: false,
          });
          if (outcome.kind === "missing_retained_anchor") {
            this.#toUnrecoverable();
            log("convergence lost retained anchor – group is Unrecoverable");
            yield {
              kind: "skipped",
              envelope: p.envelope,
              message: p.message,
              reason: "missing-retained-anchor",
            };
          } else if (outcome.kind === "beyond_anchor") {
            yield {
              kind: "skipped",
              envelope: p.envelope,
              message: p.message,
              reason: "beyond-anchor",
            };
          } else {
            yield {
              kind: "skipped",
              envelope: p.envelope,
              message: p.message,
              reason: "past-epoch",
            };
          }
        }
      }
    }

    log("done processing batch – epoch:%d", this.state.groupContext.epoch);

    if (unreadable.length > 0) {
      log("scheduling retry for %d unreadable envelope(s)", unreadable.length);
      yield* this.#ingestRaw(unreadable, {
        retryCount: retryCount + 1,
        maxRetries,
        _errors: errorList,
      });
    } else {
      log("done – no unreadable envelopes remain");
    }
  }
}
