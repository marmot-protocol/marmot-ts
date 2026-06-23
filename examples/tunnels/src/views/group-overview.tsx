import type { FC } from "hono/jsx";

import type {
  MarmotGroup,
  ForkTreeView,
} from "@internet-privacy/marmot-ts/client";

import type { ForkSummary } from "../helpers/fork-stats.js";
import { groupName } from "../marmot/server.js";
import { Author } from "./author.js";
import { ForkGraph } from "./fork-graph.js";
import { Layout } from "./layout.js";

export interface GroupOverviewProps {
  npub: string;
  group: MarmotGroup;
  view: ForkTreeView;
  /** Application-message count keyed by node tag (for the graph annotations). */
  countByTag: Map<string, number>;
  /** Per-fork participant progress. */
  forks: ForkSummary[];
  nameFor: (pubkey: string) => string;
}

/**
 * Per-group page: group metadata, the clickable fork-history epoch tree (each
 * node annotated with its application-message count and linking to its own epoch
 * page), and a per-fork breakdown of which members have sent messages on each
 * branch and how far down it they have progressed.
 */
export const GroupOverview: FC<GroupOverviewProps> = ({
  npub,
  group,
  view,
  countByTag,
  forks,
  nameFor,
}) => {
  const info = group.info;

  return (
    <Layout title={`tunnels — ${groupName(group)}`} npub={npub} wide>
      <p>
        <a href="/">← all groups</a>
        {" · "}
        <a href={`/${group.idStr}/timeline`}>conversations timeline →</a>
      </p>

      <section class="panel">
        <h2>{groupName(group)}</h2>
        <div class="meta">
          <div>
            <span class="k">id</span>
            <span class="mono">{group.idStr}</span>
          </div>
          <div>
            <span class="k">epoch</span>
            {info.mls.epochNumber}
          </div>
          <div>
            <span class="k">members</span>
            {info.members.count}
          </div>
          <div>
            <span class="k">cipher suite</span>
            {info.mls.cipherSuiteName ?? info.mls.cipherSuite}
          </div>
          <div>
            <span class="k">convergence</span>
            {group.convergenceStatus}
          </div>
          <div>
            <span class="k">nodes / heads</span>
            {view.nodes.length} / {view.tips.length}
          </div>
        </div>
      </section>

      <section class="panel">
        <h2>Fork history — {view.nodes.length} epochs</h2>
        <p class="hint">
          Each node is one MLS epoch. Click a node to see its application
          messages, the proposals its commit carried, and who committed it.
        </p>
        <ForkGraph view={view} groupId={group.idStr} countByTag={countByTag} />
      </section>

      <section class="panel">
        <h2>Participants by fork ({forks.length})</h2>
        <p class="hint">
          For each fork head, the members who have sent application messages on
          that branch and the furthest epoch each reached — i.e. where everyone
          sits across the forks and how far along each one they have progressed.
        </p>
        {forks.length === 0 ? (
          <div class="empty">No forks recorded yet.</div>
        ) : (
          forks.map((fork) => (
            <div class="fork-card">
              <div class="fork-hdr">
                <a class="mono" href={`/${group.idStr}/${fork.tag}`}>
                  {fork.tag.slice(0, 12)}
                </a>
                <span class="pill">epoch {fork.epoch}</span>
                {fork.isCanonicalTip ? (
                  <span class="pill canon">canonical (live)</span>
                ) : (
                  <span class="pill tip">abandoned fork</span>
                )}
                <span class="fork-total">{fork.totalMessages} msg</span>
              </div>
              {fork.participants.length === 0 ? (
                <div class="empty">No application messages on this branch.</div>
              ) : (
                <table class="heads">
                  <thead>
                    <tr>
                      <th>member</th>
                      <th>last epoch on fork</th>
                      <th>messages</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fork.participants.map((p) => (
                      <tr>
                        <td>
                          <Author pubkey={p.pubkey} nameFor={nameFor} />
                        </td>
                        <td>
                          {p.lastEpoch}
                          {p.lastEpoch === fork.epoch ? (
                            <span class="pill canon caught-up">caught up</span>
                          ) : (
                            <span class="pill behind">
                              {fork.epoch - p.lastEpoch} behind
                            </span>
                          )}
                        </td>
                        <td>{p.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))
        )}
      </section>
    </Layout>
  );
};
