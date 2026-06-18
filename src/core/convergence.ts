/** @module @category Core - Convergence */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import { isAppPayloadExpired } from "./retained-history.js";

/**
 * Deterministic convergence primitives (Marmot v2 `protocol-core/convergence.md`).
 *
 * Convergence chooses one canonical branch from unordered group input using only
 * MLS-valid bytes, retained state, decrypted app payloads, and the group's
 * convergence policy — never transport arrival order, timestamps, outer event
 * ids, or local receive order. Every member processing the same epoch with the
 * same policy MUST select the same branch, so this logic is byte-for-byte
 * deterministic and ported directly from darkmatter `cgka-engine/src/convergence.rs`.
 *
 * This module is the pure selection/scoring core; candidate-branch construction
 * (replaying commits from retained states) and disposition assignment live in
 * the inbound/retained-history layers.
 */

/** The signed convergence policy governing branch selection for a group. */
export interface ConvergencePolicy {
  /**
   * The pinned convergence-policy profile this set of constants names
   * (`convergence.md`). Not a wire field — it identifies the profile; profile
   * `1` is the values in {@link DEFAULT_CONVERGENCE_POLICY}.
   */
  policyVersion: number;
  /** How far back from the current tip a branch MAY fork and stay eligible. */
  maxRewindCommits: number;
  /**
   * The width of the retained app-payload window: an MLS application message is
   * inside the window iff `reference_tip_epoch - message_epoch <= this`
   * (`retained-history.md` "App-payload retention"). Messages outside it expire
   * and MUST NOT count as convergence witnesses.
   */
  appPayloadPastEpochLimit: number;
  /**
   * The minimum quiescent time (ms) without new convergence-relevant input
   * before a convergence pass MAY be treated as settled and queued outbound work
   * released (`convergence.md`). Carried for completeness; the settle-window
   * state machine itself (B5) is not yet wired.
   */
  settlementQuiescenceMs: number;
  /** Distinct senders needed for one branch epoch to count toward witness quorum. */
  witnessQuorumSendersPerEpoch: number;
  /** Number of branch epochs that MUST meet sender quorum. */
  witnessQuorumEpochs: number;
  /** Maximum commit-depth boost a branch MAY receive from witness quorum. */
  maxWitnessOverrideDepth: number;
}

/**
 * The default Marmot convergence policy — profile version 1 (`convergence.md`).
 * Groups without explicit policy bytes MUST treat this as active.
 */
export const DEFAULT_CONVERGENCE_POLICY: ConvergencePolicy = {
  policyVersion: 1,
  maxRewindCommits: 5,
  appPayloadPastEpochLimit: 5,
  settlementQuiescenceMs: 1000,
  witnessQuorumSendersPerEpoch: 2,
  witnessQuorumEpochs: 1,
  maxWitnessOverrideDepth: 1,
};

/**
 * Validates the witness-override invariant: a witness-quorum boost must never be
 * able to push a branch past the rollback horizon, so
 * `maxWitnessOverrideDepth <= maxRewindCommits`. Throws on violation.
 */
export function validateConvergencePolicy(policy: ConvergencePolicy): void {
  if (policy.maxWitnessOverrideDepth > policy.maxRewindCommits) {
    throw new Error(
      `Convergence policy invalid: max_witness_override_depth ` +
        `(${policy.maxWitnessOverrideDepth}) exceeds max_rewind_commits ` +
        `(${policy.maxRewindCommits})`,
    );
  }
}

/**
 * An app-payload witness: an MLS application message whose Marmot app payload
 * decrypts against a candidate branch state. `sender` is the account identity
 * authenticated by the MLS leaf credential (not a transport/leaf identity).
 */
export interface AppWitness {
  epoch: number;
  sender: Uint8Array;
}

/**
 * Whether an app-payload witness counts toward a candidate branch's score
 * (`convergence.md` "App-payload witnesses", `retained-history.md`
 * "App-payload retention"). A witness MUST decrypt strictly after the branch's
 * `forkEpoch` (a message at/before the fork is not a witness for any candidate)
 * AND be inside the retained app-payload window evaluated with the candidate's
 * `tipEpoch` as the reference tip. Stale or pre-fork app payloads MUST NOT
 * influence branch selection.
 */
export function isWitnessEligible(
  witness: AppWitness,
  forkEpoch: number,
  tipEpoch: number,
  policy: ConvergencePolicy,
): boolean {
  return (
    witness.epoch > forkEpoch &&
    !isAppPayloadExpired(
      witness.epoch,
      tipEpoch,
      policy.appPayloadPastEpochLimit,
    )
  );
}

/** A candidate branch produced by replaying commits from a retained state. */
export interface BranchCandidate {
  /** Caller-supplied identifier for the branch (not used in scoring). */
  id: string;
  /** The epoch where the branch diverged from retained canonical state. */
  forkEpoch: number;
  /** The epoch reached after replaying the branch's valid commits. */
  tipEpoch: number;
  /** SHA-256 (32 bytes) of the branch's tip commit MLS message bytes. */
  tipDigest: Uint8Array;
  /** App-payload witnesses that decrypt on candidate states in the branch. */
  appWitnesses: AppWitness[];
}

/** The derived comparison keys for a {@link BranchCandidate}. */
export interface BranchScore {
  validCommitDepth: number;
  effectiveCommitDepth: number;
  witnessQuorumMet: boolean;
  appWitnessScore: number;
  tipDigest: Uint8Array;
}

