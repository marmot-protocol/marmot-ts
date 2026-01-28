# Store and History Design (Marmot-TS)

Status: draft

This document specifies the **persistence and history abstractions** used by Marmot-TS clients and demo apps.

The goals are:

- avoid repeated decryption of historical group traffic (performance)
- enable efficient backfill and “resume where you left off” (UX)
- allow downstream apps to bring their own storage backend (IndexedDB, SQLite, Postgres, etc.)
- keep MLS state management correct and easy to reason about (safety)

This design is consistent with the MIP-03 ordering/tiebreaker convention (timestamp, then lexicographically smallest id) described in [`marmot/03.md:117`](marmot/03.md:117).

This document also aligns with the broader spec style of byte-precise encoding (TLS presentation language) described in [`marmot/01.md:66`](marmot/01.md:66).

## Terminology

- **Outer event**: the published Marmot Group Event (`kind: 445`), a Nostr event that contains encrypted MLS content.
- **Inner rumor**: the unsigned Nostr event contained inside an MLS application message after decryption.
- **Group store**: persistence for MLS `ClientState` (ratchet tree, epoch, secrets, extensions).
- **History store**: persistence for decrypted application messages (rumors) and associated indexing metadata.
- **Cursor**: a stable pagination boundary, represented as `(created_at, id)`.

### User model (conceptual)

A Marmot “user” (as a unit that can be backed up/restored across devices) is:

- **keys** (identity + encryption material)
- **MLS group state** (per-group `ClientState` snapshots)
- **decrypted history** (per-group rumors + resume cursor metadata)

This document defines persistence contracts for the latter two components.

## Separation of concerns

### `GroupStore` (MLS state)

Responsible for persisting and loading MLS `ClientState` per group.

Key properties:

- **authoritative for decryptability**: whether the client can decrypt a given epoch depends on stored MLS state.
- **atomic per group**: updates should be atomic so UI/runtime doesn’t observe torn state.

See the current implementation in [`src/store/group-store.ts:28`](src/store/group-store.ts:28).

#### Minimal state store interface (recommended)

Marmot-TS should depend on a minimal, backend-agnostic key/value persistence interface.

Normative requirements:

- Values are stored as **opaque snapshots** (`Uint8Array`) representing the MLS `ClientState`.
- Encoding/decoding between `ClientState` and bytes is a Marmot-TS responsibility.
- `set()` must be atomic _for that one key_ as provided by the backend.

##### Encoding note (feasibility confirmed)

Marmot-TS already uses ts-mls TLS encoding for state snapshots via `encodeGroupState`/`decodeGroupState` (see [`src/core/client-state.ts:106`](src/core/client-state.ts:106) and [`ts-mls/src/clientState.ts:162`](ts-mls/src/clientState.ts:162)).

Backends MAY internally encode bytes (e.g. base64/hex) if their underlying storage requires text, but the Marmot-TS boundary type remains `Uint8Array`.

```ts
export interface GroupStateStore {
  get(groupId: Uint8Array): Promise<Uint8Array | null>;
  set(groupId: Uint8Array, stateBytes: Uint8Array): Promise<void>;
  list(): Promise<Uint8Array[]>; // groupIds
  remove(groupId: Uint8Array): Promise<void>;
}
```

### `GroupHistoryStore` (decrypted application history)

Responsible for persisting derived, decrypted application payloads (**inner rumors**) and enough metadata to support:

- idempotent writes
- stable ordering
- stable pagination
- incremental backfill (resume)

The history store is **per-group** (bound to `groupId` at construction), matching the existing factory pattern in [`src/store/marmot-group-history-store.ts:40`](src/store/marmot-group-history-store.ts:40).

#### Subscription semantics

If the history store exposes a live subscription mechanism, it MUST mean:

- **subscribe emits only after the rumor is durably persisted**.

This avoids “dual timelines” and makes UI wiring deterministic.

##### Payload note (feasibility confirmed)

