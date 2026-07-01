# Agent Notes for marmot-ts

## Commands

- Use `pnpm` in this workspace; CI installs with pnpm 10 and `--frozen-lockfile`.
- `pnpm build` runs `rimraf ./dist` then `tsc -b tsconfig.build.json` for the library only.
- `pnpm compile` is the focused library typecheck/build step; `pnpm lint` is only `prettier --check .`.
- `pnpm test` starts Vitest watch mode. Use `pnpm vitest run` for a one-shot test run.
- Run one test file with `pnpm vitest run src/path/to/file.test.ts`; tests match only `src/**/*.test.ts`.
- Docs are VitePress: `pnpm docs:dev`, `pnpm docs:build`; `docs:build` also runs TypeDoc via `postdocs:build`.

## CI Expectations

- Test CI runs Vitest on Node 20/22/24, Deno 2 via `deno run -A --node-modules-dir=auto npm:vitest run`, and Bun latest/1.1 via `bun run vitest run`.
- Build CI runs `pnpm build`.
- Pre-commit is Husky + lint-staged and only formats staged files with Prettier.

## Package Shape

- This is an ESM TypeScript library for Marmot (MLS over Nostr). Library source is under `src/`.
- Public entrypoints are controlled by `package.json` `exports`: `.`, `./client`, `./core`, `./extra`, `./utils`, and `./mls`.
- `src/index.ts` re-exports client/core/utils only. Extra utilities are exposed through `@internet-privacy/marmot-ts/extra`.
- `src/mls.ts` intentionally re-exports `ts-mls` for downstream apps through the `./mls` subpath.
- Main architecture split: `src/core` is protocol/crypto/state logic with no app I/O; `src/client` adds storage, network, lifecycle, groups, invites, and event-oriented APIs; `src/extra` contains optional store implementations.

## TypeScript Gotchas

- Library TS uses `module`/`moduleResolution: NodeNext`; all relative imports in `src` need the emitted `.js` extension, even when importing `.ts` files.
- Build config is strict and fails on unused locals/parameters and missing returns; tests are excluded from `tsconfig.build.json` but included by root `tsconfig.json` with `noEmit`.
- Use named exports; existing source has no default exports.
- Binary/protocol data is represented with `Uint8Array`; Nostr/MLS helpers commonly use hex conversion from `@noble/hashes/utils.js`.

## Tests

- Tests are colocated under `src/**/__tests__` plus integration tests in `src/__tests__/integration`.
- Shared test doubles live in `src/__tests__/helpers`; prefer those over inline mocks for network/client flows.
- Integration tests use in-memory stores and mock Nostr networking, not external relays or services.

## Docs

- When adding a docs page under `docs/`, also add it to `.vitepress/config.ts`; VitePress uses `srcDir: "docs"`.
- TypeDoc reference is generated from `src/index.ts` into `.vitepress/dist/reference` using `typedoc.json` and `typedocs/cascade-category.mjs`.

## Git Workflow

- Commit after finishing a feature, once it builds and its tests pass; keep each feature in its own commit rather than batching unrelated work.
- Do not commit on the `master` branch; branch first when needed.

---

<!-- GSD:project-start source:PROJECT.md -->
## Project

**marmot-ts**

marmot-ts is an ESM TypeScript library implementing a Marmot (MLS over Nostr) client. It
runs in the browser and natively in Deno, Bun, and Node.js, and is built as layered
abstractions: **ts-mls** (the core MLS engine) → **src/core** (Marmot helpers, constants,
and crypto over MLS) → **src/engine** (a fork-aware state-machine that tracks epochs and
chooses the correct fork to follow) → **src/client** (a convenience layer so downstream
apps can create clients and subscribe to groups easily). It is for developers building
Marmot/Nostr clients who want a spec-conformant MLS implementation without reimplementing
the protocol.

**Core Value:** A downstream client can join a Marmot group and exchange messages that interoperate,
byte-for-byte, with any spec-conformant peer (including the Rust `darkmatter` reference) —
correctly, across every supported runtime.

