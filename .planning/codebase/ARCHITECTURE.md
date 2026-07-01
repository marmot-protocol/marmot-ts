<!-- refreshed: 2026-07-01 -->
# Architecture

**Analysis Date:** 2026-07-01

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        Public Entrypoints                            │
│  `.` (root)  `./client`  `./core`  `./engine`  `./audit`  `./extra` │
└──────┬──────────────────┬──────────────────────┬────────────────────┘
       │                  │                       │
       ▼                  ▼                       ▼
┌────────────┐   ┌─────────────────┐   ┌─────────────────────────────┐
│  src/client│   │   src/engine/   │   │         src/core/           │
│  (Nostr)   │   │  MarmotGroup    │   │  Protocol/crypto/state      │
│  MarmotGroup│◄─┤  Engine<TEnv>   │◄──┤  No I/O; pure logic         │
│  MarmotClient│  │  GroupHistoryTree│  │  convergence, lifecycle,    │
│  GroupSession│  │  ForkRecovery   │   │  group-message, extensions  │
│  GroupRuntime│  │  IngestionPool  │   └─────────────────────────────┘
└──────┬─────┘   └─────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│              NostrNetworkInterface / NostrGroupPeeler                │
│  src/client/nostr-interface.ts  src/client/group/nostr-peeler.ts    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
                  Nostr relay pool (external)
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

**Overall:** Layered ENGINE architecture with a generic-transport core and Nostr-specific client shell.

**Key Characteristics:**
- `MarmotGroupEngine<TEnvelope>` is fully transport-agnostic via the `GroupPeeler<TEnvelope>` interface — the engine never touches Nostr types
- `src/core` has zero I/O dependencies; it contains only pure protocol/crypto/state logic
- Publish-before-apply: local commits are staged (`PendingPublish`) before publish is confirmed; state advances only on confirmation
- Fork detection and convergence run inside the engine on every ingest batch; the lifecycle FSM (`Stable → PendingPublish → Merging → Recovering → Stable`) is the single source of truth for when outbound work is safe
- All binary/protocol data uses `Uint8Array`; hex conversion uses `@noble/hashes/utils.js`

## Layers

**Core (`src/core/`):**
- Purpose: Protocol/crypto/state primitives with no I/O
- Location: `src/core/`
- Contains: MLS extensions, group lifecycle FSM, convergence policy/selection, credential helpers, key-package encoding, group-message crypto, binary codec, Nostr event builders
- Depends on: `ts-mls`, `@noble/*`, `applesauce-core`
- Used by: engine, client

**Engine (`src/engine/`):**
- Purpose: Transport-agnostic MLS group state machine
- Location: `src/engine/`
- Contains: `MarmotGroupEngine`, `GroupHistoryTree`, `RetainedHistoryStore`, `IngestionPool`, `ForkRecovery`, `ingestEnvelopes`, `DeliveredPayloadLedger`, admin policy, dedup, convergence status, wire-format helpers
- Depends on: `src/core/`, `ts-mls`
- Used by: client (`GroupSession`)

**Client (`src/client/`):**
- Purpose: Nostr-flavored wrappers, storage lifecycle, group/invite/key-package management
- Location: `src/client/`
- Contains: `MarmotGroup`, `GroupSession`, `GroupRuntime`, `GroupsManager`, `MarmotClient`, `NostrGroupPeeler`, `NostrWelcomeDelivery`, `InviteManager`, `KeyPackageManager`
- Depends on: engine, core, `applesauce-core`, `applesauce-common`, `eventemitter3`
- Used by: application code

**Audit (`src/audit/`):**
- Purpose: Optional forensic audit log (opt-in, does not affect protocol)
- Location: `src/audit/`
- Contains: `AuditSink` (interface), `AuditEmitter`, `AuditRecorder`, event type definitions
- Depends on: core (for type references only)
- Used by: engine, client (both accept an optional `audit?: AuditSink`)

**Extra (`src/extra/`):**
- Purpose: Optional store implementations and platform-specific audit sinks
- Location: `src/extra/`
- Contains: `InMemoryKeyValueStore`, `EncryptedKeyValueStore`, `KeyValueRumorHistoryBackend`, `browser.ts`/`node.ts` audit sinks
- Depends on: utils, audit, `@noble/ciphers`, `@noble/hashes`
- Used by: application code (opt-in)