Application-message payloads decode to rumors by JSON parsing UTF-8 bytes (see [`src/core/group-message.ts:204`](src/core/group-message.ts:204)). Persisting rumors as JSON-compatible objects is therefore portable and recommended.

### Runtime ingest/subscription layer

Responsible for:

- fetching outer group events from relays
- decrypting outer NIP-44 layer and MLS layer
- applying MLS commits/proposals in a stable order
- emitting/recording application messages (rumors) to the history store

The ingest algorithm is implemented in [`src/client/group/marmot-group.ts:648`](src/client/group/marmot-group.ts:648).

## Canonical cursor and ordering

### Why cursor on _outer_ events

Backfill and “resume” are fundamentally relay operations: relays index and filter by outer event fields. Therefore the canonical resume cursor is:

**`OuterCursor = (outer_created_at, outer_event_id)`**

#### Practical relay limitation (implementation note)

Many Nostr relay implementations only support timestamp-based filtering (e.g. `since`/`until` by `created_at`) and do not natively support the composite `(created_at, id)` boundary.

Therefore, an implementation that follows this design will commonly do:

- **Network query**: request `since = cursor.created_at` (coarse, timestamp-only)
- **Client-side filter**: drop events where `(created_at, id) <= cursor` (precise, composite)

This is still consistent with the design because the **canonical** cursor and comparator remain composite; the timestamp-only network filter is an optimization to reduce bandwidth.

Using inner rumor timestamps alone is insufficient because:

- not all outer events decrypt to rumors (commits/proposals exist)
- relay ordering and pagination are based on outer events
- multiple rumors can share the same timestamp; stable pagination needs a tiebreaker

### Tiebreaker convention

For any ordering or cursor comparison where `created_at` ties, break ties with lexicographically smallest `id` (MIP-03 convention): see [`marmot/03.md:117`](marmot/03.md:117).

### Cursor comparison

Define lexicographic ordering on pairs:

- `(t1, id1) < (t2, id2)` iff `t1 < t2` OR (`t1 == t2` AND `id1 < id2`)

#### Single comparator rule (recommended)

All components (ingest, persistence, UI paging) must apply the **same composite comparator** for cursor boundaries and stable ordering.

Conceptually:

```ts
export type OuterCursor = { created_at: number; id: string };

export function compareCursor(a: OuterCursor, b: OuterCursor): -1 | 0 | 1 {
  if (a.created_at !== b.created_at)
    return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
```

## Minimal interfaces

### Per-group history store interface

Marmot-TS should depend on a per-group history store interface. Concretely, this means the interface should **not** take `groupId` on each call (it is already bound when the store instance is created).

The current mismatch between [`GroupHistoryStore`](src/client/group/marmot-group.ts:50) and [`MarmotGroupHistoryStore.saveMessage()`](src/store/marmot-group-history-store.ts:48) should be resolved by standardizing on per-group semantics.

Recommended minimal capabilities (canonical contract)

This section defines the **recommended public interface** that downstream apps should implement.

The core principle: the history store is a **derived artifact store**. It does not need to understand MLS epochs. It only needs to be:

- idempotent
- queryable
- able to expose a stable resume cursor

#### Types

`OuterCursor`

- `created_at: number` (seconds)
- `id: string` (outer event id)

`HistoryPageCursor`

- same shape as `OuterCursor` or `(rumor_created_at, rumor_id)` depending on the query (this design recommends outer cursor for backfill; rumor cursor for UI paging can also use `(rumor_created_at, rumor_id)`).

#### Interface (conceptual)

- `markOuterEventProcessed(event: { id: string; created_at: number }): Promise<void>`
  - idempotent
  - called after successful decrypt+processing attempt (even if no rumor emitted)

- `getResumeCursor(): Promise<OuterCursor | null>`
  - returns the greatest processed outer cursor by `(created_at, id)` ordering

- `addRumor(entry: { rumor: Rumor; outer: { id: string; created_at: number } }): Promise<void>`
  - idempotent on `rumor.id`
  - stores linkage to `outer.id` for audit/debug

