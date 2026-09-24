/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  bytesToBase64,
  type CiphersuiteImpl,
  type ClientState,
  contentTypes,
  encode,
  getAppDataDictionary,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  type LeafIndex,
  type MlsFramedMessage,
  mlsMessageEncoder,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  proposalOrRefTypes,
  type ProposalWithSender,
  wireformats,
  senderTypes,
} from "ts-mls";

import { marmotAuthService } from "../core/auth-service.js";
import { getAppComponents } from "../core/components/dictionary.js";
import {
  ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
  type AppComponentId,
} from "../core/components/ids.js";
import {
  type AppDataUpdateOp,
  type CommitIntegrityViolation,
  type CommitLegalityOutcome,
  validateAdminLeafCoupling,
  validateAppComponentIntegrity,
  validateCommitAccountIdentityProofs,
  validateCommitLegality,
} from "../core/components/integrity.js";
import {
  type AppWitness,
  type BranchCandidate,
  commitDigest,
  compareBranchScores,
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
  isWitnessEligible,
  scoreBranch,
  selectCanonicalBranch,
  type BranchScore,
} from "../core/convergence.js";
import { getCredentialPubkey } from "../core/credential.js";
import { getGroupMemberPubkeys } from "../core/group-members.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../core/client-state.js";
import {
  requiredComponentIdsOf,
  validatePreApplyProposals,
  withCapturedProposals,
} from "./admin-policy.js";
import type { EdgeSnapshot } from "./history-tree.js";
import type { RetainedAppliedLink } from "./retained-store.js";
import type { DisbandCandidateEvidence, GroupPeeler } from "./types.js";
import { framedEpoch } from "./wire-format.js";

/** One applied step on a candidate branch: parent → message → child. */
export interface ChainLink {
  parent: ClientState;
  message: MlsMessage;
  child: ClientState;
}

/**
 * A resulting state already known for one of our own applied commits, together
 * with the confirmation tag of the exact parent it was applied to (CONV-04).
 *
 * The parent tag is load-bearing, not bookkeeping: `candidatesAt` admits any
 * pooled message whose framed epoch matches the DFS node's epoch and never
 * checks parentage, so without it the short-circuit would fire while exploring
 * a COMPETING fork node at the same epoch and splice our canonical chain onto
 * that branch — inflating its depth (the primary key `selectCanonicalBranch`
 * scores on) and, if it then won, corrupting `RetainedHistoryStore` with a
 * parent→child edge that never happened.
 */
export interface KnownNextState {
  parentTag: string;
  state: ClientState;
}

/** Shared parent-relative candidate resolution used by live and tree recovery. */
export type ParentResolution =
  | {
      kind: "resolved";
      result: ProcessMessageResult & { kind: "newState" };
    }
  | { kind: "authentication_mismatch" }
  | {
      kind: "rejected";
      reason: "authorization_or_components";
      /** The `processMessage` result the refusal was decided on. */
      result: ProcessMessageResult;
      violation?: CommitIntegrityViolation;
    }
  | { kind: "deferred"; reason: "temporary_refusal" };

/**
 * A pooled candidate commit that authenticated against its parent but was
 * refused there (admin policy or commit legality) and never resolved on any
 * explored node (WR-01). Surfaced so the ingest seam can label it `rejected`
 * with the same reason as direct inbound ingest, instead of `past-epoch`.
 */
export interface RejectedForkCandidate {
  message: MlsMessage;
  result: ProcessMessageResult;
  violation?: CommitIntegrityViolation;
}

/**
 * Rebuilds a PublicMessage commit's proposal list without replaying it: inline
 * entries (sent by the committer) plus each `ProposalRef` resolved from
 * `parent.unappliedProposals`, the same lookup ts-mls `applyProposals`
 * performs. Returns `undefined` when that is not possible — a PrivateMessage
 * commit (encrypted content), a non-member sender, or a reference the parent
 * snapshot no longer stages.
 */
