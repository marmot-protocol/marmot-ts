import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type {
  ForkTreeNodeView,
  ForkTreeView,
} from "@internet-privacy/marmot-ts/client";

import type { MessageMeta } from "../marmot/server.js";

/** One epoch "stop" on a fork's root→tip timeline. */
export interface TimelineStop {
  node: ForkTreeNodeView;
  /** Distance from the root (0 = root). Used to align stops across columns. */
  depth: number;
  /** True while this node still matches the canonical path at the same depth. */
  shared: boolean;
  /** True for the exact node where this fork first leaves the canonical path. */
  divergePoint: boolean;
  /** Application messages decrypted at this node, oldest first. */
  messages: Rumor[];
}

/** One fork (root→tip branch): the column shown in the timeline. */
export interface TimelineFork {
  /** Tip (fork head) node tag. */
  tag: string;
  /** Tip epoch. */
  epoch: number;
  canonical: boolean;
  isCanonicalTip: boolean;
  /** Root→tip stops, one per epoch. */
  stops: TimelineStop[];
  /** Total application messages anywhere on this branch. */
  totalMessages: number;
}

/** The full side-by-side timeline: one column per fork, aligned by depth. */
export interface Timeline {
  forks: TimelineFork[];
  /** Deepest stop across all forks (rows needed to render every column). */
  maxDepth: number;
  /** Whether more than one branch exists (i.e. there is anything to compare). */
  diverged: boolean;
}

/**
 * Group decrypted rumors by the fork-tree node they decrypted at, using the
 * captured {@link MessageMeta}. Messages with no recorded tag (legacy rows) are
 * dropped — they can't be placed on a node. Each bucket is sorted oldest-first.
 */
function messagesByTag(
  messages: Rumor[],
  meta: Record<string, MessageMeta>,
): Map<string, Rumor[]> {
  const out = new Map<string, Rumor[]>();
  for (const rumor of messages) {
    const tag = meta[rumor.id]?.tag;
    if (!tag) continue;
    const bucket = out.get(tag);
    if (bucket) bucket.push(rumor);
    else out.set(tag, [rumor]);
  }
  for (const bucket of out.values())
    bucket.sort((a, b) => a.created_at - b.created_at);
  return out;
}

/**
 * Build a side-by-side {@link Timeline}: one column per fork head, each a
 * root→tip sequence of epoch stops carrying the messages decrypted there.
 *
 * Stops are indexed by depth so the shared prefix of two branches lines up
 * horizontally — the divergence point (where a member's view splits from the
 * canonical one) is the first row where the columns stop matching. The canonical
 * branch is placed first as the reference column; the rest follow by epoch.
 */
export function buildTimeline(
  view: ForkTreeView,
  messages: Rumor[],
  meta: Record<string, MessageMeta>,
): Timeline {
  const byTag = new Map(view.nodes.map((n) => [n.tag, n]));
  const byNode = messagesByTag(messages, meta);
  const canonicalPath = view.canonicalPath;

  /** The root→tip path of nodes for a tip tag (root first). */
  const pathTo = (tip: string): ForkTreeNodeView[] => {
    const out: ForkTreeNodeView[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = tip;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = byTag.get(cur);
      if (!node) break;
      out.push(node);
      cur = node.parentTag;
    }
    return out.reverse();
  };

  const forks: TimelineFork[] = view.tips.map((tip): TimelineFork => {
    const path = pathTo(tip);
    let stillShared = true;
    let totalMessages = 0;
    const stops = path.map((node, depth): TimelineStop => {
      const shared = stillShared && canonicalPath[depth] === node.tag;
      const divergePoint = stillShared && !shared;
      if (!shared) stillShared = false;
      const msgs = byNode.get(node.tag) ?? [];
      totalMessages += msgs.length;
      return { node, depth, shared, divergePoint, messages: msgs };
    });
    const tipNode = byTag.get(tip);
    return {
      tag: tip,
      epoch: tipNode?.epoch ?? 0,
      canonical: tipNode?.canonical ?? false,
      isCanonicalTip: tipNode?.isCanonicalTip ?? false,
      stops,
      totalMessages,
    };
  });

  // Canonical column first (the reference everyone is compared against), then
  // the rest by deepest epoch so the longest-lived forks come next.
  forks.sort((a, b) => {
    if (a.isCanonicalTip !== b.isCanonicalTip) return a.isCanonicalTip ? -1 : 1;
    return b.epoch - a.epoch || (a.tag < b.tag ? -1 : 1);
  });

  const maxDepth = Math.max(
    0,
    ...forks.map((f) => (f.stops.length ? f.stops.length - 1 : 0)),
  );

  return { forks, maxDepth, diverged: view.tips.length > 1 };
}