- `queryRumors(filter: { until?: { created_at: number; id: string }; limit?: number }): Promise<Rumor[]>`
  - returns rumors in a defined order (recommended: ascending `(created_at, id)` for rendering)
  - MUST use composite cursor semantics; timestamps alone are insufficient

##### UI paging note (implementation note)

The library history-store contract is expressed in terms of `OuterCursor` for stable backfill/resume.
Some UIs may prefer to page by a “rumor cursor” (e.g. `(rumor.created_at, rumor.id)`) for rendering convenience.

If the UI cannot access outer metadata for each rumor (outer id/created_at linkage), then paging by rumor cursor is a **best-effort proxy** and should be documented as such.
The recommended long-term shape is to expose outer linkage metadata at the query boundary so the UI can page by a true outer cursor.

- `subscribe(handler: (rumor: Rumor) => void): { unsubscribe(): void }`
  - optional but recommended for UI
  - semantics: called when a rumor has been durably persisted

Note: Marmot-TS may keep convenience helpers like `saveMessage(message: Uint8Array)` (parse MLS application data → rumor), as in [`src/store/marmot-group-history-store.ts:48`](src/store/marmot-group-history-store.ts:48). But the durable storage contract should be expressed in terms of the above primitives.

#### Key identity and dedupe rules (recommended)

To prevent timeline flicker and duplicate inserts:

- **Outer event identity**: `outer_event_id`.
- **Rumor identity**: `rumor.id`.
- Any merge of “paged results” + “live subscription” MUST dedupe on `rumor.id`.

### Key package persistence (recommended)

For maximum backend portability, persist key packages in a bytes-first form.

- **Public `KeyPackage`**: persist TLS bytes produced by [`encodeKeyPackage`](ts-mls/src/keyPackage.ts:74) and decode using [`decodeKeyPackage`](ts-mls/src/keyPackage.ts:76).
- **Private key package**: ts-mls defines `PrivateKeyPackage` as a struct of `Uint8Array` fields (see [`ts-mls/src/keyPackage.ts:102`](ts-mls/src/keyPackage.ts:102)). Backends MAY encode these bytes if required by their storage.

Rationale: this avoids relying on JS object persistence semantics (structured clone vs JSON) and keeps the persisted form tied to the MLS codec.

#### Inclusivity rules

To avoid duplicates/skips, define cursor boundaries precisely:

- Backfill “newer than resume cursor” means fetch events where:
  - `created_at > cursor.created_at`, OR
  - `created_at == cursor.created_at AND id > cursor.id`

- Paging “older than cursor” means fetch items where:
  - `created_at < cursor.created_at`, OR
  - `created_at == cursor.created_at AND id < cursor.id`

These rules match the MIP-03 convention in [`marmot/03.md:117`](marmot/03.md:117).

## Stored fields (recommended)

To support the invariants, store at least:

### For each processed outer event

- `outer_event_id: string`
- `outer_created_at: number`
- `outer_cursor: (outer_created_at, outer_event_id)` (conceptual)
- `processed_at: number` (optional; local time)

### For each stored rumor

- `rumor_id: string` (primary dedupe key)
- `rumor_created_at: number`
- `rumor: Rumor`
- `outer_event_id: string` (link back to container)
- `outer_created_at: number` (optional redundancy; useful for queries)

## Invariants

### Idempotency

The history layer MUST be idempotent under replay:

- writing the same `outer_event_id` twice must not create duplicates
- writing the same `rumor_id` twice must not create duplicates

### Stable pagination

Pagination MUST use a composite cursor `(created_at, id)`; timestamps alone are insufficient.

### Failure handling

History persistence failures MUST NOT corrupt MLS state. The runtime ingest layer should:

- persist MLS state transitions (group store) reliably
- treat history writes as best-effort but observable (logging/metrics)

## Recommended data flow