**Utils (`src/utils/`):**
- Purpose: Shared cross-cutting utilities
- Location: `src/utils/`
- Contains: `debug.ts` (logger), `key-value.ts` (store interface), `encoding.ts`, `nostr.ts`, `nip44-binary.ts`, `timestamp.ts`, `relay-url.ts`

## Data Flow

### Inbound: Receiving a Nostr group message

1. Caller provides `NostrEvent[]` to `MarmotGroup.ingest()` (`src/client/group/marmot-group.ts`)
2. `GroupSession.ingest()` (`src/client/session/group-session.ts`) strips own-echo events by Nostr event id
3. `MarmotGroupEngine.ingest()` (`src/engine/group-engine.ts`) is called with the filtered envelopes
4. `ingestEnvelopes()` (`src/engine/ingest.ts`) calls `peeler.peelGroupMessages()` → `NostrGroupPeeler` decrypts kind-445 ciphertext into `MlsMessage` objects
5. Each `MlsMessage` is classified and processed: `processMessage()` from `ts-mls` applies the state transition
6. Fork-shaped commits trigger `ForkRecovery.resolveFork()` → `selectCanonicalBranch()` → `#applyForkResolution()`
7. Undecryptable envelopes enter `IngestionPool` for retry on tip advance; tree-sweep tries retained fork nodes
8. Each processed result is dispositioned and yielded as `DispositionedIngestResult<NostrEvent>`
9. `GroupSession` translates generic envelope results back to `NostrEvent`-typed results
10. `MarmotGroup` emits `applicationMessage` event / `stateChanged` event accordingly

### Outbound: Sending a message or commit

1. Caller invokes `MarmotGroup.send(intent)` (`src/client/group/marmot-group.ts`)
2. `GroupSession.send()` dispatches to `MarmotGroupEngine.send(intent)`
3. Engine creates MLS message via `ts-mls` (`createApplicationMessage` / `createCommit`)
4. `NostrGroupPeeler.wrapGroupMessage()` encrypts into a Nostr kind-445 event
5. For commits: engine transitions `Stable → PendingPublish`; returns `pending` alongside `envelope`
6. `GroupRuntime.publishCommit()` (`src/client/runtime/group-runtime.ts`) publishes via `NostrNetworkInterface`
7. On relay ack: `engine.confirmPublished(pending)` transitions `PendingPublish → Merging → Stable` and records into `RetainedHistoryStore` + `GroupHistoryTree`
8. On publish failure: `engine.publishFailed(pending)` reverts `PendingPublish → Stable`

### Welcome / Invite flow

1. Admin calls `MarmotGroup.invite()` → `GroupSession` sends a commit with `Add` proposals
2. `GroupRuntime` picks up the `welcome` from the commit result
3. `NostrWelcomeDelivery.deliver()` (`src/client/transport/nostr/welcome-delivery.ts`) NIP-59 gift-wraps the Welcome and publishes to invitee's inbox relays
4. Invitee's `InviteManager` (`src/client/invite-manager.ts`) monitors inbox, decrypts rumor, surfaces via `watchInvites()`
5. Invitee calls `MarmotClient.joinGroup()` / `GroupsManager` processes the Welcome via `ts-mls` `joinGroup()`

**State Management:**
- Canonical group state (`ts-mls` `ClientState`) lives in `MarmotGroupEngine.#state`
- Persisted via `GenericKeyValueStore<SerializedClientState>` injected into `MarmotGroup`
- Fork history tree persisted via a separate `GenericKeyValueStore<Uint8Array>` (`rewindStore`)
- No global module-level state; all group state is instance-owned

## Key Abstractions

**`GroupPeeler<TEnvelope>` (`src/engine/types.ts`):**
- Purpose: Decouples the engine from Nostr — any transport implementing this interface can drive the engine
- Methods: `peelGroupMessages(envelopes, state)`, `wrapGroupMessage(message, state)`, `idOf(envelope)`
- Concrete implementation: `NostrGroupPeeler` (`src/client/group/nostr-peeler.ts`)

**`GenericKeyValueStore<V>` (`src/utils/key-value.ts`):**
- Purpose: Storage abstraction used for group state, history tree, history backend
- Implementations: `InMemoryKeyValueStore` (`src/extra/in-memory-key-value-store.ts`), `EncryptedKeyValueStore` (`src/extra/encrypted-key-value-store.ts`)