function proposalsFromPublicCommit(
  parent: ClientState,
  message: MlsFramedMessage,
): { proposals: ProposalWithSender[]; committerLeafIndex: number } | undefined {
  if (message.wireformat !== wireformats.mls_public_message) return undefined;
  const content = message.publicMessage.content;
  if (content.contentType !== contentTypes.commit) return undefined;
  if (content.sender.senderType !== senderTypes.member) return undefined;
  const committerLeafIndex = Number(content.sender.leafIndex);
  const proposals: ProposalWithSender[] = [];
  for (const entry of content.commit.proposals) {
    if (entry.proposalOrRefType === proposalOrRefTypes.proposal) {
      proposals.push({
        proposal: entry.proposal,
        senderLeafIndex: committerLeafIndex,
      });
      continue;
    }
    const staged = parent.unappliedProposals[bytesToBase64(entry.reference)];
    if (!staged) return undefined;
    proposals.push(staged);
  }
  return { proposals, committerLeafIndex };
}

/**
 * WR-03: the part of {@link validateCommitLegality} that is decidable without
 * the commit's own proposals, for a recorded child whose proposals cannot be
 * rebuilt off the wire. Runs, in the shared adapter's order:
 * 1. component integrity rules 1-2 (the dictionary and every protected id are
 *    never dropped) and the leaf-only `0x8009` guard. Rule 3 — every changed
 *    entry is backed by one of this commit's own AppDataUpdates — needs those
 *    proposals, so every resulting entry is treated as backed;
 * 2. the `0x8009` profile and changed-leaf proof check, called with NO
 *    `classification` (Phase 9, D-03): with neither this commit's proposals
 *    nor a committer index available, no changed leaf can be attributed to
 *    an Add, an Update sender, or the committer, so ANY changed leaf makes
 *    this step `undecidable` rather than `legal` or a terminal violation —
 *    authorization simply cannot be evaluated against this candidate parent
 *    without more information, and per `refs/marmot/foundation/errors.md`
 *    (lines 63-68) that is a deferral, not a rejection. A `violation` here
 *    still returns immediately; an `undecidable` outcome is remembered and
 *    step 3 still runs, so a definite admin-leaf-coupling violation still
 *    outranks it (mirrors {@link validateCommitLegality}'s own precedence);
 * 3. admin-leaf coupling — the remembered undecidable detail from step 2, if
 *    any, is returned only after this step finds no violation.
 *
 * Disband legality classifies the commit's own proposals and cannot run here.
 */
function validateLegalityWithoutProposals(
  parentState: ClientState,
  resultingState: ClientState,
): CommitLegalityOutcome {
  const currentExtensions = parentState.groupContext.extensions;
  const resultingExtensions = resultingState.groupContext.extensions;
  let requiredIds: readonly AppComponentId[];
  try {
    requiredIds = getAppComponents(currentExtensions) ?? [];
  } catch {
    return {
      kind: "violation",
      violation: {
        reason: "component-integrity",
        detail: "current app_components component did not decode",
      },
    };
  }

  // Neutralize only rule 3: an op "backing" every resulting entry (and every
  // removal), so rules 1-2 and the leaf-only guard are the only integrity
  // checks that can fire. 0x8009 is never synthesized, so a dictionary that
  // carries it is still reported.
  // WR-03: `getAppDataDictionary` throws on malformed bytes or a duplicate
  // component id, and those bytes are attacker-influenceable (an admin can
  // land an AppDataUpdate writing arbitrary bytes to a component id). Left
  // unguarded, the throw escaped this helper's documented non-throwing
  // contract and was swallowed by `resolveCandidateParent`'s blanket `catch`
  // into a silent, never-clearing `deferred` — while the SAME class of
  // malformed bytes reaching `getAppComponents` directly above became a typed
  // `component-integrity` rejection. Map it to that same typed violation so
  // one malformed dictionary cannot receive two different dispositions.
  let resultingDictionary: ReturnType<typeof getAppDataDictionary>;
  let currentDictionary: ReturnType<typeof getAppDataDictionary>;
  try {
    resultingDictionary = getAppDataDictionary(resultingExtensions);
    currentDictionary = getAppDataDictionary(currentExtensions);
  } catch {
    return {
      kind: "violation",
      violation: {
        reason: "component-integrity",
        detail: "app_data_dictionary did not decode",
      },
    };
  }
  const resulting = resultingDictionary ?? [];
  const backedOps: AppDataUpdateOp[] = resulting
    .filter(
      (entry) => entry.componentId !== ACCOUNT_IDENTITY_PROOF_COMPONENT_ID,
    )
    .map((entry) => ({ componentId: entry.componentId, data: entry.data }));
  for (const entry of currentDictionary ?? []) {
    if (entry.componentId === ACCOUNT_IDENTITY_PROOF_COMPONENT_ID) continue;
    if (!resulting.some((r) => r.componentId === entry.componentId))
      backedOps.push({ componentId: entry.componentId, data: undefined });
  }
  const integrity = validateAppComponentIntegrity({
    currentExtensions,
    resultingExtensions,
    appDataUpdateOps: backedOps,
    requiredIds,
  });
  if (integrity) return { kind: "violation", violation: integrity };

  // No `classification` supplied: this commit's proposals cannot be rebuilt
  // off the wire, so any changed leaf is structurally undecidable (D-03). A
  // violation here still returns immediately; an undecidable outcome is
  // remembered so the admin-leaf-coupling check below still runs and can
  // outrank it with a definite violation (mirrors validateCommitLegality).
  const proofOutcome = validateCommitAccountIdentityProofs({
    parentState,
    resultingState,
  });
  if (proofOutcome.kind === "violation") return proofOutcome;
  const undecidableDetail =
    proofOutcome.kind === "undecidable" ? proofOutcome.detail : undefined;

  const couplingViolation = validateAdminLeafCoupling({
    currentExtensions,
    resultingExtensions,
    resultingMemberAccounts: getGroupMemberPubkeys(resultingState),
  });
  if (couplingViolation)
    return { kind: "violation", violation: couplingViolation };

  if (undecidableDetail !== undefined)
    return { kind: "undecidable", detail: undecidableDetail };

  return { kind: "legal" };
}