1. Runtime fetches outer events from relays (optionally starting at history resume cursor)
2. For each outer event (after dedupe), attempt decrypt + MLS processing
3. On successful processing, persist MLS state transitions (group state store)
4. Record `outer_event_id` as processed and advance resume cursor
5. If an application message is produced, persist the rumor and notify subscribers
6. UI renders from history store (single source of truth)

### Write-order rule (normative)

During ingest, **MLS state persistence MUST NOT be blocked by history persistence**.

Concretely:

- Persist group state first (or regardless).
- If persisting history fails, ingest must still be able to continue, and the failure must be observable (logs/hooks).

## Ingestion model and invariants (normative)

This section defines the ingest model at the boundary between network input and durable storage.

### Inputs

- A stream/batch of **outer group events** (`kind: 445`) received from relays.

### Outputs

- MLS state updates persisted in `GroupStore`
- A durable record that an outer event has been processed (`markOuterEventProcessed`)
- Zero or more persisted rumors emitted from application messages (`addRumor`)

### Processing stages

Marmot group ingest proceeds in stages (see [`src/client/group/marmot-group.ts:648`](src/client/group/marmot-group.ts:648)):

1. **Outer decryption stage**
   - Decrypt outer NIP-44 payload using the current epoch exporter secret.
   - Decode MLSMessage.

2. **MLS processing stage**
   - Separate commits from non-commits.
   - Process non-commits first (proposals + application messages).
   - Sort commits using `(epoch, created_at, id)` and apply sequentially.
     - Tie-breaker rules align with MIP-03 timestamp/id ordering in [`marmot/03.md:117`](marmot/03.md:117).

3. **Retry stage**
   - Maintain a bounded retry loop for unreadable events.
   - Never allow permanently unreadable events to DoS consumers.

### Invariants

#### I1. Idempotent under replay

If the same outer event is delivered multiple times, the client MUST behave equivalently to receiving it once.

Implementation guidance:

- runtime layer dedupes by `outer_event_id`
- history store dedupes by `outer_event_id` and rumor store dedupes by `rumor_id`

#### I2. Monotonic resume cursor

`getResumeCursor()` MUST be monotonically non-decreasing under the `(created_at, id)` ordering.

Guidance:

- only advance the resume cursor after successfully completing decrypt+MLS processing for that outer event
- record processed events even if they yield no rumor (commit/proposal)

#### I3. MLS state persistence is authoritative

MLS state transitions (epoch advancement) MUST be persisted in `GroupStore` reliably.

If history persistence fails, the client SHOULD:

- still persist MLS state
- log/emit an error for history persistence

Rationale: losing decrypted history is recoverable (can re-fetch); corrupting MLS state breaks decryptability.

#### I4. Stable ordering

- Commit selection and processing must follow stable ordering conventions.
- History query ordering must use composite cursor ordering; timestamps alone are insufficient.

#### I5. Bounded retry

Unreadable events MUST be retried only up to a bounded budget.

This is already implemented as `maxRetries` in [`src/client/group/marmot-group.ts:650`](src/client/group/marmot-group.ts:650).

## UI guidance (single source of truth)

Demo apps should avoid maintaining a second, competing timeline in memory.

Recommended pattern:

- UI loads initial messages via history queries
- UI subscribes to “new rumor persisted” events and merges with dedupe

This avoids flicker caused by two timelines racing (see the current competing paths in [`chat/src/lib/group-subscription-manager.ts:45`](chat/src/lib/group-subscription-manager.ts:45) and [`chat/src/hooks/use-group-messages.ts:20`](chat/src/hooks/use-group-messages.ts:20)).

### Example: minimal wiring types (for refactor planning)

The following is intentionally schematic (types and names may differ in code), but captures the _signature-level_ intent needed for the next refactor iteration:

