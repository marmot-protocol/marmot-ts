/** @module @category Engine */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  type CiphersuiteImpl,
  type ClientState,
  encode,
  getCredentialFromLeafIndex,
  type IncomingMessageCallback,
  type LeafIndex,
  mlsMessageEncoder,
  MlsMessage,
  processMessage,
  type ProcessMessageResult,
  wireformats,
} from "ts-mls";

import { marmotAuthService } from "../core/auth-service.js";
import { validateCommitLegality } from "../core/components/integrity.js";
import {
  type AppWitness,
  type BranchCandidate,
  commitDigest,
  type ConvergencePolicy,
  DEFAULT_CONVERGENCE_POLICY,
  isWitnessEligible,
  selectCanonicalBranch,
} from "../core/convergence.js";
import { getCredentialPubkey } from "../core/credential.js";
import {
  deserializeClientState,
  serializeClientState,
} from "../core/client-state.js";
import { withCapturedProposals } from "./admin-policy.js";
import type { EdgeSnapshot } from "./history-tree.js";
import type { GroupPeeler } from "./types.js";
import { framedEpoch } from "./wire-format.js";

/** One applied step on a candidate branch: parent → message → child. */
export interface ChainLink {
  parent: ClientState;
  message: MlsMessage;
  child: ClientState;
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
    }
  | { outcome: "superseded"; edges: EdgeSnapshot[] }
  | { outcome: "skip" };

