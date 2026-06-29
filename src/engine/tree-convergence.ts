/** @module @category Engine */
import type {
  BranchCandidate,
  ConvergencePolicy,
} from "../core/convergence.js";
import { isBranchEligible } from "../core/convergence.js";
import type { GroupHistoryTree } from "./history-tree.js";

/** Shared empty digest for the horizon-only eligibility probe (never scored). */
const EMPTY = new Uint8Array();

/**
 * The candidate set for a tree-fed re-convergence pass: the shared fork root plus
 * one {@link BranchCandidate} per branch tip reachable from it (including the
 * current tip), scored later by {@link selectCanonicalBranch}.
 */
export interface TreeBranchSet {
  /** The single fork root all candidates are measured from (its hex node tag). */
  rootTag: string;
  /** One candidate per tip descending from the root (the current tip included). */
  candidates: BranchCandidate[];
}

/**
 * Builds the candidate branch set for re-scoring the persisted fork history
 * against the current tip, sourcing everything from the {@link GroupHistoryTree}
 * (Marmot v2 `protocol-core/convergence.md`). Unlike `ForkRecovery`, which
 * replays the incoming commit pool, this reads the tree's already-retained fork
 * snapshots, so a competing branch known only on disk is re-evaluated without the
 * transport re-delivering it.
 *
 * Construction is fully synchronous and structural: every datum a candidate needs
 * (epoch, tip digest) is in the tree's light index — `tipDigest` is the stored
 * `edge.commitDigest`, byte-identical to the `sha256` of the commit MLS bytes that
 * scoring expects. App-payload witnesses are layered on by the caller when
 * available; on load there are none, and the structural keys
 * (depth + lower tip digest) still pick a deterministic, member-independent
 * winner.
 *
 * A single shared fork root is chosen — the eligible competing tip's fork point at
 * the *minimum* epoch (the current tip's path is linear, so its ancestor at that
 * epoch is unique). Every tip descending from that root becomes a candidate at the
 * shared `forkEpoch`, mirroring the pool path's single-root semantics
 * (`ingest.ts` `minForkEpoch`). Including the current tip makes "already
 * canonical" a clean no-op for the selector.
 *
 * @returns the candidate set, or `undefined` when no eligible competing tip exists
 *   (no fork within the rollback horizon — nothing to switch to).
 */
export function buildTreeBranchSet(
  tree: GroupHistoryTree,
  currentTipTag: string,
  policy: ConvergencePolicy,
): TreeBranchSet | undefined {
  const currentTipEpoch = tree.epochOf(currentTipTag);
  if (currentTipEpoch === undefined) return undefined;

  // The deepest eligible divergence: the smallest fork epoch among competing
  // tips still inside the rollback horizon. That fork node is the shared root.
  let rootTag: string | undefined;
  let rootEpoch = Number.POSITIVE_INFINITY;
  for (const tip of tree.tips()) {
    if (tip === currentTipTag) continue;
    const forkTag = tree.lowestCommonAncestor(tip, currentTipTag);
    if (forkTag === undefined) continue;
    const forkEpoch = tree.epochOf(forkTag);
    const tipEpoch = tree.epochOf(tip);
    if (forkEpoch === undefined || tipEpoch === undefined) continue;
    // Horizon eligibility — same predicate the selector applies; only forkEpoch
    // is read, so a minimal candidate suffices.
    const eligible = isBranchEligible(
      currentTipEpoch,
      { id: tip, forkEpoch, tipEpoch, tipDigest: EMPTY, appWitnesses: [] },
      policy,
    );
    if (!eligible) continue;
    if (forkEpoch < rootEpoch) {
      rootEpoch = forkEpoch;
      rootTag = forkTag;
    }
  }
  if (rootTag === undefined) return undefined;

  // Every tip reachable from the root is a candidate at the shared fork epoch.
  // The current tip descends from the root (the root is its ancestor), so it is
  // enumerated here too.
  const candidates: BranchCandidate[] = [];
  const stack = [rootTag];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const tag = stack.pop()!;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const children = tree.childrenOf(tag);
    if (children.length === 0) {
      const tipEpoch = tree.epochOf(tag);
      if (tipEpoch === undefined) continue;
      candidates.push({
        id: tag,
        forkEpoch: rootEpoch,
        tipEpoch,
        tipDigest: tree.node(tag)?.edge?.commitDigest ?? EMPTY,
        appWitnesses: [],
      });
    } else {
      for (const child of children) stack.push(child);
    }
  }
  return { rootTag, candidates };
}
