import type { FC } from "hono/jsx";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import { formatTime } from "../helpers/format.js";
import { groupName } from "../marmot/server.js";
import { Layout } from "./layout.js";
import { QrCode } from "./qr.js";

export interface GroupSummary {
  group: MarmotGroup;
  epoch: number;
  members: number;
  tips: number;
  nodes: number;
  /** Newest event `created_at` (unix seconds), or 0 if nothing ingested yet. */
  lastActive: number;
}

/** Build a lightweight summary row for one followed group. */
export function summarize(group: MarmotGroup, lastActive = 0): GroupSummary {
  const view = group.forkTreeView();
  return {
    group,
    epoch: group.info.mls.epochNumber,
    members: group.info.members.count,
    tips: view.tips.length,
    nodes: view.nodes.length,
    lastActive,
  };
}

/** Compact "Nd/Nh/Nm ago" for a unix-seconds timestamp (empty if 0). */
function relativeTime(seconds: number): string {
  if (!seconds) return "";
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
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
        groups.map(({ group, epoch, members, tips, nodes, lastActive }) => (
          <a class="group-card" href={`/${group.idStr}`}>
            <div>
              <div class="name">{groupName(group)}</div>
              <div class="sub">{group.idStr}</div>
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              <span
                class="pill"
                title={lastActive ? formatTime(lastActive) : "no activity yet"}
              >
                {lastActive ? `active ${relativeTime(lastActive)}` : "idle"}
              </span>
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

    <section class="panel invite">
      <h2>Invite this observer</h2>
      <div class="invite-row">
        <QrCode value={npub} />
        <div>
          <p>Scan to invite, or add this npub to a Marmot group:</p>
          <code class="npub">{npub}</code>
        </div>
      </div>
    </section>
  </Layout>
);
