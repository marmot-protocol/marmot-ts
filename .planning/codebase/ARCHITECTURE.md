<!-- refreshed: 2026-07-07 -->
# Architecture

**Analysis Date:** 2026-07-07

## System Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                    Application code                          │
│         (examples/opentui, forker, tunnels; downstream)      │
└──────────────────────────┬──────────────────────────────────┘
                           │ import "@internet-privacy/marmot-ts"
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Client layer                            │
│  MarmotClient · GroupsManager · MarmotGroup (facade)         │
│  GroupSession · GroupRuntime · NostrGroupPeeler              │
│  InviteManager · KeyPackageManager · WelcomeDelivery         │
│  `src/client/`                                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ GroupPeeler<TEnvelope> boundary
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Engine layer                            │
│  MarmotGroupEngine (fork-aware state machine)                │
│  GroupHistoryTree · RetainedHistoryStore · IngestionPool     │
│  ForkRecovery · ingestEnvelopes · wire-format helpers        │
│  `src/engine/`                                               │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                       Core layer                             │
│  Protocol · MLS extensions · convergence · lifecycle FSM     │
│  credential · key-package codec · group-message crypto       │
│  binary codec · components · media   `src/core/`             │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              ts-mls (RFC 9420 MLS engine)                    │
│              local workspace `./ts-mls`                       │
└─────────────────────────────────────────────────────────────┘

  Cross-cutting: src/utils (debug, encoding, key-value, nip44)
                 src/audit (opt-in forensic log)
                 src/extra (opt-in store + audit-sink implementations)
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `MarmotClient` | Top-level API: groups, invites, key packages, welcome preview | `src/client/marmot-client.ts` |
| `GroupsManager` | Manages a collection of `MarmotGroup` instances; join/load | `src/client/groups-manager.ts` |
| `MarmotGroup` | Public facade composing session + runtime + stores | `src/client/group/marmot-group.ts` |
| `GroupSession` | Wires `NostrGroupPeeler` into the engine; translates engine ↔ Nostr | `src/client/session/group-session.ts` |
| `GroupRuntime` | Drives Nostr publish effects; confirms/rolls back staged state | `src/client/runtime/group-runtime.ts` |
| `NostrGroupPeeler` | `GroupPeeler<NostrEvent>` for kind-445 events | `src/client/group/nostr-peeler.ts` |
| `InviteManager` | Builds/consumes invites and welcomes | `src/client/invite-manager.ts` |
| `KeyPackageManager` | Publishes/fetches/deletes key-package events | `src/client/key-package-manager.ts` |
| `MarmotGroupEngine` | Transport-agnostic MLS state machine: ingest, send, fork recovery, lifecycle | `src/engine/group-engine.ts` |
| `GroupHistoryTree` | Full-fork history tree keyed by MLS confirmation tag; persisted | `src/engine/history-tree.ts` |
| `RetainedHistoryStore` | Canonical states within rollback horizon for convergence rewind | `src/engine/retained-store.ts` |
| `IngestionPool` | Holds undecryptable envelopes for retry as the tree grows | `src/engine/ingestion-pool.ts` |
| `ForkRecovery` | Builds candidate branches and selects canonical branch | `src/engine/fork-recovery.ts` |
| `ingestEnvelopes` | Pure ingest pipeline (stateless, driven by `IngestContext`) | `src/engine/ingest.ts` |
| `core/*` | Protocol definitions, MLS extensions, convergence, lifecycle FSM, codecs | `src/core/` |
| `core/components/*`, `core/media/*` | App component descriptors and encrypted-media wire format | `src/core/components/`, `src/core/media/` |
| `audit/*` | Optional forensic audit log: sink, emitter, recorder | `src/audit/` |
| `extra/*` | Optional store implementations + platform audit sinks | `src/extra/` |
| `utils/*` | Shared cross-cutting utilities | `src/utils/` |

## Pattern Overview

**Overall:** Layered library with a transport-agnostic state machine at its core (`utils ← core ← engine ← client`).

**Key Characteristics:**
- `MarmotGroupEngine<TEnvelope>` is fully transport-agnostic via the `GroupPeeler<TEnvelope>` interface — the engine never touches Nostr types.
- `src/core` has zero I/O dependencies; only pure protocol/crypto/state logic.
- Publish-before-apply: local commits are staged (`PendingPublish`) before publish is confirmed; state advances only on confirmation.
- Fork detection and convergence run inside the engine on every ingest batch; the lifecycle FSM is the single source of truth for when outbound work is safe.
- All binary/protocol data uses `Uint8Array`; hex conversion via `@noble/hashes/utils.js`.

## Layers

**Utils:**
- Purpose: Shared cross-cutting utilities
- Location: `src/utils/`
- Contains: `debug.ts`, `key-value.ts`, `encoding.ts`, `nostr.ts`, `nip44-binary.ts`, `timestamp.ts`, `relay-url.ts`
- Depends on: `@noble/*`, `@scure/base`
- Used by: core, engine, client, extra

