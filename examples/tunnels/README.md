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
3. Ingests every kind-445 group event with the engine configured to retain and
   process everything (`maxRewindCommits` / `appPayloadPastEpochLimit` and both
   ingestion-pool bounds set to `Infinity`).
4. Serves a web UI: `/` lists the followed groups, `/<group-id>` renders that
   group's fork-history graph, current fork heads, and decrypted application
   messages — each tagged with the MLS epoch it was decrypted at (captured
   during ingest, since the stored rumor itself carries no epoch).

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

| Variable                | Default                              | Purpose                                                                   |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `TUNNELS_SECRET`        | generated + saved to `identity.key`  | 32-byte hex Nostr secret. When set, it's authoritative (not stored).      |
| `TUNNELS_OUTBOX_RELAYS` | `TUNNELS_RELAYS` → built-in defaults | NIP-65 (kind 10002) relays: profile, relay lists, KeyPackage.             |
| `TUNNELS_INBOX_RELAYS`  | `TUNNELS_RELAYS` → built-in defaults | Welcome-inbox (kind 10050) relays: where invites are watched.             |
| `TUNNELS_RELAYS`        | built-in defaults                    | Shared fallback for both inbox and outbox when the specific var is unset. |
| `TUNNELS_DATA`          | `./data`                             | Directory for the SQLite database and the generated identity key.         |
| `PORT`                  | `3000`                               | HTTP port for the web UI.                                                 |

Relay lists are comma-separated, e.g.
`TUNNELS_OUTBOX_RELAYS="wss://relay.damus.io,wss://nos.lol"`.

To follow a group, invite the npub printed on startup (`identity: npub1…`) to a
Marmot group from any Marmot client; the group appears at `/` within moments.

## Storage

All state lives in one SQLite database (`$TUNNELS_DATA/state.db`) via the
built-in `node:sqlite` module, split into tables: `groups` (serialized MLS
state), `rewind` (fork-history blobs), `keypackages`, `invites`, `messages`
(per-group rumor history, namespaced by group id), and `message_epochs` (the
epoch each message was decrypted at, keyed by `${groupId}:${rumorId}`). The
identity is reused across restarts, so the server keeps its group memberships.