/**
 * Authenticates a Commit against one exact parent, then applies the shared
 * parent-relative authorization/component gate. A stamped own Commit is
 * already authenticated and authorized and therefore uses its recorded child
 * instead of being replayed. That child still passes the full
 * {@link validateCommitLegality} gate when the commit's proposals can be
 * rebuilt off the wire, and every proposal-independent legality check
 * ({@link validateLegalityWithoutProposals}) when they cannot (WR-03).
 */
export async function resolveCandidateParent(params: {
  ciphersuite: CiphersuiteImpl;
  parent: ClientState;
  message: MlsFramedMessage;
  callback: IncomingMessageCallback;
  known?: KnownNextState;
}): Promise<ParentResolution> {
  const { ciphersuite, parent, message, callback, known } = params;
  if (known?.parentTag === bytesToHex(parent.confirmationTag)) {
    // WR-03: an own commit cannot be replayed (RFC 9420: an UpdatePath never
    // encrypts a path secret to its own committer), but reusing its recorded
    // child must not skip the legality gate — the recorded state may come
    // from a persisted edge written by a build that never enforced it. The
    // proposals are rebuilt off the wire for the full check; when that is
    // impossible, every proposal-independent legality check still runs.
    const result: ProcessMessageResult & { kind: "newState" } = {
      kind: "newState",
      newState: known.state,
      actionTaken: "accept",
      consumed: [],
      aad: new Uint8Array(),
    };
    const rebuilt = proposalsFromPublicCommit(parent, message);
    let outcome: CommitLegalityOutcome;
    try {
      outcome = rebuilt
        ? validateCommitLegality({
            parentState: parent,
            resultingState: known.state,
            proposals: rebuilt.proposals,
            committerLeafIndex: rebuilt.committerLeafIndex,
          })
        : validateLegalityWithoutProposals(parent, known.state);
    } catch {
      return { kind: "deferred", reason: "temporary_refusal" };
    }
    switch (outcome.kind) {
      case "legal":
        return { kind: "resolved", result };
      case "violation":
        return {
          kind: "rejected",
          reason: "authorization_or_components",
          result,
          violation: outcome.violation,
        };
      case "undecidable":
        return { kind: "deferred", reason: "temporary_refusal" };
    }
  }

  const capture = withCapturedProposals(callback);
  capture.take();
  let result: ProcessMessageResult;
  try {
    result = await processMessage({
      context: {
        cipherSuite: ciphersuite,
        authService: marmotAuthService,
        externalPsks: {},
      },
      state: parent,
      message,
      callback: capture.callback,
    });
  } catch {
    return { kind: "authentication_mismatch" };
  }
  const capturedCommit = capture.take();
  if (result.kind !== "newState" || result.actionTaken === "reject")
    return {
      kind: "rejected",
      reason: "authorization_or_components",
      result,
      violation: validatePreApplyProposals(
        capturedCommit.proposals,
        ciphersuite.id,
        requiredComponentIdsOf(parent),
      ),
    };
  try {
    const outcome = validateCommitLegality({
      parentState: parent,
      resultingState: result.newState,
      proposals: capturedCommit.proposals,
      committerLeafIndex: capturedCommit.committerLeafIndex,
    });
    switch (outcome.kind) {
      case "legal":
        return { kind: "resolved", result };
      case "violation":
        return {
          kind: "rejected",
          reason: "authorization_or_components",
          result,
          violation: outcome.violation,
        };
      case "undecidable":
        return { kind: "deferred", reason: "temporary_refusal" };
    }
  } catch {
    return { kind: "deferred", reason: "temporary_refusal" };
  }
}