**Core:**
- Purpose: Protocol/crypto/state primitives with no I/O
- Location: `src/core/`
- Contains: MLS extensions, group lifecycle FSM, convergence policy/selection, credential helpers, key-package codec, group-message crypto, binary codec, Nostr event builders, app components (`components/`), encrypted media (`media/`)
- Depends on: `ts-mls`, `@noble/*`, `applesauce-core`
- Used by: engine, client

**Engine:**
- Purpose: Transport-agnostic MLS group state machine
- Location: `src/engine/`
- Contains: `MarmotGroupEngine`, `GroupHistoryTree`, `RetainedHistoryStore`, `IngestionPool`, `ForkRecovery`, `ingestEnvelopes`, `DeliveredPayloadLedger`, admin policy, dedup, convergence status, wire-format helpers, auto-committer
- Depends on: `src/core/`, `ts-mls`
- Used by: client (`GroupSession`)

**Client:**
- Purpose: Nostr-flavored wrappers, storage lifecycle, group/invite/key-package management
- Location: `src/client/`
- Contains: `MarmotClient`, `MarmotGroup`, `GroupSession`, `GroupRuntime`, `GroupsManager`, `NostrGroupPeeler`, `InviteManager`, `KeyPackageManager`, transport (`transport/nostr/welcome-delivery.ts`), media services (`group/group-media-*.ts`)
- Depends on: engine, core, `applesauce-core`, `applesauce-common`, `eventemitter3`
- Used by: application code

**Audit (opt-in):**
- Purpose: Optional forensic audit log; does not affect protocol
- Location: `src/audit/`
- Contains: `AuditSink` (interface), `AuditEmitter`, `AuditRecorder`, event type definitions
- Used by: engine, client (both accept optional `audit?: AuditSink`)

**Extra (opt-in):**
- Purpose: Store implementations and platform-specific audit sinks
- Location: `src/extra/`
- Contains: `InMemoryKeyValueStore`, `EncryptedKeyValueStore`, `KeyValueRumorHistoryBackend`, `audit/browser.ts`, `audit/node.ts`
- Used by: application code

## Data Flow

### Inbound: receiving a Nostr group message

1. Application feeds kind-445 `NostrEvent`s to `MarmotGroup` / `GroupSession` (`src/client/session/group-session.ts`)
2. `NostrGroupPeeler.peelGroupMessages()` decrypts envelopes to MLS messages (`src/client/group/nostr-peeler.ts`)
3. `MarmotGroupEngine.ingest()` drives `ingestEnvelopes()` — records commits into `GroupHistoryTree`, pools undecryptables, runs fork detection/convergence (`src/engine/ingest.ts`, `src/engine/group-engine.ts`)
4. On fork, `ForkRecovery` selects the canonical branch and `RetainedHistoryStore` rewinds (`src/engine/fork-recovery.ts`, `src/engine/retained-store.ts`)
5. Application payloads surface as `IngestResult`s to the caller

### Outbound: sending a message or commit

1. Caller invokes send on `MarmotGroup` → `GroupSession.send()` (`src/client/session/group-session.ts`)
2. Lifecycle FSM gate (`mayPrepareLocalCommit`) checks state is `Stable` (`src/core/group-lifecycle.ts`)
3. Engine stages a `PendingPublish`; `NostrGroupPeeler.wrapGroupMessage()` produces a Nostr event
4. `GroupRuntime` publishes effects; on confirmation the engine advances state, on failure it rolls back (`src/client/runtime/group-runtime.ts`)

### Welcome / invite flow

1. `KeyPackageManager` publishes key-package events (`src/client/key-package-manager.ts`)
2. `InviteManager` builds a welcome and delivers it gift-wrapped via `transport/nostr/welcome-delivery.ts`
3. Recipient previews then joins, hydrating a new `MarmotGroup` through `GroupsManager`

**State Management:**
- Canonical group state (`ts-mls` `ClientState`) lives in `MarmotGroupEngine.#state`
- Persisted via `GenericKeyValueStore<SerializedClientState>` injected into `MarmotGroup`
- Fork history tree persisted via a separate `GenericKeyValueStore<Uint8Array>` (`rewindStore`)
- No global module-level state; all group state is instance-owned

## Key Abstractions

**`GroupPeeler<TEnvelope>`:**
- Purpose: Decouples the engine from Nostr — any transport implementing it can drive the engine
- Methods: `peelGroupMessages(envelopes, state)`, `wrapGroupMessage(message, state)`, `idOf(envelope)`
- Concrete implementation: `NostrGroupPeeler` (`src/client/group/nostr-peeler.ts`)
- Interface: `src/engine/types.ts`

**`GenericKeyValueStore<T>`:**
- Purpose: Storage abstraction for group state, history tree, rumor history
- Implementations: `InMemoryKeyValueStore` (`src/extra/in-memory-key-value-store.ts`), `EncryptedKeyValueStore` (`src/extra/encrypted-key-value-store.ts`)
- Interface: `src/utils/key-value.ts`

