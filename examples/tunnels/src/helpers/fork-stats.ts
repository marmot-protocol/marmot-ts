import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type {
  ForkTreeNodeView,
  ForkTreeView,
} from "@internet-privacy/marmot-ts/client";

import type { MessageMeta } from "../marmot/server.js";

/** Per-fork-node aggregation of decrypted application messages. */
export interface NodeStats {
  /** Application-message count per node tag. */
  countByTag: Map<string, number>;
  /** Per node tag, a map of sender pubkey → message count at that node. */
  sendersByTag: Map<string, Map<string, number>>;
}

/**
 * Attribute decrypted messages to the exact fork-tree node they decrypted at,
 * using the captured {@link MessageMeta}. Messages with no recorded tag (legacy
 * rows from before per-fork capture) are skipped — they can't be placed.
 */
export function computeNodeStats(
  messages: Rumor[],
  meta: Record<string, MessageMeta>,
): NodeStats {
  const countByTag = new Map<string, number>();
  const sendersByTag = new Map<string, Map<string, number>>();
  for (const rumor of messages) {
    const tag = meta[rumor.id]?.tag;
    if (!tag) continue;
    countByTag.set(tag, (countByTag.get(tag) ?? 0) + 1);
    let senders = sendersByTag.get(tag);
    if (!senders) {
      senders = new Map();
      sendersByTag.set(tag, senders);
    }
    senders.set(rumor.pubkey, (senders.get(rumor.pubkey) ?? 0) + 1);
  }
  return { countByTag, sendersByTag };
}

/** One participant's footprint on a fork (branch): how far they got, how much. */
export interface ForkParticipant {
  pubkey: string;
  /** Highest epoch on this branch where they sent an application message. */
  lastEpoch: number;
  /** Total messages they sent across this branch. */
  count: number;
}

/** A summary of one fork (root → tip branch) and who progressed how far on it. */
export interface ForkSummary {
  /** Tip (fork head) node tag. */
  tag: string;
  /** Tip epoch. */
  epoch: number;
  canonical: boolean;
  isCanonicalTip: boolean;
  /** Total application messages decrypted anywhere on this branch. */
  totalMessages: number;
  /** Participants on this branch, ordered by how far they progressed. */
  participants: ForkParticipant[];
}

/**
 * Summarize every fork head: walk each tip's root→tip path and, per sender,
 * record the deepest epoch they sent a message at and their message total. This
 * shows where each member is across forks and how far down a branch they got.
 */
export function summarizeForks(
  view: ForkTreeView,
  stats: NodeStats,
): ForkSummary[] {
  const byTag = new Map(view.nodes.map((n) => [n.tag, n]));

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
    return out;
  };

  return view.tips
    .map((tip): ForkSummary => {
      const tipNode = byTag.get(tip);
      const perUser = new Map<string, ForkParticipant>();
      let totalMessages = 0;
      for (const node of pathTo(tip)) {
        const senders = stats.sendersByTag.get(node.tag);
        if (!senders) continue;
        for (const [pubkey, count] of senders) {
          totalMessages += count;
          const entry = perUser.get(pubkey) ?? {
            pubkey,
            lastEpoch: -1,
            count: 0,
          };
          entry.count += count;
          entry.lastEpoch = Math.max(entry.lastEpoch, node.epoch);
          perUser.set(pubkey, entry);
        }
      }
      return {
        tag: tip,
        epoch: tipNode?.epoch ?? 0,
        canonical: tipNode?.canonical ?? false,
        isCanonicalTip: tipNode?.isCanonicalTip ?? false,
        totalMessages,
        participants: [...perUser.values()].sort(
          (a, b) => b.lastEpoch - a.lastEpoch || b.count - a.count,
        ),
      };
    })
    .sort((a, b) => b.epoch - a.epoch);
}