function witnessesByEpoch(witnesses: AppWitness[]): Map<number, Set<string>> {
  const byEpoch = new Map<number, Set<string>>();
  for (const witness of witnesses) {
    let senders = byEpoch.get(witness.epoch);
    if (!senders) {
      senders = new Set();
      byEpoch.set(witness.epoch, senders);
    }
    senders.add(bytesToHex(witness.sender));
  }
  return byEpoch;
}

function witnessQuorumMet(
  witnesses: AppWitness[],
  policy: ConvergencePolicy,
): boolean {
  if (
    policy.witnessQuorumSendersPerEpoch === 0 ||
    policy.witnessQuorumEpochs === 0
  )
    return false;
  let qualifyingEpochs = 0;
  for (const senders of witnessesByEpoch(witnesses).values()) {
    if (senders.size >= policy.witnessQuorumSendersPerEpoch) qualifyingEpochs++;
  }
  return qualifyingEpochs >= policy.witnessQuorumEpochs;
}

function appWitnessScore(
  witnesses: AppWitness[],
  policy: ConvergencePolicy,
): number {
  let score = 0;
  for (const senders of witnessesByEpoch(witnesses).values()) {
    score += Math.min(senders.size, policy.witnessQuorumSendersPerEpoch);
  }
  return score;
}

function witnessDepthBoost(
  branch: BranchCandidate,
  policy: ConvergencePolicy,
): number {
  return witnessQuorumMet(branch.appWitnesses, policy)
    ? policy.maxWitnessOverrideDepth
    : 0;
}

/** Computes the {@link BranchScore} for a candidate under a policy. */
export function scoreBranch(
  branch: BranchCandidate,
  policy: ConvergencePolicy,
): BranchScore {
  const validCommitDepth = Math.max(0, branch.tipEpoch - branch.forkEpoch);
  return {
    validCommitDepth,
    effectiveCommitDepth: validCommitDepth + witnessDepthBoost(branch, policy),
    witnessQuorumMet: witnessQuorumMet(branch.appWitnesses, policy),
    appWitnessScore: appWitnessScore(branch.appWitnesses, policy),
    tipDigest: branch.tipDigest,
  };
}

/** Lexicographic comparison over raw bytes (a<b → -1, a>b → 1, equal → 0). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two branch scores per `convergence.md` "Branch selection": higher
 * effectiveCommitDepth, then witness quorum beats none, then higher
 * rawCommitDepth, then higher appWitnessScore, then LOWER tipDigest. Returns a
 * positive number when `a` ranks above `b` (so the canonical branch is the
 * maximum under this ordering).
 */
export function compareBranchScores(a: BranchScore, b: BranchScore): number {
  return (
    cmpNum(a.effectiveCommitDepth, b.effectiveCommitDepth) ||
    cmpNum(Number(a.witnessQuorumMet), Number(b.witnessQuorumMet)) ||
    cmpNum(a.validCommitDepth, b.validCommitDepth) ||
    cmpNum(a.appWitnessScore, b.appWitnessScore) ||
    // Lower tip digest wins, so invert the byte comparison.
    compareBytes(b.tipDigest, a.tipDigest)
  );
}

/**
 * A branch is eligible only inside the rollback horizon:
 * `currentTipEpoch - forkEpoch <= maxRewindCommits`.
 */
export function isBranchEligible(
  currentTipEpoch: number,
  branch: BranchCandidate,
  policy: ConvergencePolicy,
): boolean {
  return (
    Math.max(0, currentTipEpoch - branch.forkEpoch) <= policy.maxRewindCommits
  );
}

/**
 * Selects the canonical branch from candidates: filters to eligible branches and
 * returns the maximum under {@link compareBranchScores}. On a full tie the later
 * candidate wins (matching Rust `max_by`). Returns undefined if none eligible.
 */
export function selectCanonicalBranch(
  currentTipEpoch: number,
  candidates: BranchCandidate[],
  policy: ConvergencePolicy,
): BranchCandidate | undefined {
  let best: BranchCandidate | undefined;
  let bestScore: BranchScore | undefined;
  for (const candidate of candidates) {
    if (!isBranchEligible(currentTipEpoch, candidate, policy)) continue;
    const score = scoreBranch(candidate, policy);
    if (bestScore === undefined || compareBranchScores(score, bestScore) >= 0) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * The content-derived ordering key for same-epoch races
 * (`convergence.md` "Same-epoch races"). `commitDigest` is `SHA-256` over the
 * commit's MLS message bytes; for equal `sourceEpoch`, the lower digest wins.
 */
export interface CommitOrderingKey {
  sourceEpoch: number;
  commitDigest: Uint8Array;
}

/** Computes the `commit_digest`: SHA-256 (32 bytes) of the commit MLS bytes. */
export function commitDigest(mlsBytes: Uint8Array): Uint8Array {
  return sha256(mlsBytes);
}

/**
 * Compares two commit ordering keys: lower sourceEpoch first, then lower
 * commitDigest. Negative when `a` orders before `b`. This is for branch choice
 * only; the stored message id used to mark a losing commit stays separate.
 */
export function compareCommitOrderingKeys(
  a: CommitOrderingKey,
  b: CommitOrderingKey,
): number {
  return (
    cmpNum(a.sourceEpoch, b.sourceEpoch) ||
    compareBytes(a.commitDigest, b.commitDigest)
  );
}
