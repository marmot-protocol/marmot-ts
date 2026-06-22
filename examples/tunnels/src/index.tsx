import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { GroupRumorHistory } from "@internet-privacy/marmot-ts/client";

import { configFromEnv, createServer } from "./marmot/setup.js";
import { GroupList, summarize } from "./views/group-list.js";
import { GroupTimeline } from "./views/group-timeline.js";
import { Layout } from "./views/layout.js";

const config = configFromEnv();
const server = await createServer(config);
await server.start();

const app = new Hono();

app.get("/", (c) => {
  const groups = server.groups().map(summarize);
  return c.html(
    <GroupList
      npub={server.npub}
      outboxRelays={server.outboxRelays}
      inboxRelays={server.inboxRelays}
      groups={groups}
    />,
  );
});

app.get("/:groupId", async (c) => {
  const groupId = c.req.param("groupId");
  const group = server.group(groupId);
  if (!group) {
    c.status(404);
    return c.html(
      <Layout title="tunnels — not found" npub={server.npub}>
        <section class="panel">
          <h2>Group not found</h2>
          <div class="empty">
            <code>{groupId}</code> is not a group this server follows.{" "}
            <a href="/">Back to all groups</a>.
          </div>
        </section>
      </Layout>,
    );
  }

  // history is wired by the rumor-history factory in setup.ts, but the default
  // MarmotGroup type erases it — narrow back to the concrete store.
  const history = group.history as unknown as GroupRumorHistory | undefined;
  const messages = history ? await history.queryRumors({}) : [];
  const epochs = await server.epochsFor(
    groupId,
    messages.map((m) => m.id),
  );

  return c.html(
    <GroupTimeline
      npub={server.npub}
      group={group}
      view={group.forkTreeView()}
      messages={messages}
      epochs={epochs}
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