/** Inputs needed to access retained history during fork resolution. */
export interface RetainedView {
  stateAt(epoch: number): ClientState | undefined;
  appliedCommitsBetween(forkEpoch: number, tipEpoch: number): MlsMessage[];
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
   * a state already known to result from applying it — supplied by
   * {@link resolveFork} for commits on our own already-applied canonical path
   * (`RetainedHistoryStore` already holds their resulting state; see
   * `resolveFork`'s doc comment for why replaying them via `processMessage`
   * cannot work). When present, that state is used directly instead of calling
   * `processMessage`, so an own commit's branch is buildable exactly like any
   * other candidate's, without reprocessing it.
   */
  async #buildBranches(
    root: ClientState,
    pool: MlsMessage[],
    encrypted: TEnvelope[],
    witnessEnvelopes: TEnvelope[],
    callback: IncomingMessageCallback,
    knownNextStates: ReadonlyMap<string, ClientState> = new Map(),
  ): Promise<BuiltBranches> {
    const forkEpoch = Number(root.groupContext.epoch);
    const branches: BranchCandidate[] = [];
    const tips = new Map<BranchCandidate, ClientState>();
    const chains = new Map<BranchCandidate, ChainLink[]>();
    const edges: EdgeSnapshot[] = [];
    let counter = 0;

    // WIRE-03/CONV-01 (D-04/D-09): wrap the callback once so the commit's own
    // proposals are captured for validateCommitLegality at the point a
    // candidate edge would be created — the same shared adapter the inbound
    // seam (ingest.ts) uses, so neither seam can drift from the other.
    const capture = withCapturedProposals(callback);

    const witnessesAt = (state: ClientState): Promise<AppWitness[]> =>
      collectWitnessesAt({
        peeler: this.#peeler,
        ciphersuite: this.#ciphersuite,
        state,
        witnessEnvelopes,
        callback: capture.callback,
      });

    const candidatesAt = async (state: ClientState): Promise<MlsMessage[]> => {
      const epoch = Number(state.groupContext.epoch);
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
      for (const message of await candidatesAt(state)) {
        // Candidate commits are framed (private or public); skip anything else.
        if (
          message.wireformat !== wireformats.mls_private_message &&
          message.wireformat !== wireformats.mls_public_message
        )
          continue;
        let next: ProcessMessageResult;
        const known = knownNextStates.get(
          bytesToHex(this.#commitDigestOf(message)),
        );
        if (known) {
          // A commit we already applied ourselves (own or previously-adopted
          // inbound) cannot be replayed through `processMessage`: its
          // `UpdatePath` never encrypted a path secret to the committer's own
          // leaf (RFC 9420), so a receiver whose leaf IS the committer's leaf
          // has nothing to decrypt and `processMessage` throws. We already
          // recorded the real resulting state when this commit was first
          // applied (`RetainedHistoryStore.record`), so reuse it instead of
          // reprocessing (CONV-04).
          next = {
            kind: "newState",
            newState: known,
            actionTaken: "accept",
            consumed: [],
            aad: new Uint8Array(),
          };
        } else {
          // withCapturedProposals contract: clear any proposals left buffered
          // from a prior candidate before this processMessage call, then read
          // this commit's own proposals immediately after it resolves.
          capture.take();
          try {
            next = await processMessage({
              context: {
                cipherSuite: this.#ciphersuite,
                authService: marmotAuthService,
                externalPsks: {},
              },
              state,
              message,
              callback: capture.callback,
            });
          } catch {
            continue;
          }
          const capturedProposals = capture.take();
          if (next.kind !== "newState" || next.actionTaken === "reject")
            continue;

          // WIRE-03/CONV-01 (D-04/D-09): a candidate commit that fails commit
          // legality creates no branch edge at all — no grandfathering for
          // edges replayed out of persisted retained history. The accepted
          // consequence (D-04/D-09) is that a stored branch containing a
          // previously-accepted violating commit becomes unselectable after
          // upgrade (worst case the group reaches Unrecoverable); such a group
          // is already forked from any conformant peer.
          // Defence in depth: `validateCommitLegality` is documented
          // non-throwing (D-01/D-02) and converts a malformed-component decode
          // into a typed violation, but this seam sits inside an async
          // generator whose caller (`ingest.ts` → `GroupSession.ingest`) only
          // reaches `save()` after a clean drain. A throw escaping here would
          // abandon state already advanced in the batch, so treat any
          // unexpected throw exactly like a violation: no candidate edge.
          let violation: ReturnType<typeof validateCommitLegality>;
          try {
            violation = validateCommitLegality({
              parentState: state,
              resultingState: next.newState,
              proposals: capturedProposals,
            });
          } catch {
            continue;
          }
          if (violation) continue;
        }
        const tag = bytesToHex(next.newState.confirmationTag);
        if (seen.has(tag)) continue;
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
      if (!extended && tipMessage !== undefined) {
        const tipEpoch = Number(state.groupContext.epoch);
        const branch: BranchCandidate = {
          id: `branch-${counter++}`,
          forkEpoch,
          tipEpoch,
          tipDigest: this.#commitDigestOf(tipMessage),
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
    return { branches, tips, chains, edges };
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
    adminCallback: IncomingMessageCallback;
  }): Promise<ForkResolution> {
    const {
      forkEpoch,
      pool,
      encrypted = [],
      witnessEnvelopes = [],
      currentState,
      retained,
      adminCallback,
    } = params;

    const root = retained.stateAt(forkEpoch);
    if (!root) return { outcome: "skip" };

    const currentTipEpoch = Number(currentState.groupContext.epoch);
    const ours = retained.appliedCommitsBetween(forkEpoch, currentTipEpoch);
    if (ours.length === 0) return { outcome: "skip" };

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
    const knownNextStates = new Map<string, ClientState>();
    for (const msg of ours) {
      const sourceEpoch = framedEpoch(msg);
      if (sourceEpoch === undefined) continue;
      const next = retained.stateAt(Number(sourceEpoch) + 1);
      if (!next) continue;
      knownNextStates.set(
        bytesToHex(this.#commitDigestOf(msg)),
        deserializeClientState(serializeClientState(next)),
      );
    }

    const { branches, tips, chains, edges } = await this.#buildBranches(
      root,
      [...ours, ...pool],
      encrypted,
      witnessEnvelopes,
      adminCallback,
      knownNextStates,
    );
    if (branches.length === 0) return { outcome: "skip" };

    const winner = selectCanonicalBranch(
      currentTipEpoch,
      branches,
      this.#policy,
    );
    const winnerTip = winner ? tips.get(winner) : undefined;
    if (!winner || !winnerTip) return { outcome: "superseded", edges };

    if (
      bytesToHex(winnerTip.confirmationTag) ===
      bytesToHex(currentState.confirmationTag)
    )
      return { outcome: "superseded", edges };

    return {
      outcome: "recovered",
      winnerTip,
      winnerChain: chains.get(winner) ?? [],
      edges,
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