/** Candidate branches plus their reached tip states and applied chains. */
interface BuiltBranches {
  branches: BranchCandidate[];
  tips: Map<BranchCandidate, ClientState>;
  chains: Map<BranchCandidate, ChainLink[]>;
  /**
   * Every edge explored, in DFS creation order (parents before children), each
   * carrying a snapshot captured before the child's secrets could be zeroed.
   * Feeds the full-fork history tree so abandoned branches are retained.
   */
  edges: EdgeSnapshot[];
  /** Pool candidates refused at their parent and never resolved (WR-01). */
  rejected: RejectedForkCandidate[];
}

/** The outcome of resolving a fork; the caller applies state/lifecycle changes. */
export type ForkResolution =
  | {
      outcome: "recovered";
      winnerTip: ClientState;
      winnerChain: ChainLink[];
      result: ProcessMessageResult;
      /** Every branch edge built while resolving (for history retention). */
      edges: EdgeSnapshot[];
      decision?: {
        selectedBranchId: string;
        selectedTipDigest: string;
        selectedTipCommitter: string;
        decisiveRule: string;
        score: BranchScore;
      };
      selectedTerminal?: DisbandCandidateEvidence;
      /** Pool candidates refused at their parent (WR-01). */
      rejected?: RejectedForkCandidate[];
    }
  | {
      outcome: "superseded";
      edges: EdgeSnapshot[];
      winnerTip?: ClientState;
      decision?: {
        selectedBranchId: string;
        selectedTipDigest: string;
        selectedTipCommitter: string;
        decisiveRule: string;
        score: BranchScore;
      };
      selectedTerminal?: DisbandCandidateEvidence;
      /** Pool candidates refused at their parent (WR-01). */
      rejected?: RejectedForkCandidate[];
    }
  | { outcome: "skip"; rejected?: RejectedForkCandidate[] };

/** Inputs needed to access retained history during fork resolution. */
export interface RetainedView {
  stateAt(epoch: number): ClientState | undefined;
  appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[];
  appliedLinksBetween?(
    forkEpoch: number,
    tipEpoch: number,
  ): RetainedAppliedLink[];
}

/**
 * Convergence fork recovery (Marmot v2 `protocol-core/convergence.md`):
 * rebuilds candidate branches by replaying retained applied commits plus
 * competing commits, scores them with the pure {@link selectCanonicalBranch}
 * core, and reports the canonical branch so the caller can rewind.
 *
 * This is the stateful "candidate branch construction" layer that
 * `convergence.ts` deliberately leaves out. It holds no engine state of its own;
 * branch tip/chain bookkeeping is per-call. Mirrors darkmatter
 * `cgka-engine/src/fork_recovery.rs`.
 */
export class ForkRecovery<TEnvelope> {
  readonly #ciphersuite: CiphersuiteImpl;
  readonly #peeler: GroupPeeler<TEnvelope>;
  readonly #policy: ConvergencePolicy;

  constructor(
    ciphersuite: CiphersuiteImpl,
    peeler: GroupPeeler<TEnvelope>,
    policy: ConvergencePolicy = DEFAULT_CONVERGENCE_POLICY,
  ) {
    this.#ciphersuite = ciphersuite;
    this.#peeler = peeler;
    this.#policy = policy;
  }

