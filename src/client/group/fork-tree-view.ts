/** @module @category Client - Group */
import { bytesToHex } from "@noble/hashes/utils.js";

import type { GroupHistoryTree } from "../../engine/history-tree.js";

/**
 * A plain, serializable view of one node in a group's fork-history tree, shaped
 * for rendering debugging interfaces. Derived from the live
 * {@link GroupHistoryTree}; holds no MLS secrets.
 */
export interface ForkTreeNodeView {
  /** Node id: hex of the MLS confirmation tag. */
  tag: string;
  /** The MLS epoch this state sits at. */
  epoch: number;
  /** Parent node tag, or `undefined` for the root. */
  parentTag?: string;
  /** Child node tags. More than one means a fork at this node. */
  childTags: string[];
  /** Whether this node is a tip (leaf state, no children). */
  isTip: boolean;
  /** Whether this node lies on the canonical path (root → live tip). */
  canonical: boolean;
  /** Whether this node is the canonical (live) tip the client operates on. */
  isCanonicalTip: boolean;
  /** The commit edge that produced this node (absent for the root). */
  commit?: {
    /** Hex of the commit's SHA-256 digest (the edge identity). */
    digestHex: string;
    /** The committer's MLS leaf index, when known. */
    senderLeafIndex?: number;
  };
}

/**
 * A snapshot of a group's full fork-history tree: every observed state, the
 * canonical path the client is on, and the set of competing tips. Computed on
 * demand from the live tree and safe to serialize/send to a UI.
 */
export interface ForkTreeView {
  /** The root node tag (welcome/creation state), or `undefined` if empty. */
  rootTag?: string;
  /**
   * The canonical (live) tip — the node matching the engine's current state.
   * This is the branch the client sends from, chosen by convergence.
   */
  canonicalTip?: string;
  /** Tags on the canonical path, root → canonical tip. */
  canonicalPath: string[];
  /** All tip tags (leaf states), canonical and abandoned. */
  tips: string[];
  /** Every node in the tree. */
  nodes: ForkTreeNodeView[];
}

/**
 * Builds a {@link ForkTreeView} from a {@link GroupHistoryTree} and the
 * canonical (live) tip tag — the confirmation tag of the engine's current
 * state, i.e. the branch convergence settled on. Nodes on the path from the
 * root to that tip are flagged `canonical`.
 */
export function buildForkTreeView(
  tree: GroupHistoryTree,
  canonicalTipTag: string | undefined,
): ForkTreeView {
  const canonicalPath = (canonicalTipTag && tree.path(canonicalTipTag)) || [];
  const onCanonical = new Set(canonicalPath);

  const nodes: ForkTreeNodeView[] = tree.tags().map((tag) => {
    const node = tree.node(tag)!;
    return {
      tag: node.tag,
      epoch: node.epoch,
      parentTag: node.parentTag,
      childTags: node.childTags,
      isTip: node.childTags.length === 0,
      canonical: onCanonical.has(tag),
      isCanonicalTip: tag === canonicalTipTag,
      commit: node.edge
        ? {
            digestHex: bytesToHex(node.edge.commitDigest),
            senderLeafIndex: node.edge.senderLeafIndex,
          }
        : undefined,
    };
  });

  return {
    rootTag: tree.rootTag,
    canonicalTip: canonicalTipTag,
    canonicalPath,
    tips: tree.tips(),
    nodes,
  };
}