**Convergence policy:**
- Purpose: Governs branch selection — `maxRewindCommits`, quiescence window, witness quorum
- Default: `DEFAULT_CONVERGENCE_POLICY` (profile version 1) in `src/core/convergence.ts`
- Used by: `MarmotGroupEngine`, `ForkRecovery`, `RetainedHistoryStore`, `IngestionPool`

**Lifecycle FSM:**
- States: `Stable | PendingPublish | Merging | Recovering | Unrecoverable`
- Legal transitions enforced by `transitionLifecycle()` — throws on illegal move (`src/core/group-lifecycle.ts`)
- Gates when local commits may be prepared and when outbound may be released

**`AuditSink`:**
- Purpose: Optional forensic log — callers opt in by passing `audit` to engine/group; no-op when absent (`src/audit/sink.ts`)

## Entry Points

**`src/index.ts` (`.` subpath):**
- Re-exports client, core, utils, plus selected engine exports (`MarmotGroupEngine`, `GroupPeeler`, ingest types, `ForkRecovery`)

**`src/engine/index.ts` (`./engine` subpath):**
- Full engine surface for callers building a custom transport layer

**`src/client/index.ts` (`./client` subpath):**
- `MarmotClient`, `MarmotGroup`, `GroupsManager`, `GroupSession`, `GroupRuntime`, `NostrNetworkInterface`

**`src/mls.ts` (`./mls` subpath):**
- Re-exports all of `ts-mls` for downstream apps needing raw MLS primitives

**`src/audit/index.ts` / `src/extra/index.ts` / `src/utils/index.ts`:**
- `./audit`, `./extra`, `./utils` subpaths for opt-in surfaces

## Architectural Constraints

- **Threading:** Single-threaded ESM event loop; no worker threads. `MarmotGroupEngine.ingest()` is an `AsyncGenerator`; callers must drain it fully before the next batch.
- **Global state:** None. All state is per-instance. The `debug` logger namespace (`marmot:*`) is module-level but read-only.
- **Circular imports:** None observed. Dependency direction is strict: `utils ← core ← engine ← client`.
- **`.js` extensions:** All relative imports in `src/` require the emitted `.js` extension (NodeNext). Violating this breaks the build.
- **Named exports only:** No default exports in the library source.
- **`ts-mls` local workspace:** `ts-mls` is a local workspace package at `./ts-mls`, not from npm; it must be built before the library.
- **Wire compatibility:** Must interoperate byte-for-byte with the Rust `darkmatter` reference (vendored at `./darkmatter`); the Rust code + spec are the source of truth.

## Anti-Patterns

### Importing engine types through the client barrel

**What happens:** Engine ingest types are pulled from `@internet-privacy/marmot-ts` (root) or client barrel.
**Why it's wrong:** Root re-exports only non-colliding engine parts; client-flavored ingest types shadow them.
**Do this instead:** Import engine internals from the `./engine` subpath (`src/engine/index.ts`).

### Mutating `MarmotGroupEngine.state` directly

**What happens:** Callers assign to engine state to force an epoch.
**Why it's wrong:** Bypasses the lifecycle FSM and convergence gate, corrupting fork tracking.
**Do this instead:** Drive state through `ingest()` / `send()`. (The `forker` example deliberately violates this to simulate an adversary — that is a test tool, not a pattern.)

### Calling `ingest()` without draining the generator

**What happens:** Caller pulls one item and starts a new batch.
**Why it's wrong:** `ingest()` is an `AsyncGenerator`; partial drains leave the engine mid-convergence.
**Do this instead:** Fully drain the generator before the next batch.

## Error Handling

**Strategy:** Throw for programmer/validation errors; return discriminated-union results for expected multi-outcome flows.

**Patterns:**
- `transitionLifecycle()` (`src/core/group-lifecycle.ts`) throws on illegal FSM transitions
- `ingestEnvelopes()` (`src/engine/ingest.ts`) emits `unreadable`/`rejected`/`skipped` results rather than throwing
- `GroupHistoryTree.recordCommit()` (`src/engine/history-tree.ts`) logs tree errors rather than propagating them (tree hiccups must not break protocol processing)
- Audit errors in `AuditEmitter.emit()` are caught and silenced (non-blocking, best-effort)
- `BinaryDecodeError` (`src/core/binary.ts`) subclasses `Error` for codec failures

## Cross-Cutting Concerns

**Logging:** `debug` scoped loggers under the `marmot:*` namespace (`src/utils/debug.ts`).
**Validation:** Binary codec (`src/core/binary.ts`) validates wire format; credential/key-package eligibility checks in `src/core/`.
**Authentication:** MLS credentials plus Nostr account-identity proofs (`src/core/account-identity-proof.ts`); NIP-44 binary encryption in `src/utils/nip44-binary.ts`.
**Audit:** Opt-in `AuditSink` threaded through engine and client (`src/audit/`).

---

*Architecture analysis: 2026-07-07*
