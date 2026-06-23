import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { GroupRumorHistory } from "@internet-privacy/marmot-ts/client";

import { computeNodeStats, summarizeForks } from "./helpers/fork-stats.js";
import { buildTimeline } from "./helpers/timeline.js";
import { configFromEnv, createServer } from "./marmot/setup.js";
import { EpochPage } from "./views/epoch.js";
import { GroupList, summarize } from "./views/group-list.js";
import { GroupOverview } from "./views/group-overview.js";
import { Layout } from "./views/layout.js";
import { TimelinePage } from "./views/timeline.js";

const config = configFromEnv();
const server = await createServer(config);
await server.start();

const app = new Hono();

app.get("/", (c) => {
  const groups = server
    .groups()
    .map((group) => summarize(group, server.lastActive(group.idStr)))
    // Most recently active groups first; idle (no activity) sink to the bottom.
    .sort((a, b) => b.lastActive - a.lastActive);
  return c.html(
    <GroupList
      npub={server.npub}
      outboxRelays={server.outboxRelays}
      inboxRelays={server.inboxRelays}
      groups={groups}
    />,
  );
});

/** 404 shell for an unknown group id. */
function groupNotFound(groupId: string) {
  return (
    <Layout title="tunnels — not found" npub={server.npub}>
      <section class="panel">
        <h2>Group not found</h2>
        <div class="empty">
          <code>{groupId}</code> is not a group this server follows.{" "}
          <a href="/">Back to all groups</a>.
        </div>
      </section>
    </Layout>
  );
}

/** Every decrypted rumor for a group, paired with its captured epoch+node meta. */
async function loadMessages(groupId: string) {
  const group = server.group(groupId)!;
  // history is wired by the rumor-history factory in setup.ts, but the default
  // MarmotGroup type erases it — narrow back to the concrete store.
  const history = group.history as unknown as GroupRumorHistory | undefined;
  const messages = history ? await history.queryRumors({}) : [];
  const meta = await server.messageMetaFor(
    groupId,
    messages.map((m) => m.id),
  );
  return { messages, meta };
}

app.get("/:groupId", async (c) => {
  const groupId = c.req.param("groupId");
  const group = server.group(groupId);
  if (!group) {
    c.status(404);
    return c.html(groupNotFound(groupId));
  }

  const { messages, meta } = await loadMessages(groupId);
  const view = group.forkTreeView();
  const stats = computeNodeStats(messages, meta);

  return c.html(
    <GroupOverview
      npub={server.npub}
      group={group}
      view={view}
      countByTag={stats.countByTag}
      forks={summarizeForks(view, stats)}
      nameFor={(pubkey) => server.nameFor(pubkey)}
    />,
  );
});

app.get("/:groupId/timeline", async (c) => {
  const groupId = c.req.param("groupId");
  const group = server.group(groupId);
  if (!group) {
    c.status(404);
    return c.html(groupNotFound(groupId));
  }

  const { messages, meta } = await loadMessages(groupId);
  const view = group.forkTreeView();
  const timeline = buildTimeline(view, messages, meta);
  // Resolve every stop's committer once (deduped across the shared prefix).
  const tags = timeline.forks.flatMap((f) => f.stops.map((s) => s.node.tag));
  const committerByTag = await server.committersByTag(group, tags);

  return c.html(
    <TimelinePage
      npub={server.npub}
      group={group}
      timeline={timeline}
      committerByTag={committerByTag}
      nameFor={(pubkey) => server.nameFor(pubkey)}
    />,
  );
});

app.get("/:groupId/:tag", async (c) => {
  const groupId = c.req.param("groupId");
  const tag = c.req.param("tag");
  const group = server.group(groupId);
  if (!group) {
    c.status(404);
    return c.html(groupNotFound(groupId));
  }

  const { messages, meta } = await loadMessages(groupId);
  const here = messages.filter((m) => meta[m.id]?.tag === tag);
  const detail = await server.epochDetail(group, tag);

  return c.html(
    <EpochPage
      npub={server.npub}
      group={group}
      tag={tag}
      detail={detail}
      messages={here}
      nameFor={(pubkey) => server.nameFor(pubkey)}
    />,
  );
});

const httpServer = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`tunnels running on http://localhost:${info.port}`);
  console.log(`identity: ${server.npub}`);
  console.log(`outbox:   ${config.outboxRelays.join(", ")}`);
  console.log(`inbox:    ${config.inboxRelays.join(", ")}`);
});

function shutdown() {
  console.log("\nshutting down…");
  httpServer.close();
  server.stop();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
