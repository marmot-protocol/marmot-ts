# External Integrations

**Analysis Date:** 2026-07-01

## Nostr Protocol Network

**Role:** Core transport layer for all Marmot protocol messages.

The library is BYO-network: it defines interfaces (`NostrPool`, `NostrNetworkInterface` in `src/client/nostr-interface.ts`) and the caller supplies the relay pool implementation. There are no hard-coded relay URLs in the library source.

**Protocols implemented (NIP compliance):**
- NIP-01 — base Nostr event format; `NostrEvent` type from `applesauce-core/helpers/event`
- NIP-44 v2 — binary encryption for application content; custom implementation in `src/utils/nip44-binary.ts` using `@noble/ciphers/chacha`, `@noble/curves/secp256k1`, `@noble/hashes`
- NIP-59 — gift-wrap for welcome message delivery; uses `applesauce-common/helpers/gift-wrap` and `applesauce-common/operations/gift-wrap`
- NIP-65 — relay list discovery (kind 10002) for finding recipient inbox relays; constant `NIP65_RELAY_LIST_KIND = 10002` in `src/core/protocol.ts`

**Nostr relay interface (library side):**
```typescript
// src/client/nostr-interface.ts
interface NostrNetworkInterface {
  publish(relays: string[], event: NostrEvent): Promise<Record<string, PublishResponse>>;
  request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]>;
  subscription(relays: string[], filters: Filter | Filter[]): Subscribable<NostrEvent>;
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
```

**Example app relay pool:**
In `examples/opentui`, `applesauce-relay` ^6.2.0 provides `AsRelayPool` with WebSocket relay connections.

**Release notifications:**
On successful npm publish, `.github/workflows/release.yml` runs `scripts/publish-nostr.sh` using the `nak` CLI to post a Nostr event. Requires `NOSTR_KEY` secret (nsec or hex private key).
- `nak` binary: downloaded from `https://github.com/fiatjaf/nak/releases/latest/download/nak-linux-amd64` during CI

## Blossom (Distributed File Protocol)

**Role:** Media storage and retrieval for group attachments.

Blossom is a file-serving protocol where servers expose SHA-256-addressed blobs at `GET /<sha256>`. The library defines the `blossom-v1` locator type for media within MLS application messages.

**Implementation:**
- `src/core/media/locator.ts` — defines `blossom-v1` locator type; validates that locator URLs are `https`
- `src/core/media/imeta.ts` — validates that `blossom-v1` locator URLs are HTTPS-only, non-loopback, routable hosts
- `src/core/components/host-safety.ts` — shared host safety check (non-routable host rejection) used for blossom and avatar URLs

**Example app integration:**
`examples/opentui` depends on `blossom-client-sdk` ^5.0.0 for actual uploads. The library itself only contains the wire-format parsing and URL safety logic — it does not perform HTTP fetches.

**Auth:** None in library (blossom auth is handled by client apps via blossom-client-sdk).

## Goggles Audit Tracker

**Role:** Optional HTTP endpoint for uploading audit JSONL log files.

**Implementation:**
- `src/extra/audit/node.ts` — `uploadAuditLogFile(path, endpoint, options)` function
- Sends `POST` with `Content-Type: application/x-ndjson` body
- Auth: Bearer token via `Authorization` header (required for non-loopback HTTPS endpoints)
- Source identification: `X-Goggles-Device-Label`, `X-Goggles-Platform`, `X-Goggles-App-Version` headers
- Max file size: 64 MiB; file name must match `audit-*.jsonl`
- Endpoint must be `https:` (or loopback `http:` for local testing)
- Uses global `fetch`; injectable for tests via `options.fetch`

**Endpoint:** Caller-supplied HTTPS URL; no hardcoded endpoint in library.

## Data Storage

**Databases:**
- None in the library itself — storage is abstraction-based (BYO storage pattern)
- `src/extra/in-memory-key-value-store.ts` — in-memory key-value store (default/test)
- `src/extra/encrypted-key-value-store.ts` — encrypted wrapper over any key-value store backend
- `src/extra/key-value-rumor-history-backend.ts` — rumor history storage using key-value store

**Browser Storage (audit logs):**
- IndexedDB — `src/extra/audit/browser.ts` → `IndexedDbAuditWriter`; database name defaults to `"marmot-audit-logs"`, store name defaults to `"lines"`
- OPFS (Origin Private File System) — `src/extra/audit/browser.ts` → `OpfsAuditWriter`; uses `navigator.storage.getDirectory()`
- Auto-select: `AutoBrowserAuditWriter` picks OPFS if available, falls back to IndexedDB

**Node.js Storage (audit logs):**
- Filesystem (JSONL) — `src/extra/audit/node.ts` → `NodeJsonlAuditWriter` (async) and `NodeJsonlAuditRecorder` (sync); writes append-only JSONL files

**Connection:** No connection string or env var required; paths are caller-supplied.

## Authentication & Identity

**Auth Provider:** Custom / Nostr keypair identity.

- Nostr private keys (secp256k1) are the identity primitive; no external auth provider
- `applesauce-accounts` package (dev dependency in library, runtime in examples) provides `PrivateKeyAccount` for signing events
- MLS credentials carry the Nostr public key (`src/core/credential.ts`)
- `src/core/auth-service.ts` handles account identity proof verification

## NPM Registry

**Role:** Library distribution.

- Registry: `registry.npmjs.org`
- Package name: `@internet-privacy/marmot-ts`
- Auth: `NPM_TOKEN` secret (set in `~/.npmrc` during CI release)
- Published with npm provenance (`--provenance` flag via `changeset publish`)
- Trigger: push to `master` branch via `changesets/action@v1` in `.github/workflows/release.yml`

## CI/CD & Deployment

**CI Platform:** GitHub Actions

**Workflows:**
- `.github/workflows/tests.yml` — runs `pnpm vitest run` on Node 20/22/24, Deno v2, Bun latest/1.1 on every push/PR
- `.github/workflows/build.yml` — runs `pnpm build` on every push/PR; uploads `dist/` as artifact
- `.github/workflows/release.yml` — on push to `master`: creates changeset PR or publishes to npm; posts Nostr release notification
- `.github/workflows/pages.yml` — on push to `master`: builds VitePress docs and deploys to GitHub Pages

**Docs Hosting:** GitHub Pages at `https://<org>.github.io/marmot-ts/`

## Webhooks & Callbacks

**Incoming:** None — library has no HTTP server.

**Outgoing:**
- Nostr relay WebSocket connections (consumer responsibility, not library-managed)
- Blossom server HTTPS requests (consumer responsibility via blossom-client-sdk)
- Goggles tracker HTTPS POST (via `uploadAuditLogFile` in `src/extra/audit/node.ts`)

## Environment Configuration

**Required secrets (GitHub Actions only):**
- `NPM_TOKEN` — npm publish authentication (release workflow)
- `NOSTR_KEY` — Nostr private key for release notification (release workflow)
- `GITHUB_TOKEN` — automatically provided by GitHub Actions

**No environment variables are required to develop, build, or test the library.** All network targets are injected by the consumer at runtime.

---

*Integration audit: 2026-07-01*
