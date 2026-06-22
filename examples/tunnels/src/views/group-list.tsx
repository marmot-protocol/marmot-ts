import type { FC } from "hono/jsx";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { groupName } from "../marmot/server.js";
import { Layout } from "./layout.js";

export interface GroupSummary {
  group: MarmotGroup;
  epoch: number;
  members: number;
  tips: number;
  nodes: number;
}

/** Build a lightweight summary row for one followed group. */
export function summarize(group: MarmotGroup): GroupSummary {
  const view = group.forkTreeView();
  return {
    group,
    epoch: group.info.mls.epochNumber,
    members: group.info.members.count,
    tips: view.tips.length,
    nodes: view.nodes.length,
  };
}

/** The index page: every group the server is currently following. */
export const GroupList: FC<{
  npub: string;
  outboxRelays: string[];
  inboxRelays: string[];
  groups: GroupSummary[];
}> = ({ npub, outboxRelays, inboxRelays, groups }) => (
  <Layout title="tunnels — groups" npub={npub}>
    <section class="panel">
      <h2>Observer</h2>
      <div class="meta">
        <div>
          <span class="k">following</span>
          {groups.length} group(s)
        </div>
        <div>
          <span class="k">outbox</span>
          <span class="mono">{outboxRelays.join(", ") || "—"}</span>
        </div>
        <div>
          <span class="k">inbox</span>
          <span class="mono">{inboxRelays.join(", ") || "—"}</span>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>Groups</h2>
      {groups.length === 0 ? (
        <div class="empty">
          Not in any groups yet. Invite <code>{npub}</code> to a Marmot group
          and it will appear here.
        </div>
      ) : (
        groups.map(({ group, epoch, members, tips, nodes }) => (
          <a class="group-card" href={`/${group.idStr}`}>
            <div>
              <div class="name">{groupName(group)}</div>
              <div class="sub">{group.idStr}</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <span class="pill">epoch {epoch}</span>
              <span class="pill">{members} members</span>
              <span class="pill">{nodes} nodes</span>
              <span class={tips > 1 ? "pill fork" : "pill tip"}>
                {tips} head{tips === 1 ? "" : "s"}
              </span>
            </div>
          </a>
        ))
      )}
    </section>
  </Layout>
);
