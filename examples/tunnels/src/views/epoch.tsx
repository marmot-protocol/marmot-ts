import type { FC } from "hono/jsx";

import type { Rumor } from "applesauce-common/helpers/gift-wrap";

import type { MarmotGroup } from "@internet-privacy/marmot-ts/client";

import type { EpochDetail } from "../marmot/server.js";
import { formatTime } from "../helpers/format.js";
import { groupName } from "../marmot/server.js";
import { Author } from "./author.js";
import { Layout } from "./layout.js";

const KIND_LABELS: Record<number, string> = {
  9: "chat",
  7: "reaction",
  5: "delete",
};

export interface EpochPageProps {
  npub: string;
  group: MarmotGroup;
  /** The node tag this page is for. */
  tag: string;
  detail: EpochDetail;
  /** Application messages decrypted at this exact node. */
  messages: Rumor[];
  nameFor: (pubkey: string) => string;
}

/**
 * Per-epoch page: one fork-tree node. Shows the node's place in the tree, who
 * created the commit that produced it, the proposals that commit carried, and
 * every application message that decrypted at this exact state.
 */
export const EpochPage: FC<EpochPageProps> = ({
  npub,
  group,
  tag,
  detail,
  messages,
  nameFor,
}) => {
  const node = detail.node;

  return (
    <Layout title={`tunnels — epoch ${node?.epoch ?? "?"}`} npub={npub} wide>
      <p>
        <a href="/">← all groups</a>
        {" · "}
        <a href={`/${group.idStr}`}>← {groupName(group)}</a>
      </p>

      {!node ? (
        <section class="panel">
          <h2>Epoch not found</h2>
          <div class="empty">
            <code>{tag.slice(0, 16)}</code> is not a node in this group's fork
            history.
          </div>
        </section>
      ) : (
        <>
          <section class="panel">
            <h2>
              Epoch {node.epoch}
              {node.isCanonicalTip ? (
                <span class="pill canon">canonical (live) tip</span>
              ) : node.canonical ? (
                <span class="pill canon">on canonical path</span>
              ) : node.isTip ? (
                <span class="pill tip">abandoned fork head</span>
              ) : (
                <span class="pill">superseded fork</span>
              )}
              {node.childTags.length > 1 && (
                <span class="pill fork">fork point</span>
              )}
            </h2>
            <div class="meta">
              <div>
                <span class="k">node tag</span>
                <span class="mono">{node.tag}</span>
              </div>
              <div>
                <span class="k">parent</span>
                {node.parentTag ? (
                  <a class="mono" href={`/${group.idStr}/${node.parentTag}`}>
                    {node.parentTag.slice(0, 12)}
                  </a>
                ) : (
                  <span class="mono">root</span>
                )}
              </div>
              <div>
                <span class="k">children</span>
                {node.childTags.length}
              </div>
              <div>
                <span class="k">messages here</span>
                {messages.length}
              </div>
            </div>
            {node.childTags.length > 0 && (
              <div class="children">
                <span class="k">child epochs</span>
                {node.childTags.map((child) => (
                  <a class="mono pill" href={`/${group.idStr}/${child}`}>
                    {child.slice(0, 10)}
                  </a>
                ))}
              </div>
            )}
          </section>

          <section class="panel">
            <h2>Commit</h2>
            {!node.commit ? (
              <div class="empty">
                Root state — created from the Welcome, no commit.
              </div>
            ) : (
              <>
                <div class="meta">
                  <div>
                    <span class="k">committer</span>
                    {detail.committerPubkey ? (
                      <Author
                        pubkey={detail.committerPubkey}
                        nameFor={nameFor}
                      />
                    ) : (
                      <span class="muted">unknown</span>
                    )}
                  </div>
                  <div>
                    <span class="k">committer leaf</span>
                    {detail.committerLeaf ?? "—"}
                  </div>
                  <div>
                    <span class="k">commit digest</span>
                    <span class="mono">
                      {node.commit.digestHex.slice(0, 16)}
                    </span>
                  </div>
                </div>
                <h3 class="sub-h">
                  Proposals ({detail.proposals.length})
                  {!detail.commitDecoded && (
                    <span class="pill" title="commit bytes unavailable">
                      not decoded
                    </span>
                  )}
                </h3>
                {detail.proposals.length === 0 ? (
                  <div class="empty">
                    {detail.commitDecoded
                      ? "Self-update commit (no proposals)."
                      : "Commit message unavailable — proposals not decoded."}
                  </div>
                ) : (
                  <ul class="proposals">
                    {detail.proposals.map((p) => (
                      <li>
                        <span class="pill prop">{p.type}</span>
                        {p.pubkey && (
                          <Author pubkey={p.pubkey} nameFor={nameFor} />
                        )}
                        {p.detail && <span class="muted mono">{p.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section class="panel">
            <h2>Application messages ({messages.length})</h2>
            {messages.length === 0 ? (
              <div class="empty">
                No application messages decrypted at this epoch.
              </div>
            ) : (
              messages.map((rumor) => (
                <div class="msg">
                  <div class="hdr">
                    <Author pubkey={rumor.pubkey} nameFor={nameFor} />
                    <span class="when">{formatTime(rumor.created_at)}</span>
                    <span class="pill kind">
                      {KIND_LABELS[rumor.kind] ?? `kind ${rumor.kind}`}
                    </span>
                  </div>
                  <div class="body">
                    {rumor.content || <em>(no text content)</em>}
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </Layout>
  );
};
