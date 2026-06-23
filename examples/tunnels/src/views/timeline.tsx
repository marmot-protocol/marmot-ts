import type { FC } from "hono/jsx";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type { Timeline, TimelineStop } from "../helpers/timeline.js";
import { formatTime } from "../helpers/format.js";
import { groupName } from "../marmot/server.js";
import { Author } from "./author.js";
import { Layout } from "./layout.js";

const KIND_LABELS: Record<number, string> = {
  9: "chat",
  7: "reaction",
  5: "delete",
};

export interface TimelinePageProps {
  npub: string;
  group: MarmotGroup;
  timeline: Timeline;
  /** Committer pubkey keyed by node tag (for labelling each commit). */
  committerByTag: Record<string, string>;
  nameFor: (pubkey: string) => string;
}

/** Column width + gap must match the grid CSS in layout.tsx. */
const COLS = (n: number) => `grid-template-columns: repeat(${n}, 320px);`;

/**
 * Conversations timeline: every fork of the group rendered as a vertical
 * root→tip column, side by side, so you can read what each member's view of the
 * group looks like. Stops (epochs) are aligned by depth across columns, so the
 * shared prefix lines up and the row where a branch leaves the canonical path —
 * the divergence point — is plain to see. Each stop shows its commit and the
 * application messages that decrypted at that exact state.
 */
export const TimelinePage: FC<TimelinePageProps> = ({
  npub,
  group,
  timeline,
  committerByTag,
  nameFor,
}) => {
  const { forks } = timeline;

  return (
    <Layout title={`tunnels — ${groupName(group)} timeline`} npub={npub} wide>
      <p>
        <a href="/">← all groups</a>
        {" · "}
        <a href={`/${group.idStr}`}>← {groupName(group)}</a>
      </p>

      <section class="panel">
        <h2>Conversations timeline — {forks.length} forks</h2>
        <p class="hint">
          Each column is one fork head, top-to-bottom from the root to that
          branch's tip — i.e. what a member who landed on that branch sees.
          Stops are aligned by depth, so the shared prefix lines up across
          columns and the highlighted row is where a branch leaves the canonical
          path. Each stop carries its commit and the messages decrypted at that
          exact state.
        </p>
        <div class="tl-legend">
          <span class="l-canon">canonical branch</span>
          <span class="l-shared">shared with canonical</span>
          <span class="l-diverge">divergence point</span>
        </div>
      </section>

      {forks.length === 0 ? (
        <section class="panel">
          <div class="empty">No history recorded yet.</div>
        </section>
      ) : (
        <div class="timeline-wrap">
          <div class="timeline-grid" style={COLS(forks.length)}>
            {forks.map((fork, col) => (
              <>
                <div
                  class={`tl-head${fork.isCanonicalTip ? " canon" : ""}`}
                  style={`grid-column: ${col + 1}; grid-row: 1;`}
                >
                  <div class="tl-head-top">
                    <a class="mono" href={`/${group.idStr}/${fork.tag}`}>
                      {fork.tag.slice(0, 12)}
                    </a>
                    {fork.isCanonicalTip ? (
                      <span class="pill canon">canonical</span>
                    ) : (
                      <span class="pill tip">abandoned</span>
                    )}
                  </div>
                  <div class="tl-head-sub">
                    epoch {fork.epoch} · {fork.totalMessages} msg ·{" "}
                    {fork.stops.length} epochs
                  </div>
                </div>

                {fork.stops.map((stop) => (
                  <Stop
                    stop={stop}
                    col={col}
                    groupId={group.idStr}
                    committer={committerByTag[stop.node.tag]}
                    nameFor={nameFor}
                  />
                ))}
              </>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
};

/** One epoch stop in a fork column: commit marker + its messages. */
const Stop: FC<{
  stop: TimelineStop;
  col: number;
  groupId: string;
  committer?: string;
  nameFor: (pubkey: string) => string;
}> = ({ stop, col, groupId, committer, nameFor }) => {
  const { node } = stop;
  const cls = [
    "tl-stop",
    node.canonical ? "canon" : "",
    stop.shared ? "shared" : "",
    stop.divergePoint ? "diverge" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      class={cls}
      style={`grid-column: ${col + 1}; grid-row: ${stop.depth + 2};`}
    >
      <div class="tl-node">
        <span class="tl-dot" />
        <span class="tl-epoch">epoch {node.epoch}</span>
        <a class="mono tl-tag" href={`/${groupId}/${node.tag}`}>
          {node.tag.slice(0, 8)}
        </a>
        {stop.divergePoint && <span class="pill fork">forks here</span>}
        {node.childTags.length > 1 && <span class="pill fork">fork point</span>}
      </div>
      <div class="tl-commit">
        {!node.commit ? (
          <span class="muted">root · from the Welcome</span>
        ) : committer ? (
          <span>
            committed by <Author pubkey={committer} nameFor={nameFor} />
          </span>
        ) : (
          <span class="muted">commit · committer unknown</span>
        )}
      </div>

      {stop.messages.length === 0 ? (
        <div class="tl-nomsg">no messages</div>
      ) : (
        <div class="tl-msgs">
          {stop.messages.map((m) => (
            <div class="tl-msg">
              <div class="tl-msg-hdr">
                <Author pubkey={m.pubkey} nameFor={nameFor} />
                <span class="when">{formatTime(m.created_at)}</span>
                <span class="pill kind">
                  {KIND_LABELS[m.kind] ?? `kind ${m.kind}`}
                </span>
              </div>
              <div class="tl-msg-body">
                {m.content || <em>(no text content)</em>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
