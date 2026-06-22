import type { FC } from "hono/jsx";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type {
  MarmotGroup,
  ForkTreeView,
} from "@internet-privacy/marmot-ts/client";

import { formatTime } from "../helpers/format.js";
import { groupName } from "../marmot/server.js";
import { ForkGraph } from "./fork-graph.js";
import { Layout } from "./layout.js";

export interface TimelineProps {
  npub: string;
  group: MarmotGroup;
  view: ForkTreeView;
  messages: Rumor[];
  /** Epoch each message was decrypted at, keyed by rumor id. */
  epochs: Record<string, number>;
  nameFor: (pubkey: string) => string;
}

const KIND_LABELS: Record<number, string> = {
  9: "chat",
  7: "reaction",
  5: "delete",
};

/** Per-group page: metadata, the fork-history graph, fork heads, and messages. */
export const GroupTimeline: FC<TimelineProps> = ({
  npub,
  group,
  view,
  messages,
  epochs,
  nameFor,
}) => {
  const info = group.info;
  const heads = view.tips
    .map((tag) => view.nodes.find((n) => n.tag === tag))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .sort((a, b) => b.epoch - a.epoch);

  return (
    <Layout title={`tunnels — ${groupName(group)}`} npub={npub}>
      <p>
        <a href="/">← all groups</a>
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
        <h2>Fork history</h2>
        <ForkGraph view={view} />
      </section>

      <section class="panel">
        <h2>Fork heads ({heads.length})</h2>
        <table class="heads">
          <thead>
            <tr>
              <th>state</th>
              <th>epoch</th>
              <th>branch</th>
              <th>committer leaf</th>
            </tr>
          </thead>
          <tbody>
            {heads.map((n) => (
              <tr>
                <td class="mono">{n.tag.slice(0, 12)}</td>
                <td>{n.epoch}</td>
                <td>
                  {n.isCanonicalTip ? (
                    <span class="pill canon">canonical (live)</span>
                  ) : (
                    <span class="pill tip">abandoned fork</span>
                  )}
                </td>
                <td class="mono">{n.commit?.senderLeafIndex ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section class="panel">
        <h2>Application messages ({messages.length})</h2>
        {messages.length === 0 ? (
          <div class="empty">No decrypted application messages.</div>
        ) : (
          messages.map((rumor) => (
            <div class="msg">
              <div class="hdr">
                <span class="who">{nameFor(rumor.pubkey)}</span>
                <span class="when">{formatTime(rumor.created_at)}</span>
                <span class="pill kind">
                  {KIND_LABELS[rumor.kind] ?? `kind ${rumor.kind}`}
                </span>
                {epochs[rumor.id] !== undefined ? (
                  <span class="pill canon">epoch {epochs[rumor.id]}</span>
                ) : (
                  <span class="pill" title="epoch not captured this run">
                    epoch ?
                  </span>
                )}
              </div>
              <div class="body">
                {rumor.content || <em>(no text content)</em>}
              </div>
            </div>
          ))
        )}
      </section>
    </Layout>
  );
};