**`ConvergencePolicy` (`src/core/convergence.ts`):**
- Purpose: Governs branch selection — `maxRewindCommits`, quiescence window, witness quorum
- Default: `DEFAULT_CONVERGENCE_POLICY` (profile version 1)
- Used by: `MarmotGroupEngine`, `ForkRecovery`, `RetainedHistoryStore`, `IngestionPool`

**`GroupLifecycleState` (`src/core/group-lifecycle.ts`):**
- States: `Stable | PendingPublish | Merging | Recovering | Unrecoverable`
- Legal transitions enforced by `transitionLifecycle()` — throws on illegal move
- Gates when local commits may be prepared (`mayPrepareLocalCommit`) and when outbound may be released

**`AuditSink` (`src/audit/`):**
- Purpose: Optional forensic audit log — callers opt in by passing `audit` + `auditContext` to engine/group
- Both engine and client layer accept it; no-op when absent

## Entry Points

**Root barrel (`src/index.ts`):**
- Re-exports client, core, utils, plus selected engine exports
- Consumed by `@internet-privacy/marmot-ts` import (`.` subpath)

**`./engine` subpath (`src/engine/index.ts`):**
- Exposes `MarmotGroupEngine`, `GroupPeeler`, ingest types, `ForkRecovery`, retained store
- For callers building a custom transport layer

**`./client` subpath (`src/client/index.ts`):**
- Exposes `MarmotClient`, `MarmotGroup`, `GroupsManager`, `GroupSession`, `GroupRuntime`, `NostrNetworkInterface`

**`./mls` subpath (`src/mls.ts`):**
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

**What happens:** `import { MarmotGroupEngine } from "@internet-privacy/marmot-ts"` — the root barrel re-exports only selected engine types; the full engine surface is on `./engine`.
**Why it's wrong:** Causes type collisions and hides the transport-agnostic design boundary.
**Do this instead:** `import { MarmotGroupEngine } from "@internet-privacy/marmot-ts/engine"` for engine-level access.

### Mutating `MarmotGroupEngine.state` directly

**What happens:** The `state` setter is public but bypasses `#setState` audit hooks.
**Why it's wrong:** Skips `onStateChanged` notification and audit emission; breaks state-change observers.
**Do this instead:** Use `send()` / `ingest()` / `confirmPublished()` / `publishFailed()` — the engine's defined mutation surface.

### Calling `ingest()` without draining the generator

**What happens:** Partial iteration of the `AsyncGenerator` returned by `MarmotGroupEngine.ingest()`.
**Why it's wrong:** The convergence quiescence window, pool sweep, and auto-commit steps only run after all results are consumed; leaving the generator unfinished leaves state partially advanced.
**Do this instead:** Always `for await (const result of engine.ingest(envelopes)) { ... }` to full completion.

## Error Handling

**Strategy:** Throw on programming errors (illegal lifecycle transitions, missing required options). Protocol errors (unreadable messages, rejected commits) are surfaced as typed `IngestResult` discriminated union values, not thrown exceptions. Publish failures are reported via `GroupRuntime` return values and drive `publishFailed()` on the engine.

**Patterns:**
- `transitionLifecycle()` (`src/core/group-lifecycle.ts`) throws on illegal FSM transitions
- `ingestEnvelopes()` (`src/engine/ingest.ts`) emits `unreadable`/`rejected`/`skipped` results rather than throwing
- `GroupHistoryTree.recordCommit()` (`src/engine/history-tree.ts`) logs tree errors rather than propagating them (tree hiccups must not break protocol processing)
- Audit errors in `AuditEmitter.emit()` are caught and silenced (non-blocking, best-effort)

## Cross-Cutting Concerns

**Logging:** `debug` package, namespaced as `marmot:*`. Root logger at `src/utils/debug.ts`; sub-loggers created with `.extend()`. Controlled via `DEBUG=marmot:*` environment variable.
**Validation:** Input validation at layer boundaries. Protocol validation is delegated to `ts-mls` (`processMessage`, `ValidationError`). Admin policy is applied via `createAdminCommitPolicyCallback` (`src/engine/admin-policy.ts`).
**Authentication:** MLS credentials carry Nostr pubkeys; `AccountIdentityProof` (`src/core/account-identity-proof.ts`) ties MLS credential to Nostr identity. Nostr events are signed via `EventSigner` (from `applesauce-core`).

---

*Architecture analysis: 2026-07-01*