### Constraints

- **Tech stack**: ESM TypeScript, `module`/`moduleResolution: NodeNext` — all relative
  imports in `src` need emitted `.js` extensions; named exports only; `Uint8Array` for
  binary/protocol data.
- **Compatibility**: Must interoperate byte-for-byte with the Rust darkmatter reference; the
  Rust code + spec are the source of truth for wire format.
- **Cross-platform**: Vitest on Node 20/22/24, Deno 2, and Bun (latest/1.1) must all pass;
  no runtime-specific APIs that break the others.
- **Build**: strict TS config fails on unused locals/params and missing returns; `pnpm` with
  `--frozen-lockfile`; `pnpm lint` is prettier-only.
- **Scope discipline**: single-device wire interop is the finish line; do not build
  multi-device or push in this milestone.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

## Languages
- TypeScript 6.0.3 — all library source under `src/`, strict mode, `module: NodeNext`
- Shell — `scripts/publish-nostr.sh` (release notification)
## Runtime
- Node.js >=20.0.0 (primary target; tested on 20.x, 22.x, 24.x in CI)
- Bun >=1.1.0 (supported; tested on latest and 1.1 in CI)
- Deno >=2.0.0 (supported; tested via `deno run -A --node-modules-dir=auto npm:vitest run` in CI)
- pnpm 10
- Lockfile: `pnpm-lock.yaml` present; CI always runs with `--frozen-lockfile`
## Frameworks
- None (pure ESM TypeScript library; no web or server framework)
- Vitest 3.2.6 — config at `vitest.config.ts`; environment: `node`; matches `src/**/*.test.ts`
- VitePress 2.0.0-alpha.17 — `docs/` as source; built to `.vitepress/dist`
- TypeDoc 0.28.19 — generates API reference from `src/index.ts` into `.vitepress/dist/reference`
- TypeScript compiler (`tsc`) — `tsconfig.build.json` for library emit; `tsconfig.json` for type-checking (includes tests, `noEmit`)
- rimraf ~6.0.1 — cleans `dist/` before build
- Prettier 3.9.3 — formatting; config at `.prettierrc` (2-space indent, spaces not tabs)
- Husky 9.1.7 + lint-staged 17.0.8 — pre-commit hook formats staged files only
- @changesets/cli 2.31.0 — changelog management; config at `.changeset/config.json`; publishes with npm provenance (`changeset publish --provenance`)
## Key Dependencies
- `ts-mls` (workspace `./ts-mls`, v2.0.0-rc.14) — MLS RFC 9420 implementation; the foundational cryptographic group protocol engine
- `@hpke/core` ^1.9.0 — Hybrid Public Key Encryption (HPKE); used by ts-mls and directly for key encapsulation
- `@noble/ciphers` ^2.2.0 — ChaCha20-Poly1305 (`src/utils/nip44-binary.ts`), AES (`src/core/`)
- `@noble/curves` ^2.2.0 — secp256k1 ECDH and signing (`src/utils/nip44-binary.ts`, credential derivation)
- `@noble/hashes` ^2.2.0 — SHA-256, HKDF, HMAC, PBKDF2 (`src/utils/`, `src/core/`)
- `@scure/base` ^2.2.0 — base64/hex encoding utilities
- `applesauce-core` ^6.2.0 — Nostr event model, event store, helpers; provides `NostrEvent`, `Filter`, key helpers
- `applesauce-common` ^6.2.0 — gift-wrap (NIP-59) factories and helpers; used in welcome delivery
- `debug` ^4.4.3 — scoped debug logging throughout library
- `eventemitter3` ^5.0.4 — EventEmitter used in client layer
- `applesauce-accounts` ^6.2.0 — `PrivateKeyAccount` used in all integration and client tests; not a runtime dependency of the library itself
## Workspace Layout
- `.` — the main library (`@internet-privacy/marmot-ts`)
- `ts-mls` — local MLS implementation (submodule / nested package)
- `examples/*` — example applications (`opentui`, `forker`, `tunnels`)
## TypeScript Configuration
- Target: `ES2022`
- Module/ModuleResolution: `NodeNext` (requires `.js` extension on all relative imports in `src/`)
- Strict: all `noImplicit*`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitReturns`
- Output: `dist/` with declarations and source maps
- Excludes: test files and `__tests__` directories
- Extends `tsconfig.build.json`
- Adds `noEmit: true`; includes `src` and `__tests__`; types: `vitest`, `vitest/globals`, `node`
## Public Entrypoints
- `.` → `dist/index.js` — re-exports client + core + utils + engine surface
- `./mls` → `dist/mls.js` — re-exports `ts-mls` for downstream apps
- `./client` → `dist/client/index.js`
- `./core` → `dist/core/index.js`
- `./engine` → `dist/engine/index.js`
- `./audit` → `dist/audit/index.js`
- `./extra` → `dist/extra/index.js`
- `./extra/audit/node` → `dist/extra/audit/node.js`
- `./extra/audit/browser` → `dist/extra/audit/browser.js`
- `./utils` → `dist/utils/index.js`
## Configuration
- No `.env` files present in repo
- Required secrets are injected via GitHub Actions environment variables (`NPM_TOKEN`, `NOSTR_KEY`, `GITHUB_TOKEN`)
- `tsconfig.build.json` — TypeScript emit config
- `typedoc.json` — TypeDoc reference generation
- `vitest.config.ts` — test runner config
## Platform Requirements
- Node.js 20+ with pnpm 10
- Runtime-agnostic ESM library (Node.js 20+, Bun 1.1+, Deno 2+)
- Published to npm as `@internet-privacy/marmot-ts` with public access
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

## Naming Patterns
- kebab-case throughout: `group-engine.ts`, `key-package-event-decode.ts`, `in-memory-key-value-store.ts`
- Test files: same name with `.test.ts` suffix, placed under `__tests__/` sibling directories
- Helper/utility files: descriptive nouns or verb-noun pairs: `mock-network.ts`, `account-proof.ts`
- camelCase for all functions: `createGroup`, `generateKeyPackage`, `encodeVarint`, `decodeContent`
- Async generator functions (ingest pipelines): prefixed with action verb, e.g., `ingestEnvelopes` in `src/engine/ingest.ts`
- camelCase everywhere: `clientState`, `adminPubkey`, `ciphersuiteImpl`
- Destructured option objects preserve camelCase from the type
- PascalCase: `MarmotGroupEngine`, `CreateGroupParams`, `SendResult`, `IngestResult`
- Discriminated union types use a `kind` string literal discriminant: `{ kind: "processed" | "skipped" | "rejected" | ... }`
- Generic type parameters: single uppercase letter or short PascalCase: `TEnvelope`, `T`
- Protocol-level named constants: SCREAMING_SNAKE_CASE: `ADDRESSABLE_KEY_PACKAGE_KIND`, `MAX_VARINT`, `AGENT_TEXT_STREAM_ROLE_RECEIVE` (see `src/core/protocol.ts`, `src/core/binary.ts`)
- Exported enum-like object namespaces: camelCase: `groupLifecycleStates`, `convergenceStatuses`, `inputCategories` (see `src/core/group-lifecycle.ts`, `src/core/inbound.ts`)
- Private module-level constants: SCREAMING_SNAKE_CASE: `ROLE_MASK`, `COMPONENT_STATE_LEN`, `ALLOWED_RUMOR_KEYS`
- Test-file top-level constants: SCREAMING_SNAKE_CASE: `ADMIN`, `MEMBER`, `CIPHERSUITE`, `RELAY`
- Native `#` private fields (not TypeScript `private`): `#state`, `#lifecycle`, `#retained`, `#tree`
- See `src/engine/group-engine.ts` for the canonical pattern
## Code Style
- Tool: Prettier
- Config: `/home/user/Projects/marmot-ts/.prettierrc` — `tabWidth: 2`, `useTabs: false`
- Pre-commit hook (Husky + lint-staged) formats staged files only
- No root ESLint config; `ts-mls` subpackage has its own `eslint.config.mjs`
- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns` (build fails on violations)
## Import Organization
## Error Handling
- Throw `new Error(message)` for domain/validation failures: wrong credential type, invalid binary encoding, missing required state
- Custom error subclasses for codec failures: `BinaryDecodeError` in `src/core/binary.ts` — subclasses `Error`, sets `this.name`
- Result types for expected multi-outcome flows (discriminated unions via `kind`) rather than try/catch at caller boundary
- Async errors propagate as rejected Promises; callers use `await expect(...).rejects.toThrow(...)`
## Logging
## Comments
- `@param name - description`
- `@returns description`
- `@throws description of what triggers it`
- `@see cross-reference to spec doc`
## Function Design
- `Promise<T>` for async operations
- `AsyncGenerator<IngestResult<TEnvelope>>` for streaming ingest pipelines
- Discriminated unions for multi-outcome results (never `null | result`)
## Module Design
- Named exports only — no default exports anywhere in `src/`
- Re-export aggregators via `index.ts` barrel files per directory: `src/core/index.ts`, `src/client/index.ts`
- Each major directory has an `index.ts` that re-exports with `export * from "./module.js"`
- `src/index.ts` aggregates only `client`, `core`, and `utils`; engine internals are accessed via the `./engine` subpath export
- All binary protocol data is `Uint8Array`
- Hex encoding/decoding via `@noble/hashes/utils.js`: `bytesToHex`, `hexToBytes`
- No `Buffer` usage (must stay runtime-agnostic for Deno and Bun)
## Discriminated Union Pattern
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

## System Overview
```text
```
## Component Responsibilities
| Component | Responsibility | File |
|-----------|----------------|------|
| `MarmotGroupEngine` | Transport-agnostic MLS state machine: ingest, send, fork recovery, lifecycle | `src/engine/group-engine.ts` |
| `GroupPeeler<TEnvelope>` | Crypto bridge — peel/wrap transport envelopes to/from MLS messages | `src/engine/types.ts` |
| `NostrGroupPeeler` | Implements `GroupPeeler<NostrEvent>` for Nostr kind-445 events | `src/client/group/nostr-peeler.ts` |
| `GroupHistoryTree` | Full-fork history tree keyed by MLS confirmation tag; persisted | `src/engine/history-tree.ts` |
| `RetainedHistoryStore` | Canonical states within rollback horizon for convergence rewind | `src/engine/retained-store.ts` |
| `IngestionPool` | Holds undecryptable envelopes for retry as tree grows | `src/engine/ingestion-pool.ts` |
| `ForkRecovery` | Builds candidate branches and selects canonical branch | `src/engine/fork-recovery.ts` |
| `ingestEnvelopes` | Pure ingest pipeline function (stateless, driven by `IngestContext`) | `src/engine/ingest.ts` |
| `GroupSession` | Wires `NostrGroupPeeler` into engine; translates engine types to Nostr events | `src/client/session/group-session.ts` |
| `GroupRuntime` | Drives Nostr publish effects; confirms or rolls back staged state | `src/client/runtime/group-runtime.ts` |
| `MarmotGroup` | Public facade: composes `GroupSession` + `GroupRuntime` + stores | `src/client/group/marmot-group.ts` |
| `GroupsManager` | Manages a collection of `MarmotGroup` instances; handles join/load | `src/client/groups-manager.ts` |
| `MarmotClient` | Top-level client API: groups, invites, key packages, welcome preview | `src/client/marmot-client.ts` |
| `core/*` | Protocol definitions, MLS extensions, convergence primitives, lifecycle FSM | `src/core/` |
| `audit/*` | Optional forensic audit log: sink, emitter, recorder | `src/audit/` |
| `extra/*` | Optional store implementations and platform-specific audit sinks | `src/extra/` |
## Pattern Overview
- `MarmotGroupEngine<TEnvelope>` is fully transport-agnostic via the `GroupPeeler<TEnvelope>` interface — the engine never touches Nostr types
- `src/core` has zero I/O dependencies; it contains only pure protocol/crypto/state logic
- Publish-before-apply: local commits are staged (`PendingPublish`) before publish is confirmed; state advances only on confirmation
- Fork detection and convergence run inside the engine on every ingest batch; the lifecycle FSM (`Stable → PendingPublish → Merging → Recovering → Stable`) is the single source of truth for when outbound work is safe
- All binary/protocol data uses `Uint8Array`; hex conversion uses `@noble/hashes/utils.js`
## Layers
- Purpose: Protocol/crypto/state primitives with no I/O
- Location: `src/core/`
- Contains: MLS extensions, group lifecycle FSM, convergence policy/selection, credential helpers, key-package encoding, group-message crypto, binary codec, Nostr event builders
- Depends on: `ts-mls`, `@noble/*`, `applesauce-core`
- Used by: engine, client
- Purpose: Transport-agnostic MLS group state machine
- Location: `src/engine/`
- Contains: `MarmotGroupEngine`, `GroupHistoryTree`, `RetainedHistoryStore`, `IngestionPool`, `ForkRecovery`, `ingestEnvelopes`, `DeliveredPayloadLedger`, admin policy, dedup, convergence status, wire-format helpers
- Depends on: `src/core/`, `ts-mls`
- Used by: client (`GroupSession`)
- Purpose: Nostr-flavored wrappers, storage lifecycle, group/invite/key-package management
- Location: `src/client/`
- Contains: `MarmotGroup`, `GroupSession`, `GroupRuntime`, `GroupsManager`, `MarmotClient`, `NostrGroupPeeler`, `NostrWelcomeDelivery`, `InviteManager`, `KeyPackageManager`
- Depends on: engine, core, `applesauce-core`, `applesauce-common`, `eventemitter3`
- Used by: application code
- Purpose: Optional forensic audit log (opt-in, does not affect protocol)
- Location: `src/audit/`
- Contains: `AuditSink` (interface), `AuditEmitter`, `AuditRecorder`, event type definitions
- Depends on: core (for type references only)
- Used by: engine, client (both accept an optional `audit?: AuditSink`)
- Purpose: Optional store implementations and platform-specific audit sinks
- Location: `src/extra/`
- Contains: `InMemoryKeyValueStore`, `EncryptedKeyValueStore`, `KeyValueRumorHistoryBackend`, `browser.ts`/`node.ts` audit sinks
- Depends on: utils, audit, `@noble/ciphers`, `@noble/hashes`
- Used by: application code (opt-in)
- Purpose: Shared cross-cutting utilities
- Location: `src/utils/`
- Contains: `debug.ts` (logger), `key-value.ts` (store interface), `encoding.ts`, `nostr.ts`, `nip44-binary.ts`, `timestamp.ts`, `relay-url.ts`
## Data Flow
### Inbound: Receiving a Nostr group message
### Outbound: Sending a message or commit
### Welcome / Invite flow
- Canonical group state (`ts-mls` `ClientState`) lives in `MarmotGroupEngine.#state`
- Persisted via `GenericKeyValueStore<SerializedClientState>` injected into `MarmotGroup`
- Fork history tree persisted via a separate `GenericKeyValueStore<Uint8Array>` (`rewindStore`)
- No global module-level state; all group state is instance-owned
## Key Abstractions
- Purpose: Decouples the engine from Nostr — any transport implementing this interface can drive the engine
- Methods: `peelGroupMessages(envelopes, state)`, `wrapGroupMessage(message, state)`, `idOf(envelope)`
- Concrete implementation: `NostrGroupPeeler` (`src/client/group/nostr-peeler.ts`)
- Purpose: Storage abstraction used for group state, history tree, history backend
- Implementations: `InMemoryKeyValueStore` (`src/extra/in-memory-key-value-store.ts`), `EncryptedKeyValueStore` (`src/extra/encrypted-key-value-store.ts`)
- Purpose: Governs branch selection — `maxRewindCommits`, quiescence window, witness quorum
- Default: `DEFAULT_CONVERGENCE_POLICY` (profile version 1)
- Used by: `MarmotGroupEngine`, `ForkRecovery`, `RetainedHistoryStore`, `IngestionPool`
- States: `Stable | PendingPublish | Merging | Recovering | Unrecoverable`
- Legal transitions enforced by `transitionLifecycle()` — throws on illegal move
- Gates when local commits may be prepared (`mayPrepareLocalCommit`) and when outbound may be released
- Purpose: Optional forensic audit log — callers opt in by passing `audit` + `auditContext` to engine/group
- Both engine and client layer accept it; no-op when absent
## Entry Points
- Re-exports client, core, utils, plus selected engine exports
- Consumed by `@internet-privacy/marmot-ts` import (`.` subpath)
- Exposes `MarmotGroupEngine`, `GroupPeeler`, ingest types, `ForkRecovery`, retained store
- For callers building a custom transport layer
- Exposes `MarmotClient`, `MarmotGroup`, `GroupsManager`, `GroupSession`, `GroupRuntime`, `NostrNetworkInterface`
- Re-exports all of `ts-mls` for downstream apps that need raw MLS primitives
## Architectural Constraints
- **Threading:** Single-threaded ESM event loop; no worker threads. `MarmotGroupEngine.ingest()` is an `AsyncGenerator`; callers must drain it fully before the next batch.
- **Global state:** None. All state is per-instance. The `debug` logger namespace (`marmot:*`) is module-level but read-only.
- **Circular imports:** None observed. Dependency direction is strict: `utils ← core ← engine ← client`.
- **`.js` extensions:** All relative imports in `src/` require the emitted `.js` extension (NodeNext module resolution). Violating this breaks the build.
- **Named exports only:** No default exports in the library source.
- **`ts-mls` local workspace:** `ts-mls` is a local workspace package at `./ts-mls`, not from npm. It must be built (`pnpm --filter ts-mls build`) before the library.
## Anti-Patterns
### Importing engine types through the client barrel
### Mutating `MarmotGroupEngine.state` directly
### Calling `ingest()` without draining the generator
## Error Handling
- `transitionLifecycle()` (`src/core/group-lifecycle.ts`) throws on illegal FSM transitions
- `ingestEnvelopes()` (`src/engine/ingest.ts`) emits `unreadable`/`rejected`/`skipped` results rather than throwing
- `GroupHistoryTree.recordCommit()` (`src/engine/history-tree.ts`) logs tree errors rather than propagating them (tree hiccups must not break protocol processing)
- Audit errors in `AuditEmitter.emit()` are caught and silenced (non-blocking, best-effort)
## Cross-Cutting Concerns
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

| Skill | Description | Path |
|-------|-------------|------|
| applesauce | Reactive Nostr SDK for TypeScript and JavaScript built on RxJS and a single in-memory EventStore. Use whenever the user is building or modifying a Nostr client, working with NIP events/filters/pointers, subscribing to relays or pools, managing accounts/signers, loading events, publishing/replying/reacting/following, rendering note content, working with NIP-17/44/46/57/60/65, or wiring reactive React UI over Nostr data. Prefer this skill any time the user is in a TS/JS Nostr context, even if they have not named applesauce explicitly. | `.agents/skills/applesauce/SKILL.md` |
| opentui | Build terminal UIs with OpenTUI. Covers the core API, native audio, keymaps, React and Solid bindings, components, layout, keyboard input, plugins, and testing. | `.agents/skills/opentui/SKILL.md` |
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
