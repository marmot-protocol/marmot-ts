# Phase 4: Feature Parity & Conformance Vectors - Pattern Map

**Mapped:** 2026-09-04
**Files analyzed:** 18 likely new/modified files
**Analogs found:** 18 / 18

## File Classification

Exact new filenames are discretionary in `04-CONTEXT.md`; this map assigns the narrowest likely files and the existing files that should be modified in place.

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/core/components/ids.ts` | config/model | transform | same file, component-ID registry | exact |
| `src/core/components/dictionary.ts` | utility/codec | transform | same file, app-component registry/builders | exact |
| `src/core/components/__tests__/dictionary.test.ts` | test | transform | same file, byte/dictionary tests | exact |
| `src/engine/own-commit-stamp.ts` (new) | model/codec | file-I/O, transform | `src/engine/history-tree.ts` | role-match |
| `src/engine/group-engine.ts` | service/state machine | event-driven, streaming | same file | exact |
| `src/engine/retained-store.ts` | store | CRUD | same file | exact |
| `src/engine/ingestion-pool.ts` | store | event-driven | same file | exact |
| `src/engine/state-notifications.ts` | model/store | event-driven, transform | same file | exact |
| `src/client/group/wrapper-ledger.ts` (new) | store | CRUD | `src/engine/history-tree.ts` + `src/engine/message-dedup.ts` | role/data-flow composite |
| `src/client/session/group-session.ts` | service/adapter | streaming, file-I/O | same file | exact |
| `src/client/runtime/group-runtime.ts` | service | request-response, file-I/O | same file | exact |
| `src/client/group/marmot-group.ts` | service/orchestrator | event-driven, streaming | same file | exact |
| `src/__tests__/conformance/manifest.ts` (new) | test utility | file-I/O, transform | MDK manifest + existing typed helpers | role-match |
| `src/__tests__/conformance/runner.ts` (new) | test utility | event-driven, batch | `src/engine/__tests__/convergence-parity.test.ts` | data-flow match |
| `src/__tests__/conformance/subject.ts` (new) | test adapter | request-response, event-driven | `src/client/session/group-session.ts` | role-match |
| `src/__tests__/conformance/snapshot.ts` (new) | test utility | transform | `src/engine/state-notifications.ts` | data-flow match |
| `src/__tests__/conformance/smoke.test.ts` (new) | test | batch | `src/engine/__tests__/convergence-parity.test.ts` | role-match |
| restart/pressure/proof fixture tests | test | file-I/O, event-driven | `src/__tests__/integration/app-message-replay-restart.test.ts`, `src/__tests__/helpers/mock-network.ts`, `src/__tests__/helpers/account-proof.ts` | exact/composite |

## Pattern Assignments

### `src/core/components/ids.ts` and `dictionary.ts` (wire registry and codec)

**Analog:** existing component registration in `src/core/components/ids.ts` and `src/core/components/dictionary.ts`.

**ID and advertised-list pattern** (`ids.ts` lines 16-31, 58-77):

```typescript
export type AppComponentId = number;
export const APP_COMPONENTS_COMPONENT_ID: AppComponentId = 0x0001;
export const NOSTR_ROUTING_COMPONENT_ID: AppComponentId = 0x8004;

export const SUPPORTED_APP_COMPONENT_IDS: readonly AppComponentId[] = [
  GROUP_PROFILE_COMPONENT_ID,
  GROUP_ADMIN_POLICY_COMPONENT_ID,
  NOSTR_ROUTING_COMPONENT_ID,
];
```

Add SafeAAD as a wire-significant named constant, and update the advertised list exactly as the current reference fixture requires. Keep protocol bytes as `Uint8Array` and constants named in `SCREAMING_SNAKE_CASE`.

**Sorted dictionary + duplicate validation** (`dictionary.ts` lines 87-120):

```typescript
export function componentEntry(componentId: AppComponentId, data: Uint8Array): ComponentData {
  return { componentId, data };
}

