# Codebase Structure

**Analysis Date:** 2026-07-07

## Directory Layout

```
marmot-ts/
├── src/                    # Library source (@internet-privacy/marmot-ts)
│   ├── index.ts            # Root barrel (. subpath)
│   ├── mls.ts              # Re-exports ts-mls (./mls subpath)
│   ├── core/               # Protocol/crypto/state primitives, no I/O
│   │   ├── components/     # App component descriptors (agent-text-stream, media, profile…)
│   │   └── media/          # Encrypted-media wire format (imeta, locator, crypto)
│   ├── engine/             # Transport-agnostic MLS state machine
│   ├── client/             # Nostr-flavored wrappers, storage, lifecycle
│   │   ├── group/          # MarmotGroup facade, peeler, media, proposals
│   │   ├── session/        # GroupSession + effects
│   │   ├── runtime/        # GroupRuntime (publish effects)
│   │   └── transport/      # Nostr transport (welcome-delivery)
│   ├── audit/              # Opt-in forensic audit log
│   ├── extra/              # Opt-in store + platform audit-sink implementations
│   ├── utils/              # Cross-cutting utilities (debug, encoding, kv, nip44)
│   └── __tests__/          # Integration tests + shared helpers
├── ts-mls/                 # Local MLS (RFC 9420) workspace package — build first
├── darkmatter/             # Vendored Rust reference (git submodule) — wire truth
├── docs/                   # VitePress docs source (srcDir: "docs")
├── examples/               # Example apps: opentui, forker, tunnels
├── scripts/                # Release scripts (publish-nostr.sh)
├── dist/                   # Build output (generated, not committed)
├── .planning/              # GSD planning artifacts + codebase docs
├── package.json            # Manifest with exports map
├── tsconfig.json           # Type-check config (noEmit, includes tests)
├── tsconfig.build.json     # Library emit config
├── vitest.config.ts        # Test runner config
└── typedoc.json            # API reference generation
```

## Directory Purposes

**`src/core/`:**
- Purpose: Pure protocol/crypto/state logic with zero I/O
- Contains: MLS extensions, group lifecycle FSM, convergence, credential/key-package codecs, group-message crypto, binary codec, Nostr event builders
- Key files: `protocol.ts`, `binary.ts`, `group-lifecycle.ts`, `convergence.ts`, `credential.ts`, `key-package.ts`, `group-message-crypto.ts`, `index.ts`

**`src/core/components/`:**
- Purpose: App component descriptors and capability markers
- Contains: `agent-text-stream.ts`, `encrypted-media.ts`, `group-profile.ts`, `admin-policy.ts`, `nostr-routing.ts`, `message-retention.ts`
- Key files: `index.ts`, `ids.ts`, `app-components-list.ts`

**`src/core/media/`:**
- Purpose: Encrypted-media wire format
- Key files: `canonical.ts`, `crypto.ts`, `imeta.ts`, `locator.ts`, `types.ts`

**`src/engine/`:**
- Purpose: Transport-agnostic MLS group state machine
- Contains: `MarmotGroupEngine`, history tree, retained store, ingestion pool, fork recovery, pure ingest pipeline
- Key files: `group-engine.ts`, `ingest.ts`, `history-tree.ts`, `retained-store.ts`, `ingestion-pool.ts`, `fork-recovery.ts`, `types.ts`, `wire-format.ts`, `index.ts`

**`src/client/`:**
- Purpose: Nostr-flavored wrappers, storage lifecycle, group/invite/key-package management
- Contains: top-level client, groups manager, invite/key-package managers, network interface
- Key files: `marmot-client.ts`, `groups-manager.ts`, `invite-manager.ts`, `key-package-manager.ts`, `nostr-interface.ts`, `index.ts`

**`src/client/group/`:**
- Purpose: The `MarmotGroup` facade and Nostr peeling
- Key files: `marmot-group.ts`, `nostr-peeler.ts`, `group-media-service.ts`, `group-rumor-history.ts`, `invite.ts`

**`src/client/session/` / `src/client/runtime/` / `src/client/transport/`:**
- Purpose: Session wiring (`group-session.ts`), publish-effect runtime (`group-runtime.ts`), Nostr transport (`transport/nostr/welcome-delivery.ts`)

**`src/audit/`:**
- Purpose: Opt-in forensic audit log; no-op when absent
- Key files: `sink.ts`, `emitter.ts`, `recorder.ts`, `types.ts`, `index.ts`

