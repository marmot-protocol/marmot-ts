# tunnels

A Marmot **group-history debugger**. `tunnels` is a headless server with a
single MLS identity that gets invited into groups and then follows _everything_:
it sets retention, fork history, and convergence horizons to infinity, so it can
decrypt and retain **every fork** of every group it joins. A small Hono web UI
renders each group's full history as a branching timeline.

## What it does

1. Publishes a discoverable identity (kind-0 profile, NIP-65 outbox list, and
   kind-10050 inbox list) and a fresh KeyPackage on every start, so anyone can
   invite it.
2. Auto-accepts every joinable invite as a **passive observer** — it joins from
   the Welcome but never self-updates, commits, or sends, so it never disturbs
   the groups it watches.
3. Archives every kind-445 group event to a durable `events` table and ingests
   it with the engine configured to retain and process everything
   (`maxRewindCommits` / `appPayloadPastEpochLimit` and both ingestion-pool bounds
   set to `Infinity`). On startup it **replays the archive** before backfilling
   from relays, so it never depends on relays still serving old events.
   Application messages on the selected (canonical) branch arrive as `processed`;
   messages that decrypt **only on a non-canonical branch** arrive as
   `invalidated` results carrying their decrypted payload and the fork node
   (`tag` + `epoch`) they belong to. The server stores both — so it captures
   every fork's messages, not just the canonical path.
4. Serves a web UI:
   - `/` lists the followed groups.
   - `/<group-id>` renders that group's **fork-history epoch tree** — each node
     annotated with how many application messages decrypted at that exact state
     and linking to its own epoch page — plus a per-fork breakdown of which
     members have sent messages on each branch and the furthest epoch each
     reached (so you can see where members sit across forks and how far down a
     branch they have progressed).
   - `/<group-id>/timeline` is the **conversations timeline**: every fork
     rendered as a vertical root→tip column, side by side, so you can read what
     a member on each branch sees. Stops (epochs) are aligned by depth across
     columns, so the shared prefix lines up and the row where a branch leaves the
     canonical path — the divergence point — is highlighted. Each stop shows its
     commit (and committer) and the messages decrypted at that exact state.
   - `/<group-id>/<node-tag>` is a single epoch's page: who created the commit,
     the proposals it carried, and every application message decrypted there.

   Each message is attributed to the exact fork node (and MLS epoch) it
   decrypted at — captured during ingest, since the stored rumor carries neither
   the node tag nor the epoch. Because non-canonical messages arrive as
   `invalidated` results (with payload + node tag) and are persisted too, messages
   on losing/non-canonical forks appear on their own node, not just the ones the
   canonical path retained.

## Run

```sh
pnpm install
pnpm dev          # tsx watch, http://localhost:3000
```

Build + run compiled output:

```sh
pnpm build
pnpm start
```

Requires **Node 22.5+** (it uses the built-in `node:sqlite` module); developed
on Node 24, where no flag is needed.

## Configuration (environment variables)

| Variable                  | Default                              | Purpose                                                                   |
| ------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `TUNNELS_SECRET`          | generated + saved to `identity.key`  | 32-byte hex Nostr secret. When set, it's authoritative (not stored).      |
| `TUNNELS_OUTBOX_RELAYS`   | `TUNNELS_RELAYS` → built-in defaults | NIP-65 (kind 10002) relays: profile, relay lists, KeyPackage.             |
| `TUNNELS_INBOX_RELAYS`    | `TUNNELS_RELAYS` → built-in defaults | Welcome-inbox (kind 10050) relays: where invites are watched.             |
| `TUNNELS_RELAYS`          | built-in defaults                    | Shared fallback for both inbox and outbox when the specific var is unset. |
| `TUNNELS_DATA`            | `./data`                             | Directory for the SQLite database and the generated identity key.         |
| `TUNNELS_GROUP_TTL_HOURS` | unset (retain forever)               | When > 0, purge groups idle (no kind-445 activity) for this many hours.   |
| `PORT`                    | `3000`                               | HTTP port for the web UI.                                                 |

Relay lists are comma-separated, e.g.
`TUNNELS_OUTBOX_RELAYS="wss://relay.damus.io,wss://nos.lol"`.

To follow a group, invite the npub printed on startup (`identity: npub1…`) to a
Marmot group from any Marmot client; the group appears at `/` within moments.

## Storage

All state lives in one SQLite database (`$TUNNELS_DATA/state.db`) via the
built-in `node:sqlite` module, split into tables: `groups` (serialized MLS
state), `rewind` (fork-history blobs), `keypackages`, `invites`, `messages`
(per-group rumor history, namespaced by group id), `message_epochs` (where
each message decrypted — its MLS epoch _and_ fork-tree node tag — keyed by
`${groupId}:${rumorId}`; legacy epoch-only rows are still read), and `events`
(every raw kind-445 group event, keyed `${groupId}:${eventId}`). The identity is
reused across restarts, so the server keeps its group memberships.

The `events` archive makes the server **relay-independent**: on startup it
replays every archived event into the engine before backfilling from relays, so
the full fork history — including application messages, which act as convergence
witnesses and reveal which branches each member is active on — is reconstructed
from local state even after relays have pruned those events.