  /** The `commit_digest` (SHA-256 of the MLS message bytes) for a commit. */
  #commitDigestOf(message: MlsMessage): Uint8Array {
    return commitDigest(encode(mlsMessageEncoder, message));
  }

  /**
   * Builds every candidate branch reachable by replaying the commit `pool` from
   * the retained `root` state (`convergence.md` "Candidate branches").
   *
   * `knownNextStates` (CONV-04) maps a candidate commit's hex `commitDigest` to
   * a {@link KnownNextState} — the state already known to result from applying
   * it, plus the confirmation tag of the parent it was applied to — supplied by
   * {@link resolveFork} for commits on our own already-applied canonical path
   * (`RetainedHistoryStore` already holds their resulting state; see
   * `resolveFork`'s doc comment for why replaying them via `processMessage`
   * cannot work). The short-circuit is taken only at the DFS node that IS that
   * recorded parent, so an own commit's branch is buildable exactly like any
   * other candidate's without reprocessing it, while a same-epoch node on a
   * competing fork can never adopt it.
   */
  async #buildBranches(
    root: ClientState,
    pool: MlsMessage[],
    encrypted: TEnvelope[],
    witnessEnvelopes: TEnvelope[],
    adminCallbackFor: (parent: ClientState) => IncomingMessageCallback,
    knownNextStates: ReadonlyMap<string, KnownNextState> = new Map(),
    terminalCandidates: ReadonlyMap<
      string,
      DisbandCandidateEvidence
    > = new Map(),
  ): Promise<BuiltBranches> {
    const forkEpoch = Number(root.groupContext.epoch);
    const branches: BranchCandidate[] = [];
    const tips = new Map<BranchCandidate, ClientState>();
    const chains = new Map<BranchCandidate, ChainLink[]>();
    const edges: EdgeSnapshot[] = [];
    let counter = 0;
    // WR-01: refusals keyed by commit digest; a digest that resolves at any
    // explored node is not reported as rejected.
    const rejectedByDigest = new Map<string, RejectedForkCandidate>();
    const resolvedDigests = new Set<string>();

    // CR-02: the admin callback is built from the exact node being explored,
    // never once per resolution. A candidate at fork epoch N is authorized
    // against the admin set and ratchet tree of ITS parent — not the canonical
    // tip, which may sit epochs later on another branch where the committer was
    // demoted or its leaf index reassigned. This is the same parent
    // `#treeResolution` and the pool sweep already use, and the one MDK stages
    // each replayed commit on (`require_admin_for_staged_commit`), so the
    // replay seam cannot refuse an edge the tree-fed seam would adopt.
    const witnessesAt = (state: ClientState): Promise<AppWitness[]> =>
      collectWitnessesAt({
        peeler: this.#peeler,
        ciphersuite: this.#ciphersuite,
        state,
        witnessEnvelopes,
        callback: adminCallbackFor(state),
      });

    const candidatesAt = async (
      state: ClientState,
      logicalEpoch: number,
    ): Promise<MlsMessage[]> => {
      const epoch = Math.max(Number(state.groupContext.epoch), logicalEpoch);
      const out: MlsMessage[] = [];
      const seenDigests = new Set<string>();
      const add = (m: MlsMessage) => {
        // Candidate commits are MLS PublicMessage under Marmot v2 (see
        // wire-format.ts); match any framed message at this fork epoch.
        const e = framedEpoch(m);
        if (e === undefined || Number(e) !== epoch) return;
        const d = bytesToHex(this.#commitDigestOf(m));
        if (!seenDigests.has(d)) {
          seenDigests.add(d);
          out.push(m);
        }
      };
      for (const m of pool) add(m);
      for (const envelope of encrypted) {
        try {
          const r = await this.#peeler.peelGroupMessages([envelope], state);
          for (const pair of r.read) add(pair.message);
        } catch {
          /* not decryptable under this state */
        }
      }
      return out;
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
      let branchDeferred = false;
      for (const message of await candidatesAt(
        state,
        forkEpoch + chain.length,
      )) {
        // Candidate commits are framed (private or public); skip anything else.
        if (
          message.wireformat !== wireformats.mls_private_message &&
          message.wireformat !== wireformats.mls_public_message
        )
          continue;
        const known = knownNextStates.get(
          bytesToHex(this.#commitDigestOf(message)),
        );
        // The short-circuit is valid ONLY at the exact parent this commit was
        // recorded against. `candidatesAt` matches purely on framed epoch, so
        // an unqualified digest hit would also fire at a same-epoch node on a
        // COMPETING branch and graft our canonical chain onto it (CR-01). When
        // the parent does not match we fall through to the normal replay path,
        // where our own commit fails to process against a foreign parent and is
        // dropped as a candidate — which is the correct outcome.
        //
        // CR-04/WR-03: reusing a recorded state must NOT also skip the legality
        // gate. `ours` comes from `RetainedHistoryStore`, which `GroupRegistry`
        // rebuilds on load straight from the persisted history tree — the exact
        // pre-upgrade edge class `#treeResolution` explicitly refuses to
        // grandfather. This commit cannot be replayed, so
        // `resolveCandidateParent` reads its proposals off the wire instead
        // (inline entries plus the parent's staged proposal for each
        // `ProposalRef`) and runs `validateCommitLegality` on the recorded
        // child. When that reconstruction is not possible (a `PrivateMessage`
        // commit, or a reference the parent snapshot no longer stages) it runs
        // every proposal-independent legality check instead: component rules
        // 1-2, the `0x8009` check, and admin-leaf coupling (WR-03).
        const knownAtThisParent =
          known !== undefined &&
          known.parentTag === bytesToHex(state.confirmationTag);
        const resolution = await resolveCandidateParent({
          ciphersuite: this.#ciphersuite,
          parent: state,
          message,
          callback: adminCallbackFor(state),
          known: knownAtThisParent ? known : undefined,
        });
        if (resolution.kind === "deferred") {
          branchDeferred = true;
          continue;
        }
        const digestHex = bytesToHex(this.#commitDigestOf(message));
        if (resolution.kind === "rejected") {
          if (!rejectedByDigest.has(digestHex))
            rejectedByDigest.set(digestHex, {
              message,
              result: resolution.result,
              violation: resolution.violation,
            });
          continue;
        }
        if (resolution.kind !== "resolved") continue;
        resolvedDigests.add(digestHex);
        const next = resolution.result;
        const tag = bytesToHex(next.newState.confirmationTag);
        if (seen.has(tag)) {
          const digest = this.#commitDigestOf(message);
          const terminal = terminalCandidates.get(bytesToHex(digest));
          if (terminal) {
            const branch: BranchCandidate = {
              id: `branch-${counter++}`,
              forkEpoch,
              tipEpoch: forkEpoch + chain.length + 1,
              tipDigest: digest,
              tipCommitter: hexToBytes(terminal.actorPubkey),
              appWitnesses: accumulated,
            };
            tips.set(branch, next.newState);
            chains.set(branch, [
              ...chain,
              { parent: state, message, child: next.newState },
            ]);
            branches.push(branch);
          }
          continue;
        }
        extended = true;
        // Snapshot the child now, before recursing — exploring its children
        // would zero this state's consumed secrets in place (ts-mls), corrupting
        // a snapshot taken afterward.
        const commitBytes = encode(mlsMessageEncoder, message);
        edges.push({
          parentTag: bytesToHex(state.confirmationTag),
          childTag: tag,
          childEpoch: Number(next.newState.groupContext.epoch),
          commitBytes,
          commitDigest: commitDigest(commitBytes),
          childSnapshot: serializeClientState(next.newState),
        });
        await explore(
          next.newState,
          message,
          new Set([...seen, tag]),
          [...chain, { parent: state, message, child: next.newState }],
          accumulated,
        );
      }
      if (!extended && !branchDeferred && tipMessage !== undefined) {
        // A removed receiver's ts-mls tombstone retains its parent epoch even
        // though the authenticated Commit is one edge past the fork root.
        const tipEpoch = Math.max(
          Number(state.groupContext.epoch),
          forkEpoch + chain.length,
        );
        const branch: BranchCandidate = {
          id: `branch-${counter++}`,
          forkEpoch,
          tipEpoch,
          tipDigest: this.#commitDigestOf(tipMessage),
          tipCommitter: (() => {
            const parent = chain.at(-1)?.parent;
            if (!parent) return new Uint8Array();
            const sender =
              tipMessage.wireformat === wireformats.mls_public_message &&
              tipMessage.publicMessage.content.sender.senderType ===
                senderTypes.member
                ? tipMessage.publicMessage.content.sender.leafIndex
                : undefined;
            if (sender === undefined) return new Uint8Array();
            try {
              return hexToBytes(
                getCredentialPubkey(
                  getCredentialFromLeafIndex(
                    parent.ratchetTree,
                    sender as LeafIndex,
                  ),
                ),
              );
            } catch {
              return new Uint8Array();
            }
          })(),
          // Drop witnesses at/before the fork epoch or outside the retained
          // app-payload window for this candidate's tip, so stale or pre-fork
          // app payloads cannot influence branch scores.
          appWitnesses: accumulated.filter((w) =>
            isWitnessEligible(w, forkEpoch, tipEpoch, this.#policy),
          ),
        };
        tips.set(branch, state);
        chains.set(branch, chain);
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
    const rejected = [...rejectedByDigest]
      .filter(([digest]) => !resolvedDigests.has(digest))
      .map(([, candidate]) => candidate);
    return { branches, tips, chains, edges, rejected };
  }

  /**
   * Resolves a fork at `forkEpoch` (`convergence.md`): rebuilds candidate
   * branches by replaying retained applied commits plus the competing `pool`,
   * selects the canonical branch, and reports it when it differs from the
   * caller's current tip. The caller applies the rewind (state + lifecycle).
   */
  async resolveFork(params: {
    forkEpoch: number;
    pool: MlsMessage[];
    encrypted?: TEnvelope[];
    witnessEnvelopes?: TEnvelope[];
    currentState: ClientState;
    retained: RetainedView;
    /**
     * Builds the admin-verification callback for one explored parent state
     * (CR-02). Invoked per node, so every candidate commit is authorized
     * against its own parent rather than the caller's current tip.
     */
    adminCallbackFor: (parent: ClientState) => IncomingMessageCallback;
    terminalCandidates?: ReadonlyMap<string, DisbandCandidateEvidence>;
    knownCandidates?: ReadonlyMap<string, KnownNextState>;
  }): Promise<ForkResolution> {
    const {
      forkEpoch,
      pool,
      encrypted = [],
      witnessEnvelopes = [],
      currentState,
      retained,
      adminCallbackFor,
      terminalCandidates = new Map(),
      knownCandidates = new Map(),
    } = params;

    const root = retained.stateAt(forkEpoch);
    if (!root) return { outcome: "skip" };

    const currentTipEpoch = Number(currentState.groupContext.epoch);
    const retainedLinks = retained.appliedLinksBetween?.(
      forkEpoch,
      currentTipEpoch,
    );
    const ours = retainedLinks
      ? retainedLinks.map((link) => link.message)
      : retained.appliedCommitsBetween(forkEpoch, currentTipEpoch);
    if (ours.length === 0 && pool.length === 0) return { outcome: "skip" };

    // CONV-04: every commit in `ours` already applied on our own canonical
    // branch, so `RetainedHistoryStore` already holds the exact state it
    // produced — `record()` stores both the parent and the resulting state
    // for every applied commit (own-authored via `confirmPublished`, or
    // inbound via `ctx.recordCommit`, through the identical recording path).
    // `#buildBranches` uses this instead of replaying these commits through
    // `processMessage`, which cannot reprocess a commit whose committer leaf
    // is the replaying leaf itself (RFC 9420: an `UpdatePath` never encrypts a
    // path secret to its own committer). Each state is cloned via a
    // serialize/deserialize round trip before handing it into the DFS —
    // continued exploration from a state consumes/derives further secrets on
    // it, and the original must stay untouched since it is the same object
    // `RetainedHistoryStore` (and possibly the live engine) still holds.
    // The recorded PARENT is captured alongside the resulting state so
    // `#buildBranches` can only take the short-circuit at the node that
    // actually produced this child — see {@link KnownNextState}.
    const knownNextStates = new Map<string, KnownNextState>(knownCandidates);
    for (const [index, msg] of ours.entries()) {
      const structural = retainedLinks?.[index];
      if (!structural?.ownCommitStamp) continue;
      const sourceEpoch = Number(
        structural
          ? Number(structural.parentState.groupContext.epoch)
          : framedEpoch(msg),
      );
      if (!Number.isFinite(sourceEpoch)) continue;
      const parent = structural?.parentState ?? retained.stateAt(sourceEpoch);
      const next =
        structural?.resultingState ?? retained.stateAt(sourceEpoch + 1);
      if (!parent || !next) continue;
      knownNextStates.set(bytesToHex(this.#commitDigestOf(msg)), {
        parentTag: bytesToHex(parent.confirmationTag),
        state: deserializeClientState(serializeClientState(next)),
      });
    }

    const { branches, tips, chains, edges, rejected } =
      await this.#buildBranches(
        root,
        [...ours, ...pool],
        encrypted,
        witnessEnvelopes,
        adminCallbackFor,
        knownNextStates,
        terminalCandidates,
      );
    if (branches.length === 0) return { outcome: "skip", rejected };

    const winner = selectCanonicalBranch(
      currentTipEpoch,
      branches,
      this.#policy,
    );
    const winnerTip = winner ? tips.get(winner) : undefined;
    if (!winner || !winnerTip)
      return { outcome: "superseded", edges, rejected };

    const winnerScore = scoreBranch(winner, this.#policy);
    const runner = branches
      .filter((candidate) => candidate !== winner)
      .map((candidate) => scoreBranch(candidate, this.#policy))
      .sort((a, b) => compareBranchScores(b, a))[0];
    const decisiveRule = runner
      ? winnerScore.effectiveCommitDepth !== runner.effectiveCommitDepth
        ? "effective_commit_depth"
        : winnerScore.witnessQuorumMet !== runner.witnessQuorumMet
          ? "witness_quorum_met"
          : winnerScore.appWitnessScore !== runner.appWitnessScore
            ? "app_witness_score"
            : bytesToHex(winnerScore.tipCommitter) !==
                bytesToHex(runner.tipCommitter)
              ? "tip_committer"
              : "tip_digest"
      : "only_candidate";
    const decision = {
      selectedBranchId: bytesToHex(winnerTip.confirmationTag),
      selectedTipDigest: bytesToHex(winner.tipDigest),
      selectedTipCommitter: bytesToHex(winnerScore.tipCommitter),
      decisiveRule,
      score: winnerScore,
    };
    const selectedTerminal = terminalCandidates.get(
      bytesToHex(winner.tipDigest),
    );
    if (
      !selectedTerminal &&
      bytesToHex(winnerTip.confirmationTag) ===
        bytesToHex(currentState.confirmationTag)
    )
      return {
        outcome: "superseded",
        edges,
        winnerTip,
        decision,
        selectedTerminal,
        rejected,
      };

    return {
      outcome: "recovered",
      winnerTip,
      winnerChain: chains.get(winner) ?? [],
      edges,
      decision,
      selectedTerminal,
      rejected,
      result: {
        kind: "newState",
        newState: winnerTip,
        actionTaken: "accept",
        consumed: [],
        aad: new Uint8Array(),
      },
    };
  }
}

/**
 * Collects the {@link AppWitness}es that decrypt against a single candidate
 * `state` (`convergence.md` "App-payload witnesses"): each witness envelope is
 * peeled and processed, and an authenticated application message contributes a
 * witness at `state`'s epoch keyed by the sender's account pubkey. Used by both
 * the pool-replay branch builder ({@link ForkRecovery}) and the tree-fed
 * re-convergence pass, which gathers witnesses per retained fork-branch node.
 */
export async function collectWitnessesAt<TEnvelope>(params: {
  peeler: GroupPeeler<TEnvelope>;
  ciphersuite: CiphersuiteImpl;
  state: ClientState;
  witnessEnvelopes: TEnvelope[];
  callback: IncomingMessageCallback;
}): Promise<AppWitness[]> {
  const { peeler, ciphersuite, state, witnessEnvelopes, callback } = params;
  const epoch = Number(state.groupContext.epoch);
  const out: AppWitness[] = [];
  for (const envelope of witnessEnvelopes) {
    try {
      const decrypted = await peeler.peelGroupMessages([envelope], state);
      for (const pair of decrypted.read) {
        if (pair.message.wireformat !== wireformats.mls_private_message)
          continue;
        const r = await processMessage({
          context: {
            cipherSuite: ciphersuite,
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
}