**`src/extra/`:**
- Purpose: Opt-in store implementations + platform audit sinks
- Key files: `in-memory-key-value-store.ts`, `encrypted-key-value-store.ts`, `key-value-rumor-history-backend.ts`, `audit/node.ts`, `audit/browser.ts`

**`src/utils/`:**
- Purpose: Cross-cutting utilities
- Key files: `debug.ts`, `key-value.ts`, `encoding.ts`, `nostr.ts`, `nip44-binary.ts`, `timestamp.ts`, `relay-url.ts`

## Key File Locations

**Entry Points:**
- `src/index.ts`: Root barrel (`.`) — client + core + utils + selected engine exports
- `src/mls.ts`: `./mls` — re-exports `ts-mls`
- `src/engine/index.ts`, `src/client/index.ts`, `src/core/index.ts`, `src/audit/index.ts`, `src/extra/index.ts`, `src/utils/index.ts`: per-subpath barrels

**Configuration:**
- `package.json`: `exports` map defines all public subpaths
- `tsconfig.build.json`: Library emit (excludes tests)
- `tsconfig.json`: Type-check config (`noEmit`, includes tests + `vitest` types)
- `vitest.config.ts`: Test runner (node env, matches `src/**/*.test.ts`)
- `typedoc.json`: API reference from `src/index.ts`
- `.prettierrc`: Formatting (`tabWidth: 2`)

**Core Logic:**
- `src/core/`: Protocol primitives
- `src/engine/group-engine.ts`: State machine
- `src/client/marmot-client.ts`: Top-level API

**Testing:**
- `src/**/__tests__/`: Colocated unit tests
- `src/__tests__/integration/`: Integration tests
- `src/__tests__/helpers/`: Shared test doubles (mock network/client)

## Naming Conventions

**Files:**
- kebab-case: `group-engine.ts`, `key-package-event-decode.ts`, `in-memory-key-value-store.ts`
- Tests: same name with `.test.ts`, under sibling `__tests__/`: `group-engine.test.ts`

**Directories:**
- kebab-case; each layer has an `index.ts` barrel; `__tests__/` for colocated tests

**Code identifiers:**
- Functions: camelCase (`createGroup`, `ingestEnvelopes`)
- Types/classes: PascalCase (`MarmotGroupEngine`, `SendResult`)
- Protocol constants: SCREAMING_SNAKE_CASE (`ADDRESSABLE_KEY_PACKAGE_KIND`, `MAX_VARINT`)
- Enum-like object namespaces: camelCase (`groupLifecycleStates`, `convergenceStatuses`)
- Private fields: native `#` (`#state`, `#lifecycle`), not TypeScript `private`

## Where to Add New Code

**New protocol/crypto/state primitive:**
- Implementation: `src/core/` (add to relevant `index.ts` barrel)
- Tests: `src/core/__tests__/`

**New engine state-machine logic:**
- Implementation: `src/engine/`
- Tests: `src/engine/__tests__/`

**New Nostr/client feature:**
- Implementation: `src/client/` (or `group/`, `session/`, `runtime/`, `transport/`)
- Tests: `src/client/**/__tests__/`

**New store or platform sink:**
- Implementation: `src/extra/` (implement `GenericKeyValueStore` from `src/utils/key-value.ts`)

**New app component / media type:**
- Implementation: `src/core/components/` or `src/core/media/`

**Reminders:**
- All relative imports need the emitted `.js` extension (NodeNext)
- Named exports only; re-export via the directory `index.ts` barrel
- Binary/protocol data is `Uint8Array`; hex via `@noble/hashes/utils.js` (no `Buffer`)

## Special Directories

**`dist/`:**
- Purpose: Compiled library output
- Generated: Yes (`pnpm build`)
- Committed: No

**`.vitepress/dist/`:**
- Purpose: Built docs + TypeDoc reference
- Generated: Yes
- Committed: No

**`ts-mls/`:**
- Purpose: Local MLS RFC 9420 workspace package (dependency)
- Generated: No — must be built before the library (`pnpm --filter ts-mls build`)
- Committed: Yes (workspace source)

**`darkmatter/`:**
- Purpose: Vendored Rust reference implementation — source of truth for wire format
- Generated: No
- Committed: Yes (git submodule)

**`graphify-out/`, `.planning/`:**
- Purpose: Knowledge-graph output and GSD planning artifacts
- Generated: Yes (tooling)
- Committed: Varies (`.planning/` committed)

---

*Structure analysis: 2026-07-07*
