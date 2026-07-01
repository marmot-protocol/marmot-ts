# Codebase Structure

**Analysis Date:** 2026-07-01

## Directory Layout

```
marmot-ts/
├── src/                          # Library source (TypeScript ESM)
│   ├── index.ts                  # Root barrel: re-exports client + core + utils + selected engine
│   ├── mls.ts                    # ./mls subpath: re-exports all of ts-mls
│   ├── core/                     # Protocol/crypto/state — no I/O
│   │   ├── components/           # MLS extension components (group profile, capabilities, etc.)
│   │   ├── media/                # Encrypted-media-v1 types and locator helpers
│   │   └── __tests__/            # Core unit tests
│   ├── engine/                   # Transport-agnostic MLS group state machine
│   │   └── __tests__/            # Engine unit tests
│   ├── client/                   # Nostr-flavored client layer
│   │   ├── group/                # MarmotGroup facade + group-level helpers
│   │   │   ├── proposals/        # Proposal builders (leave, etc.)
│   │   │   └── __tests__/
│   │   ├── session/              # GroupSession (engine wiring) + GroupEffects types
│   │   │   └── __tests__/
│   │   ├── runtime/              # GroupRuntime (Nostr publish effects)
│   │   │   └── __tests__/
│   │   ├── transport/
│   │   │   └── nostr/            # NostrWelcomeDelivery (NIP-59 gift-wrap)
│   │   └── __tests__/
│   ├── audit/                    # Optional forensic audit log
│   │   └── __tests__/
│   ├── extra/                    # Optional store implementations + platform audit sinks
│   │   ├── audit/                # browser.ts / node.ts audit sinks
│   │   └── __tests__/
│   ├── utils/                    # Cross-cutting utilities
│   │   └── __tests__/
│   └── __tests__/
│       ├── helpers/              # Shared test doubles (mock network, account proof)
│       └── integration/          # Integration tests (in-memory stores, mock Nostr)
├── ts-mls/                       # Local workspace package: TypeScript MLS implementation
├── darkmatter/                   # Rust reference implementation (separate workspace)
│   └── crates/                   # Rust crates (cgka-engine, agent-connector, etc.)
├── examples/
│   ├── opentui/                  # Terminal UI example app (React + OpenTUI)
│   └── forker/                   # Adversarial fork-injection example server
├── docs/                         # VitePress documentation source
│   └── .vitepress/               # VitePress config (srcDir: "docs")
├── scripts/                      # Release scripts
├── dist/                         # Build output (generated, not committed)
├── .claude/                      # Claude project config
├── .agents/
│   └── skills/                   # Agent skills (applesauce, opentui)
├── .changeset/                   # Changeset version bump entries
├── .cursor/rules/                # Cursor IDE rules
├── package.json                  # Package manifest, exports map, dependencies
├── tsconfig.json                 # Root tsconfig (includes tests, noEmit)
├── tsconfig.build.json           # Build tsconfig (excludes tests, emits to dist/)
├── vitest.config.ts              # Vitest configuration
├── typedoc.json                  # TypeDoc configuration
└── pnpm-workspace.yaml           # pnpm workspace definition (includes ts-mls)
```

## Directory Purposes

**`src/core/`:**
- Purpose: Protocol and crypto primitives with zero I/O dependencies
- Contains: MLS extensions (`components/`), group lifecycle FSM, convergence policy/selection, credential helpers, key-package encode/decode, group-message crypto, Nostr event builders, binary codec, protocol constants
- Key files: `convergence.ts`, `group-lifecycle.ts`, `client-state.ts`, `group-message.ts`, `key-package-event.ts`, `protocol.ts`, `auth-service.ts`

**`src/engine/`:**
- Purpose: Transport-agnostic MLS group state machine
- Contains: `MarmotGroupEngine` (coordinator), `GroupHistoryTree` (fork DAG), `RetainedHistoryStore`, `IngestionPool`, `ForkRecovery`, `ingestEnvelopes` pipeline, admin policy, dedup, wire-format helpers
- Key files: `group-engine.ts`, `history-tree.ts`, `retained-store.ts`, `ingestion-pool.ts`, `fork-recovery.ts`, `ingest.ts`, `types.ts`