```ts
export type GroupId = Uint8Array;

export interface GroupStateStore {
  get(groupId: GroupId): Promise<Uint8Array | null>;
  set(groupId: GroupId, stateBytes: Uint8Array): Promise<void>;
  list(): Promise<GroupId[]>;
  remove(groupId: GroupId): Promise<void>;
}

export type OuterCursor = { created_at: number; id: string };

export interface GroupHistoryStore {
  markOuterEventProcessed(event: OuterCursor): Promise<void>;
  getResumeCursor(): Promise<OuterCursor | null>;

  addRumor(entry: { rumor: Rumor; outer: OuterCursor }): Promise<void>;

  queryRumors(filter: {
    until?: { created_at: number; id: string };
    limit?: number;
  }): Promise<Rumor[]>;

  subscribe?(handler: (rumor: Rumor) => void): { unsubscribe(): void };
}
```

## Implementation notes: what changes belong where

This section distinguishes changes that should happen in Marmot-TS (library) versus changes that are demo-app concerns.

### Library-level changes (Marmot-TS)

1. **Make `GroupHistoryStore` per-group and consistent**
   - Align the minimal interface used by [`MarmotGroup`](src/client/group/marmot-group.ts:139) with the per-group reality of [`MarmotGroupHistoryStore`](src/store/marmot-group-history-store.ts:29).
   - Remove the `groupId` parameter from the interface if the store instance is bound to a group.

2. **Expose / standardize resume cursor semantics**
   - Provide a stable, documented notion of `OuterCursor = (created_at, id)`.
   - Ensure cursor comparisons match MIP-03 timestamp/id tie-break conventions in [`marmot/03.md:117`](marmot/03.md:117).

3. **Document inclusivity rules**
   - Define “newer than cursor” and “older than cursor” precisely (composite ordering).

4. **History store should be idempotent by contract**
   - Require idempotency on `outer_event_id` and `rumor_id`.
   - Recommend persisting `outer_event_id` alongside stored rumors.

5. **Keep MLS ingest complexity inside Marmot-TS**
   - The ingest logic in [`MarmotGroup.ingest()`](src/client/group/marmot-group.ts:648) remains the authority for:
     - commit sorting/selection
     - retry bounds
     - MLS state progression

### Demo-app changes (chat)

1. **Single source of truth for the message timeline**
   - Use the history store for rendering.
   - Remove competing in-memory timeline buffering in the background manager.

2. **Uniform dedupe + sort in UI**
   - Ensure paging and live updates go through one merge function.

3. **Incremental backfill**
   - Request only new outer events since the stored resume cursor.

4. **Unreads and notifications**
   - Unread logic can remain in the background manager, but should reference persisted history watermarks (or computed last message times) rather than a separate buffer.

## Testing and observability (recommended)

This section is non-normative but strongly recommended for a robust developer experience.

### Observability hooks

Provide (or encourage apps to implement) lightweight callbacks or events around ingest:

- `onOuterEventProcessed({ id, created_at, outcome })`
  - outcome examples: `processed`, `duplicate`, `unreadable`, `retry_exhausted`

- `onCommitApplied({ epoch })`

- `onRumorPersisted({ rumor_id, outer_event_id })`

These hooks allow demo apps and downstream integrators to diagnose “we received it but couldn’t decrypt yet” scenarios without coupling UI to MLS internals.

### Test matrix

High-value regression tests:

1. **Cursor stability**
   - Given multiple items with the same `created_at`, ensure pagination using `(created_at, id)` does not skip or duplicate.

2. **Replay/idempotency**
   - Ingest the same outer event batch twice; ensure:
     - no duplicate rumors
     - resume cursor is unchanged after second ingest

3. **Commit race selection**
   - Two competing commits for the same epoch:
     - earliest `created_at` wins
     - if tied, lexicographically smallest `id` wins
   - This should match [`marmot/03.md:117`](marmot/03.md:117).

4. **Retry budget / DoS resistance**
   - Include permanently unreadable outer events; ensure ingest terminates cleanly and does not prevent readable events from being processed (bounded retry in [`src/client/group/marmot-group.ts:650`](src/client/group/marmot-group.ts:650)).

5. **Watermark correctness with mixed message types**
   - Process a sequence where some outer events yield only commits/proposals; ensure `getResumeCursor()` still advances.