export function buildAppDataDictionary(entries: ComponentData[]): AppDataDictionary {
  const sorted = [...entries].sort((a, b) => a.componentId - b.componentId);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].componentId === sorted[i].componentId) {
      throw new UsageError(`Duplicate app component id 0x${sorted[i].componentId.toString(16)}`);
    }
  }
  return sorted;
}
```

**Leaf extension builder seam** (`dictionary.ts` lines 123-133):

```typescript
export function makeLeafAppComponentsExtension(
  supportedIds: readonly AppComponentId[] = SUPPORTED_APP_COMPONENT_IDS,
): CustomExtension {
  return makeAppComponentsExtension([appComponentsEntry([...supportedIds])]);
}
```

Change this builder rather than KeyPackage call sites: emit the advertised `0x0001` entry and the separate empty SafeAAD `0x0002` entry here so all LeafNode/KeyPackage paths receive identical bytes.

**Test pattern** (`dictionary.test.ts` lines 39-64): create extensions through production builders, assert ascending IDs and duplicate rejection. Add a full encoded-extension byte fixture, not only decoded membership assertions.

---

### `src/engine/own-commit-stamp.ts` and `group-engine.ts` (versioned durable evidence)

**Analog:** `src/engine/history-tree.ts`.

**Namespaced byte-store pattern** (`history-tree.ts` lines 20-32):

```typescript
const HISTORY_TREE_VERSION = 1;
type HistoryTreeStore = GenericKeyValueStore<Uint8Array>;
const metaKey = (gid: string) => `${gid}/meta`;
const commitKey = (gid: string, tag: string) => `${gid}/commit/${tag}`;
```

Use a distinct namespaced key per group/commit and a version byte. Keep wire bytes and stamp fields together, sort proposal references before encoding, and model legacy decode explicitly rather than guessing missing evidence.

**Versioned codec pattern** (`history-tree.ts` lines 573-609):

```typescript
function encodeEdgeRecord(node: MutableNode): Uint8Array {
  const w = new BinaryWriter().uint8(HISTORY_TREE_VERSION).varint(node.epoch);
  // ordered fields with explicit optional-value tags
  return w.build();
}