**`src/client/`:**
- Purpose: Nostr-specific wrappers, storage lifecycle, group/invite/key-package management
- Contains: `MarmotGroup` (facade), `GroupSession`, `GroupRuntime`, `GroupsManager`, `MarmotClient`, `NostrGroupPeeler`, `NostrWelcomeDelivery`
- Key files: `marmot-client.ts`, `groups-manager.ts`, `group/marmot-group.ts`, `session/group-session.ts`, `runtime/group-runtime.ts`, `group/nostr-peeler.ts`, `transport/nostr/welcome-delivery.ts`, `nostr-interface.ts`

**`src/audit/`:**
- Purpose: Optional forensic audit log — callers opt in via `audit?: AuditSink`
- Contains: `AuditSink` interface, `AuditEmitter`, `AuditRecorder`, type definitions
- Key files: `types.ts`, `sink.ts`, `emitter.ts`, `recorder.ts`

**`src/extra/`:**
- Purpose: Optional, swappable implementations not required by core protocol
- Contains: `InMemoryKeyValueStore`, `EncryptedKeyValueStore`, `KeyValueRumorHistoryBackend`, platform audit sinks
- Key files: `in-memory-key-value-store.ts`, `encrypted-key-value-store.ts`, `key-value-rumor-history-backend.ts`, `audit/browser.ts`, `audit/node.ts`

**`src/utils/`:**
- Purpose: Shared utility helpers used across all layers
- Contains: `debug.ts` (root logger), `key-value.ts` (store interface), `encoding.ts`, `nostr.ts`, `nip44-binary.ts`, `timestamp.ts`, `relay-url.ts`
- Key files: `key-value.ts` (defines `GenericKeyValueStore<V>`), `debug.ts`

**`src/__tests__/`:**
- Purpose: Integration tests and shared test helpers
- `helpers/`: `mock-network.ts`, `account-proof.ts` — shared doubles for integration tests
- `integration/`: full end-to-end scenarios using in-memory stores and mock Nostr relay

**`ts-mls/`:**
- Purpose: Local workspace dependency providing the TypeScript MLS implementation
- Not part of the library source; referenced as `"ts-mls": "./ts-mls"` in `package.json`
- Must be built with `pnpm --filter ts-mls build` before building the library

**`darkmatter/`:**
- Purpose: Rust reference implementation (separate Cargo workspace); not shipped with the npm package
- Contains: `cgka-engine`, `agent-connector`, `agent-control`, `cgka-conformance-simulator` crates

**`examples/`:**
- Purpose: Standalone example applications (not part of published package)
- `opentui/`: Terminal UI example using React + OpenTUI + applesauce
- `forker/`: Adversarial server that joins groups and deliberately forks admin groups

## Key File Locations

**Entry Points:**
- `src/index.ts`: Root barrel (`.` subpath export)
- `src/mls.ts`: MLS re-export (`./mls` subpath)
- `src/client/index.ts`: Client subpath barrel (`./client`)
- `src/core/index.ts`: Core subpath barrel (`./core`)
- `src/engine/index.ts`: Engine subpath barrel (`./engine`)
- `src/audit/index.ts`: Audit subpath barrel (`./audit`)
- `src/extra/index.ts`: Extra subpath barrel (`./extra`)
- `src/utils/index.ts`: Utils subpath barrel (`./utils`)

**Configuration:**
- `package.json`: Exports map, engines constraints, dependency list
- `tsconfig.build.json`: Build config (NodeNext, strict, emits to `dist/`)
- `tsconfig.json`: Root config (includes tests, `noEmit: true`)
- `vitest.config.ts`: Test runner configuration
- `typedoc.json`: TypeDoc entrypoint (`src/index.ts`)
- `pnpm-workspace.yaml`: Workspace members

