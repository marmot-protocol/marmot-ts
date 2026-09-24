/** @module @category Core - App Components */
import { nodeTypes, type ClientState, type LeafNode } from "ts-mls";

import { bytesEqual } from "./bytes.js";

/**
 * A single non-blank leaf in a resulting ratchet tree that is new or was
 * re-signed relative to a parent tree, paired with its true MLS leaf index.
 *
 * `parentLeaf` is the prior occupant of the same MLS leaf index in the parent
 * tree (Phase 9, UPD-01): the leaf a caller compares this changed leaf's
 * account identity against. It is `undefined` exactly when the parent node at
 * that index was absent or not a leaf — a brand-new or previously-blank slot
 * — meaning there is no prior identity to preserve (an Add into a freed slot
 * legitimately has a different identity than whoever occupied the slot
 * before it was removed).
 */
export interface ChangedLeaf {
  leafIndex: number;
  leaf: LeafNode;
  parentLeaf?: LeafNode;
}

/**
 * Structural diff between two ratchet trees (D-02): the pure input
 * {@link validateCommitAccountIdentityProofs} (`./integrity.js`) diffs to find
 * every changed leaf a commit must re-validate the `0x8009` proof of, without
 * relying on ts-mls exposing a `StagedCommit`/proposal-derived changed-leaf
 * list.
 *
 * Walks even node indices (leaf positions) from `0` up to the greater of the
 * two trees' lengths (tree width grows on Add). For each resulting node:
 * - a blank or absent node (removed, or beyond either tree's width) is
 *   skipped — blanked leaves are never validated (D-02);
 * - a leaf whose `signature` bytes are byte-identical to the parent leaf at
 *   the same node index is skipped — unchanged leaves are trusted, validated
 *   at join or when they last changed (D-01), so re-verifying the whole tree
 *   on every commit is unnecessary;
 * - every other resulting leaf (new via Add, or re-signed via an Update
 *   proposal or the committer's own update-path leaf) is returned.
 *
 * Comparing `leaf.signature` byte-inequality (via {@link bytesEqual}, which
 * already treats two `undefined` values as equal) is a safe, zero-dependency
 * proxy for "this leaf's content changed": every `LeafNode` (all three
 * `leafNodeSource` variants — key_package/update/commit) signs over its own
 * full TBS content, so any content change forces a new signature (Assumption
 * A1, 08-RESEARCH.md). ts-mls's own `leafNodeEncoder`/`leafNodeEqual` helpers
 * are not exported from its package root and `leafNodeEqual` itself only
 * compares `signaturePublicKey` (insufficient — it would miss an `extensions`
 * change with an unchanged signature key) — do not use either.
 *
 * `leafIndex` is the true MLS tree leaf index (`nodeIndex / 2`) — this is
 * NOT the same numbering `validateGroupMemberAccountIdentityProofs` uses
 * internally (`./account-identity-proof.js`, a tree-walk-skipping-blanks
 * member enumeration that differs from the tree index once any leaf is
 * blank). Callers that need to report a MLS leaf position MUST use this
 * function's `leafIndex`, never that helper's enumeration index.
 *
 * @see refs/mdk/crates/cgka-engine/src/account_identity_proof.rs `validate_staged_commit_account_identity_proofs`
 */
export function diffChangedLeaves(
  parentTree: ClientState["ratchetTree"],
  resultingTree: ClientState["ratchetTree"],
): ChangedLeaf[] {
  const changed: ChangedLeaf[] = [];
  const maxLength = Math.max(parentTree.length, resultingTree.length);
  for (let nodeIndex = 0; nodeIndex < maxLength; nodeIndex += 2) {
    const before = parentTree[nodeIndex];
    const after = resultingTree[nodeIndex];
    if (!after || after.nodeType !== nodeTypes.leaf) continue;
    const beforeLeaf =
      before && before.nodeType === nodeTypes.leaf ? before.leaf : undefined;
    if (beforeLeaf && bytesEqual(beforeLeaf.signature, after.leaf.signature))
      continue;
    changed.push({
      leafIndex: nodeIndex / 2,
      leaf: after.leaf,
      parentLeaf: beforeLeaf,
    });
  }
  return changed;
}
