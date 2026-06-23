# Agent Notes for tunnels

A headless Marmot **group-history debugger** — a Hono SSR server with one MLS
identity that gets invited into groups and renders their full fork history.
Standalone package inside the `marmot-ts` pnpm workspace.

## Commands

- `pnpm install` — install deps (run from this dir or the workspace root).
- `pnpm dev` — `tsx watch src/index.tsx` (live-reload); server at `http://localhost:3000`.
- `pnpm build` — `tsc` into `dist/`.
- `pnpm start` — `node dist/index.js` (requires a prior build).
- `pnpm typecheck` — `tsc --noEmit`. **This is the verification step** (no tests, no lint).

## Architecture

- `src/index.tsx` — entrypoint: reads env config, builds + starts the server, mounts the Hono routes (`/` group list, `/:groupId` fork-tree overview, `/:groupId/timeline` side-by-side conversations timeline, `/:groupId/:tag` single-epoch page). The `timeline` route is registered before `/:groupId/:tag` so the static segment wins.
- `src/marmot/setup.ts` — `configFromEnv` + `createServer`: wires SQLite stores (including the durable `events` archive of raw kind-445 events), the applesauce relay pool + event loader, and a `MarmotClient` with **infinite retention** (`maxRewindCommits`/`appPayloadPastEpochLimit` = `Infinity`, ingestion-pool bounds = `Infinity`).
- `src/marmot/server.ts` — `TunnelServer`: lifecycle (publish identity, create-or-rotate KeyPackage, follow + connect groups, auto-accept invites) and read accessors for the HTTP layer. It is a **passive observer** — never sends/commits/self-updates, so it doesn't disturb watched groups. It drives kind-445 ingest itself (instead of `connectAll`) so it can capture, per application message, the `MessageMeta` (MLS epoch + fork-tree node tag) it decrypted at — neither lives on the stored rumor. `processed` application messages are on the selected (canonical) branch; the engine also surfaces messages that decrypt **only on a non-canonical branch** as `invalidated` results, each now carrying the decrypted `payload` plus the fork node (`tag` + `epoch`) it belongs to. The library persists `processed` rumors itself, so the server only records their meta; for `invalidated` results it saves the rumor to `group.history` _and_ records its meta, keyed by `${groupId}:${rumorId}` in the `message_epochs` table. That is what gives the full fork view — losing-branch messages land on their own node. The richer `invalidated` shape (payload/tag/epoch) is a library change (`engine/types.ts`), populated in both producing paths (the tree sweep and the rewind retraction); no app-side re-decryption is needed. Every kind-445 event also passes through the durable `events` archive (`#eventArchive`, keyed `${groupId}:${eventId}`); on connect the server replays the archive (`#loadArchivedEvents`) before the relay backfill, so the full history — forks, app-message convergence witnesses, branch activity — is rebuilt from local state even when relays have pruned those events. Also exposes `messageMetaFor`, `epochDetail` (committer pubkey via the parent epoch's roster + decoded commit proposals), and `committersByTag` (committer-only, batched/deduped resolution for every timeline stop).
- `src/views/*.tsx` — Hono JSX: `layout` (shell + CSS), `group-list`, `group-overview` (per-group: metadata + the clickable fork tree + per-fork participant progress), `epoch` (single-epoch page: committer, proposals, messages), `fork-graph` (the SVG branching-timeline renderer with per-node message counts and per-node `/:groupId/:tag` links, laid out git-graph style from `group.forkTreeView()`), and `timeline` (the side-by-side conversations view: one vertical root→tip column per fork, stops aligned by depth via CSS grid so the shared prefix lines up and the divergence point stands out).
- `src/helpers/*` — `fork-stats` (pure per-node/per-fork aggregation: `computeNodeStats`, `summarizeForks`), `timeline` (`buildTimeline`: pure per-fork root→tip stop sequences with per-stop messages + shared/divergence flags), `sqlite-store` (`node:sqlite` KV store), `relay-pool`, `discovery`, `prefixed-store`, `account-proof`, `format`.

## Runtime requirements

- **Node 22.5+** for the built-in `node:sqlite` module (developed on Node 24, where it needs no flag). `@types/node` must be ≥ 24 for the `node:sqlite` types.

## Config (env vars)

`TUNNELS_SECRET`, `TUNNELS_OUTBOX_RELAYS`, `TUNNELS_INBOX_RELAYS`, `TUNNELS_RELAYS`
(shared fallback), `TUNNELS_DATA`, `TUNNELS_GROUP_TTL_HOURS` (optional inactivity
TTL — purge groups idle this many hours; unset = retain forever), `PORT`. See
`README.md` for the full table. Group "last active" = newest kind-445
`created_at`, tracked in `TunnelServer.#lastActive` (updated in `#connect`'s
`drain`), exposed via `lastActive(idStr)`; the `/` list sorts by it and a
`setInterval` sweep (`#sweepExpired` → `#purgeGroup`) drops idle groups via
`client.groups.destroy` (no publish — keeps the passive-observer contract) plus
manual clearing of the tunnels-owned `events`/`message_epochs` sidecars.

## JSX

- Hono's JSX runtime (`jsxImportSource: "hono/jsx"`). Do not switch to React/Preact.
- Use `FC` from `hono/jsx` for component types.
- SVG elements are written as JSX; attribute names are kebab-case (`stroke-width`, `text-anchor`).
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.

## TypeScript

- `module`/`moduleResolution` are both `NodeNext`. Relative imports must use `.js` extensions (even from `.ts`/`.tsx` sources).
- `skipLibCheck: true` — third-party type errors are suppressed.
- The default `MarmotGroup` type erases the history store; narrow `group.history` back to `GroupRumorHistory` (as `index.tsx` does) to query rumors.

## Workspace context

- Included in the root `pnpm-workspace.yaml` under `examples/*`. Root-level `pnpm build`/`pnpm test` do not run this example; work here is isolated.

## Git Workflow

- Commit after completing a feature or significant change, once `pnpm build` succeeds.
- Do not commit on the `master` branch; branch first when needed.