**Core Logic:**
- `src/engine/group-engine.ts`: Central state machine — start here for protocol understanding
- `src/engine/types.ts`: All engine-facing type definitions including `GroupPeeler<TEnvelope>`
- `src/core/convergence.ts`: Branch selection algorithm (ported from Rust reference)
- `src/core/group-lifecycle.ts`: Lifecycle FSM and legal transition table
- `src/client/group/marmot-group.ts`: Top-level group API consumers interact with

**Testing:**
- `src/__tests__/integration/`: Integration tests (end-to-end flows)
- `src/__tests__/helpers/mock-network.ts`: Mock Nostr relay pool for tests
- `src/__tests__/helpers/account-proof.ts`: Test account identity proof helper
- Per-module `__tests__/` directories: unit tests colocated with source

## Naming Conventions

**Files:**
- `kebab-case.ts` for all source files — no exceptions
- Test files: `kebab-case.test.ts`, always inside a `__tests__/` subdirectory
- Barrel files: always named `index.ts`

**Directories:**
- `kebab-case` for all directories
- `__tests__/` (double-underscore) for test subdirectories, colocated with the module they test

**Exports:**
- Named exports only — no default exports anywhere in the library
- Types are exported with `export type { ... }` where the value is not needed

**Classes:**
- `PascalCase` for classes and interfaces (`MarmotGroupEngine`, `GroupPeeler`, `NostrGroupPeeler`)

**Functions and variables:**
- `camelCase` for functions and variables

**Constants:**
- `SCREAMING_SNAKE_CASE` for module-level constants (`DEFAULT_CONVERGENCE_POLICY`, `GROUP_EVENT_KIND`)

## Where to Add New Code

**New protocol primitive (no I/O):**
- Implementation: `src/core/` — pick or create a file matching the concept
- Export from: `src/core/index.ts`
- Tests: `src/core/__tests__/`

**New engine behavior (transport-agnostic):**
- Implementation: `src/engine/` — new file or extend `group-engine.ts`
- Expose types in: `src/engine/types.ts`
- Export from: `src/engine/index.ts`
- Tests: `src/engine/__tests__/`

**New Nostr client feature:**
- Implementation: `src/client/` — place in the most specific subdirectory (`group/`, `session/`, `runtime/`, `transport/nostr/`)
- Export from: `src/client/index.ts` (and `src/client/group/index.ts` if group-level)
- Tests: colocated `__tests__/` or `src/__tests__/integration/` for end-to-end

**New MLS extension component:**
- Implementation: `src/core/components/`
- Export from: `src/core/components/index.ts`

**New optional store implementation:**
- Implementation: `src/extra/`
- Export from: `src/extra/index.ts`
- Tests: `src/extra/__tests__/`

**New utility helper:**
- Implementation: `src/utils/`
- Export from: `src/utils/index.ts`
- Tests: `src/utils/__tests__/`

**New proposal builder:**
- Implementation: `src/client/group/proposals/`
- Export from: `src/client/group/proposals/index.ts`

**New integration test:**
- Location: `src/__tests__/integration/`
- Naming: `<scenario-name>.test.ts`
- Use helpers from: `src/__tests__/helpers/`

## Special Directories

**`dist/`:**
- Purpose: Compiled library output (`tsc -b tsconfig.build.json`)
- Generated: Yes
- Committed: No (gitignored)

**`ts-mls/dist/`:**
- Purpose: Compiled local MLS dependency
- Generated: Yes (via `pnpm --filter ts-mls build` in `prepare` script)
- Committed: No

**`darkmatter/`:**
- Purpose: Rust reference implementation and conformance simulator
- Generated: No (hand-authored)
- Committed: Yes

**`.changeset/`:**
- Purpose: Changeset version bump entries for release management
- Generated: Partially (entries created by `changeset add`)
- Committed: Yes

**`graphify-out/`:**
- Purpose: Output from the `/graphify` knowledge-graph tool
- Generated: Yes
- Committed: Yes (repo convention)

---

*Structure analysis: 2026-07-01*
