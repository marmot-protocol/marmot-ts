# External Integrations

**Analysis Date:** 2026-07-07

## APIs & External Services

**Nostr relays (transport):**
- The library is transport-agnostic and BYO-network. Downstream apps supply an implementation of `NostrNetworkInterface` (`src/client/nostr-interface.ts`), which merges `NostrPoolWrite` (`publish`) and `NostrPoolRead` (`request`, `subscription`) plus group-specific operations.
- No relay URLs are hardcoded in the library; relay lists are passed in by callers and discovered from Nostr relay-list events.
- SDK/Client: `applesauce-core` provides `NostrEvent` and `Filter` models. There is no bundled relay pool — callers wire their own (e.g. applesauce pools in examples/tests).
- Auth: none at the transport layer; message authenticity is via MLS + Nostr event signatures.

**MLS protocol engine:**
- `ts-mls` `2.0.0-rc.14` (local workspace `./ts-mls`) - RFC 9420 MLS implementation. Re-exported to downstream via the `./mls` subpath.

**Nostr event kinds used (`src/core/protocol.ts`):**
- `10002` - Relay list (`RELAY_LIST_KIND`)
- `10050` - Inbox/DM relay list (`INBOX_RELAY_LIST_KIND`)
- `30443` - Addressable KeyPackage (`ADDRESSABLE_KEY_PACKAGE_KIND`); content is MLSMessage-framed (`mls_key_package`)
- `445` - Group event / handshake + application messages (`GROUP_EVENT_KIND`)
- `444` - Welcome event (`WELCOME_EVENT_KIND`)

## Data Storage

**Databases:**
- None. The library defines a storage abstraction `GenericKeyValueStore` (`src/utils/key-value.ts`) that callers implement.

**File Storage:**
- No direct filesystem access in library source. Optional store implementations live in `src/extra/`:
  - `InMemoryKeyValueStore` (`src/extra/in-memory-key-value-store.ts`)
  - `EncryptedKeyValueStore` (`src/extra/encrypted-key-value-store.ts`) - AES/ChaCha encryption via `@noble/ciphers`
  - `KeyValueRumorHistoryBackend`

**Caching:**
- None. Group state, fork-history tree, and rumor history are persisted through injected key-value stores; no external cache.

## Authentication & Identity

**Auth Provider:**
- Nostr keys (secp256k1). Identity is a Nostr keypair; credentials are derived and bound into MLS via `src/core/` credential helpers.
- Signing/ECDH via `@noble/curves` (secp256k1). Encryption for DMs/welcomes via NIP-44 binary (`src/utils/nip44-binary.ts`) and NIP-59 gift-wrap (`applesauce-common`).
- No OAuth or third-party identity provider. Tests use `PrivateKeyAccount` from `applesauce-accounts`.

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry/telemetry integration.

**Logs:**
- `debug` `^4.4.3` scoped logger, namespace `marmot:*` (`src/utils/debug.ts`).
- Optional forensic audit log (`src/audit/`): `AuditSink` interface, `AuditEmitter`, `AuditRecorder`. Opt-in via `audit?: AuditSink` on engine/client; no-op when absent. Platform sinks in `src/extra/audit/{node,browser}.ts`.

## CI/CD & Deployment

**Hosting:**
- npm registry - Published as `@internet-privacy/marmot-ts` (public, with provenance)
- GitHub Pages - Docs site (`.github/workflows/pages.yml`)

**CI Pipeline (`.github/workflows/`):**
- `tests.yml` - Vitest on Node 20/22/24, Deno 2, Bun latest/1.1
- `build.yml` - `pnpm build`
- `release.yml` - Changesets publish with npm provenance
- `pages.yml` - VitePress docs deploy

## Environment Configuration

**Required env vars (CI/release only):**
- `NPM_TOKEN` - npm publish auth
- `NOSTR_KEY` - release announcement signing (`scripts/publish-nostr.sh`)
- `GITHUB_TOKEN` - GitHub Actions / release

**Secrets location:**
- GitHub Actions repository/environment secrets. No `.env` files in the repo.

## Webhooks & Callbacks

**Incoming:**
- None (library, not a server).

**Outgoing:**
- Nostr relay publishes driven by `GroupRuntime` (`src/client/runtime/group-runtime.ts`) through the injected `NostrNetworkInterface`.
- Release announcement published to Nostr via `scripts/publish-nostr.sh`.

---

*Integration audit: 2026-07-07*