function decodeEdgeRecord(bytes: Uint8Array) {
  const r = new BinaryReader(bytes);
  const version = r.uint8();
  if (version !== HISTORY_TREE_VERSION)
    throw new Error(`GroupHistoryTree: unknown edge record version ${version}`);
  // decode fields
  r.end();
}
```

Preserve strict end-of-input validation and explicit presence bytes. If legacy records lack a stamp, return a discriminated compatibility result such as `{ kind: "legacyUnstamped", ... }`; do not reconstruct consumed proposal references from parent state.

**Confirmation ordering seam** (`group-runtime.ts` lines 263-287): publish first, then `confirmPublished`, then persist confirmed state. Stamp capture must occur before `confirmPublished` clears staged evidence, and persistence failure must surface in the existing structured `persistence: { kind: "failed", error }` result.

**Lifecycle failure pattern** (`group-engine.ts` lines 1018-1041): on failed/abandoned commit publication, transition `PendingPublish -> Stable` and clear staged metadata. Extend the same cleanup to the stamp without applying the pending state.

---

### `retained-store.ts` and `ingestion-pool.ts` (missing-parent retention)

**Analog:** their existing horizon and pinned-state behavior.

**Retained canonical/intermediate state pattern** (`retained-store.ts` lines 115-148):

```typescript
record(parentState, appliedMessage, newState, pinnedEpochs = []): void {
  this.#states.set(parentEpoch, parentState);
  this.#states.set(newEpoch, newState);
  this.#appliedLinks.set(parentEpoch, { parentState, message: appliedMessage, resultingState: newState });
  const pins = new Set(pinnedEpochs);
  for (const epoch of prunableRetainedEpochs(this.#states.keys(), newEpoch, max, pins))
    this.#states.delete(epoch);
}
```

Retain every authenticated intermediate anchor and pass active source epochs as pins. Expiry must be based on `canonicalTipEpoch - authenticatedSourceEpoch > maxRewindCommits`, including the existing `Infinity` policy behavior—not arrival time.

**Deferred pool identity pattern** (`ingestion-pool.ts` lines 3-16, 65-82): entries use a stable transport ID and preserve first-sighting metadata when re-added. Adapt the metadata from `arrivalEpoch` to authenticated source epoch once known; do not terminalize missing-parent input merely because an attempted state fails.

---

### `src/client/group/wrapper-ledger.ts` and `group-session.ts` (outer-wrapper dedup)

**Analogs:** `src/engine/message-dedup.ts`, `src/engine/history-tree.ts`, and the current session ingress.

**Layer boundary** (`group-session.ts` lines 488-514): outer Nostr event IDs are already classified before the transport-agnostic engine. Keep the durable wrapper ledger here; pass only non-consumed events to `engine.ingest`.

**Persistence pattern** (`history-tree.ts` lines 465-491, 499-534): stage dirty records, persist under group-prefixed keys with `GenericKeyValueStore<Uint8Array>`, enumerate prefixed keys on load, and keep already-persisted records clean.

Only record a wrapper ID with a terminal disposition (`processed`, terminal `skipped`/`rejected`/`unreadable`, etc.). Deferred or capacity-refused results remain redeliverable. Inner `contentDedupId` stays separate: `group-engine.ts` lines 272-286 documents why it cannot cover malformed wrappers or restart durability.

---

### `state-notifications.ts` (withdrawal and revalidation)

**Analog:** `StateNotification` and `StateNotificationLedger` in the same file.

**Discriminated result pattern** (`state-notifications.ts` lines 16-47):

```typescript
export type StateNotification =
  | { kind: "epochAdvanced"; commitDigest: Uint8Array; from: number; to: number }
  | { kind: "memberAdded"; commitDigest: Uint8Array; pubkey: string }
  | { kind: "branchRecovered"; commitDigest: Uint8Array; forkEpoch: number };
```

Add explicit revalidation as another `kind` variant carrying stable commit/effect identity. Preserve deterministic ordering and `Uint8Array` digests.

**Exactly-once ledger pattern** (`state-notifications.ts` lines 178-244): derive a stable `digest:epoch` key; `record` returns early when already present; rewind removes only noncanonical entries after the fork epoch. Extend persisted evidence to distinguish branch-selection withdrawal from terminal invalidation and to reconcile re-adoption after restart.

**Test analog:** `src/engine/__tests__/state-notification-withdrawal.test.ts` lines 516-754 covers real fork withdrawal and locally confirmed commits. Add same-batch ordered verdict, exactly-once revalidation, and persist/reload cases beside these—not isolated mocks.

---

### `marmot-group.ts` and engine scheduling (fixed pass deadline and fairness)

**Analog:** current injectable convergence clock/scheduler and outbound queue.

**Injection pattern** (`group-engine.ts` lines 151-217): define a narrow scheduler interface, provide runtime defaults with `setTimeout`/`clearTimeout`, and accept `now?: () => number` plus scheduler hooks through options. Introduce a monotonic clock abstraction without Node-only timer types.

**Batch status pattern** (`group-engine.ts` lines 1049-1109): drain the async generator, derive convergence status from yielded results, and sample injected time at the convergence boundary. Replace the resettable `lastConvergenceRelevantInputMs` semantics for pass bounding with one immutable `openedAtMs/deadlineMs` sampled once; retain later input outside the active pass.

**Queue seam:** `marmot-group.ts` lines 732-815 queues outbound intents and drains only when lifecycle/convergence allows it. After a pass settles in `Stable`, take exactly one already-queued authorized local state intent before admitting inbound-only work to another pass. While `PendingPublish`/`Merging`, retain inbound input without opening a pass.

---

### `src/__tests__/conformance/*` (manifest runner, subject, snapshot)

**Analog:** `src/engine/__tests__/convergence-parity.test.ts` plus integration helpers.

Use production `MarmotGroupEngine`/`MarmotGroup`, real `ts-mls` states, serialized reloads, and fully drained async iterables. `convergence-parity.test.ts` lines 289-327 and 624-658 demonstrate `confirmPublished`, `serializeClientState`/`deserializeClientState`, opposite delivery orders, and draining `engine.ingest`.

**Async drain pattern** (`app-message-replay-restart.test.ts` lines 46-50):

```typescript
async function collectKinds(gen: AsyncIterable<{ kind: string }>) {
  const kinds: string[] = [];
  for await (const r of gen) kinds.push(r.kind);
  return kinds;
}
```

**Actual restart pattern** (`app-message-replay-restart.test.ts` lines 128-159): reuse one `InMemoryKeyValueStore`, persist through normal ingest/save, construct a new group from `deserializeClientState(await store.getItem(...))`, replay the event, and compare state/effects. Do not simulate restart by cloning objects.

**Network fault seam** (`src/__tests__/helpers/mock-network.ts` lines 34-105): `MockNetwork.events` is shared relay storage; `publish` appends and notifies live filtered subscribers; `request` replays matching events; `subscription` replays then streams until unsubscribe. Extend this shared helper with deterministic delivery ordering/failure controls rather than inline network doubles.

**Proof fixture seam** (`src/__tests__/helpers/account-proof.ts` lines 1-20): use `PrivateKeyAccount` and `signAccountIdentityProof` for generated cases; load Rust-signed proof-v2 bytes as immutable fixture input and verify through the production proof verifier.

**Manifest loader constraints:** parse `refs/mdk/crates/cgka-conformance-simulator/vectors/manifest.v1.json`; preserve upstream IDs; resolve only manifest-declared relative paths beneath the pinned vectors root; reject absolute/traversal paths; validate required fields; return explicit `{ kind: "unsupported", capability, reason }` rather than silently omitting tests.

**Snapshot pattern:** follow `deriveStateNotifications` (`state-notifications.ts` lines 64-124): pure input-to-output projection, sorted members/component IDs, no I/O or fixture branching. Include every canonical field required by `refs/marmot/foundation/conformance.md`, per-input dispositions, and application-visible outputs.

## Shared Patterns

### Imports and Module Shape

- Named exports only; relative imports under `src/` end in `.js`.
- Use `import type` for type-only dependencies.
- Protocol/persistence bytes are `Uint8Array`; hex uses `@noble/hashes/utils.js`.
- No `Buffer`, `node:fs`, `process`, or Node timer types in production code. Test-only fixture loading must use a runtime-portable strategy or small copied fixtures when the runtime cannot access `refs/mdk`.

### Error and Outcome Handling

- Throw `Error`/domain subclasses for corrupt codecs or illegal state (`history-tree.ts` lines 594-608; `group-engine.ts` lines 144-148).
- Use `kind`-discriminated unions for expected unsupported/deferred/refused/terminal outcomes.
- Publication errors roll lifecycle back; post-publication persistence failure is reported structurally and must never trigger republish (`group-runtime.ts` lines 263-287).

### Persistence

- `GenericKeyValueStore<Uint8Array>` with group-prefixed keys.
- Explicit version byte, ordered fields, optional-field presence tags, strict decoder `end()`.
- Test durability through normal save/load constructors using `InMemoryKeyValueStore`; document degraded behavior when no durable store is supplied.

### Determinism

- Sort proposal refs, members, component IDs, and stable identities before serialization/projection.
- Sample an injected monotonic clock once per pass opening.
- Fully drain async generators before starting the next batch.
- Preserve manifest scenario names as Vitest test identifiers.

### Cross-Runtime Constraints

- Phase 04 smoke runs in normal Vitest; large offline pressure is deterministic extended coverage for Phase 5.
- New production code must remain compatible with Node 20+, Deno 2, and Bun 1.1+.
- Use Web/ES APIs and existing abstractions; do not add packages or copy MDK SQLite/runtime machinery.

## No Analog Found

No likely file lacks a usable analog. The exact MDK JSON action schema and canonical expected snapshots are upstream contracts rather than existing TypeScript analogs; the planner should use `04-RESEARCH.md`, `refs/marmot/foundation/conformance.md`, and the pinned MDK manifest for those details while retaining the codebase patterns above.

## Metadata

**Analog search scope:** `src/core/components`, `src/engine`, `src/client`, `src/__tests__`, `refs/mdk` paths identified by research
**Strong analogs inspected:** 12 source/test files
**Pattern extraction date:** 2026-09-04
