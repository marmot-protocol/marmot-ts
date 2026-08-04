# Phase 3: Commit Integrity & Convergence Parity - Pattern Map

**Mapped:** 2026-08-04
**Files analyzed:** 14 (5 new, 9 modified) + 2 test files
**Analogs found:** 14 / 14

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/core/components/integrity.ts` (new) | utility (pure validator) | transform | `src/core/components/admin-policy.ts` (codec/validation) + `src/core/components/dictionary.ts` (dictionary reads) | role-match |
| `src/core/components/admin-policy.ts` (add coupling validator, per discretion) | utility (pure validator/codec) | transform | itself (existing codec) | exact |
| `src/core/client-state.ts` (`requiredComponentIds`) | utility (pure derivation) | transform | `src/core/components/dictionary.ts` `getAppComponents` | exact |
| `src/core/inbound.ts` (add `SelfEvicted` outcome) | model/constants (vocabulary) | transform | itself — `BeyondAnchor`/`MissingRetainedAnchor` entries (existing) | exact |
| `src/core/group-members.ts` (read-only, reused) | utility | transform | n/a — reused as-is (`getPubkeyLeafNodeIndexes`) | exact |
| `src/engine/types.ts` (widen `RejectedIngestResult`, `SkippedIngestResult`, `ProcessedIngestResult`, add `stateInvalidated`) | model (discriminated union) | event-driven | itself — `RemovedIngestResult`/`InvalidatedIngestResult` shape | exact |
| `src/engine/ingest-disposition.ts` (add cases) | transform (pure mapper) | transform | itself — existing `switch (result.kind)` | exact |
| `src/engine/ingest.ts` (inbound seam: validate + SelfEvicted short-circuit) | service (ingest pipeline) | streaming (async generator) | itself — commit branch ~L595-663, `removedFromGroup` detection ~L626-633 | exact |
| `src/engine/admin-policy.ts` (extend callback to capture proposals) | middleware (ts-mls `IncomingMessageCallback`) | event-driven | itself — `createAdminCommitPolicyCallback` | exact |
| `src/engine/group-engine.ts` (`send()` commit case: auto-couple, depletion guard, integrity validate, removed-group throw) | controller (state machine command) | request-response | itself — `#sendInner` `"commit"` case ~L464-573 | exact |
| `src/engine/fork-recovery.ts` (`#buildBranches`/`explore()`: validate candidate edges) | service (candidate-edge builder) | batch/transform | itself — `explore()` ~L157-230, `processMessage`/`next.kind` check ~L173-188 | exact |
| `src/engine/state-notifications.ts` (new) | model + service (ledger) | event-driven | `src/engine/delivered-payloads.ts` (`DeliveredPayloadLedger`) | exact |
| `src/client/group/marmot-group.ts` (load-path realize call, marker storage, event re-emit) | provider/facade (composes session+runtime) | event-driven | itself — `fromClientState` ~L465-480, `removed` event handling ~L679-683, `#rejectQueuedOutbound` ~L627 | exact |
| `src/client/groups-manager.ts` (`#connectGroup` drain — folded todo) | service (event dedup) | event-driven | itself — `rejectedEvents` drain ~L495-540 | exact |
| `src/core/components/__tests__/integrity.test.ts` (new) | test | transform | `src/core/components/__tests__/admin-policy.test.ts` (if present) or sibling `dictionary`/component tests | role-match |
| `src/engine/__tests__/convergence-parity.test.ts` or similar (new, CONV-04) | test | event-driven | `src/engine/__tests__/fork-recovery.test.ts` (existing native engine tests) | role-match |

## Pattern Assignments

### `src/core/components/integrity.ts` (new pure validator, core)

**Analog:** `src/core/components/dictionary.ts` (read helpers) + `src/core/components/admin-policy.ts` (throw style)

**Imports pattern** (mirror `dictionary.ts` lines 1-23):
```typescript
/** @module @category Core - App Components */
import {
  ComponentData,
  GroupContextExtension,
  getAppDataDictionary,
} from "ts-mls";
import { UsageError } from "ts-mls";

import {
  AppComponentId,
  APP_COMPONENTS_COMPONENT_ID,
} from "./ids.js";
```
Named exports only; `.js` extensions on relative imports; no default export.

**Doc-comment pattern** (mirror `admin-policy.ts` lines 1-20 — cite the Rust source + spec doc directly above the function):
```typescript
/**
 * ...
 * @see refs/mdk/crates/cgka-engine/src/app_components.rs
 *      `validate_app_component_integrity_for_staged_commit` (~L345)
 * @see Marmot v2 spec: `app-components/admin-policy-v1.md` "Validation"
 */
```

**Core validation pattern** — pure function returning a typed result, not throwing (research's Pattern 2 body is
already the ported algorithm; copy it verbatim into this module):
```typescript
export function validateAppComponentIntegrity(args: {
  currentExtensions: GroupContextExtension[];
  resultingExtensions: GroupContextExtension[];
  appDataUpdateOps: AppDataUpdateOp[];
  requiredIds: AppComponentId[];
}): { reason: "component-integrity"; detail: string } | undefined {
  // ... see 03-RESEARCH.md "Pattern 2" for the full ported body
}
```

**Error-handling split (D-02/D-14 vs D-03/D-13):** this module's functions return `undefined | { reason; detail }` —
they never throw. The *callers* at each seam decide whether to throw (`send()`, mirroring `UsageError` from
`buildAppDataDictionary` in `dictionary.ts` L99-111) or to yield a typed `rejected`/dropped-edge result. Do not put
`throw` inside `integrity.ts` itself — this is the split CLAUDE.md documents: "throw for domain/validation failures
[at the send call site], typed results for expected inbound multi-outcome flows."

**`UsageError` precedent** (`src/core/components/dictionary.ts` lines 99-111):
```typescript
export function buildAppDataDictionary(
  entries: ComponentData[],
): AppDataDictionary {
  const sorted = [...entries].sort((a, b) => a.componentId - b.componentId);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1].componentId === sorted[i].componentId) {
      throw new UsageError(
        `Duplicate app component id 0x${sorted[i].componentId.toString(16)}`,
      );
    }
  }
  return sorted;
}
```
This is the exact throw-site precedent D-02/D-07 cite for `group-engine.ts`'s send-path throws (integrity violation,
`AdminDepletion`).

**Admin/leaf coupling validator** (co-located here per research's Open Question 1 recommendation, or beside
`admin-policy.ts`'s codec per CONTEXT.md's discretion — either way it is a second pure function in the same style):
```typescript
export function validateAdminLeafCoupling(args: {
  currentAdmins: string[];
  survivingAccounts: ReadonlySet<string>; // pubkeys with >=1 surviving leaf, D-08
  resultingAdminBytes: string[] | undefined; // decoded admin-policy.v1 if the commit carries one
}): { reason: "admin-leaf-coupling"; detail: string } | undefined {
  // carried-forward fallback per Pitfall 3: if resultingAdminBytes is undefined,
  // the resulting admin set is args.currentAdmins (unchanged) — still must be
  // checked against survivingAccounts.
}
```

---

### `src/core/inbound.ts` (extend named-outcome map, D-13)

**Analog:** itself, lines 87-92 (existing `convergenceOutcomeToCategory`)

```typescript
// src/core/inbound.ts (existing, lines 87-92)
export const convergenceOutcomeToCategory = {
  BeyondAnchor: inputCategories.missingHistory,
  MissingRetainedAnchor: inputCategories.missingHistory,
} as const satisfies Record<string, InputCategory>;
```

**Change:** add one line, `SelfEvicted: inputCategories.staleEpoch,` — same shape, same `as const satisfies`
pattern. `ConvergenceOutcome` (line 94-95, `keyof typeof convergenceOutcomeToCategory`) picks it up automatically.

---

### `src/engine/types.ts` (widen result types)

**Analog:** itself — `RemovedIngestResult` (lines 190-204) and `InvalidatedIngestResult` (lines 143-173) for doc-comment
style and field shape; `SkippedIngestResult.reason` (lines 100-113) for the reason-union extension pattern.

**Doc-comment style to copy** (cite the spec doc directly, explain *why* this variant exists, not just what):
```typescript
/**
 * An inbound commit that removed *this* client from the group — an admin's
 * involuntary `Remove`, or a peer committing this client's own `self_remove`
 * (`protocol-core/member-departure.md`). ...
 */
export type RemovedIngestResult<TEnvelope> = {
  kind: "removed";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
};
```

**Reason-union extension pattern** (`SkippedIngestResult`, lines 100-113 — add `"self-evicted"` as one more member):
```typescript
export type SkippedIngestResult<TEnvelope> = {
  kind: "skipped";
  envelope: TEnvelope;
  message: MlsMessage;
  reason:
    | "past-epoch"
    | "wrong-wireformat"
    | "self-echo"
    | "duplicate"
    | "beyond-anchor"
    | "missing-retained-anchor"
    | "invalid-app-payload"
    | "self-evicted"; // NEW, D-13
};
```

**Additive-field pattern for `RejectedIngestResult`** (D-03 — widen without breaking the shape):
```typescript
export type RejectedIngestResult<TEnvelope> = {
  kind: "rejected";
  result: ProcessMessageResult;
  envelope: TEnvelope;
  message: MlsMessage;
  /** Extensible; additive. */
  reason?: "admin-policy" | "component-integrity" | "admin-leaf-coupling"; // NEW, D-03
};
```

**`ProcessedIngestResult` + new `stateInvalidated` variant** — add `notifications?: StateNotification[]` to
`ProcessedIngestResult` (lines 85-90), and add a new union member modeled directly on `InvalidatedIngestResult`'s
shape (lines 163-173) but for state notifications instead of app payloads, then add it to the `IngestResult<TEnvelope>`
union (lines 207-215).

---

### `src/engine/ingest-disposition.ts` (add cases)

**Analog:** itself, the full file (49 lines) — a single `switch (result.kind)` mapping each `IngestResult.kind` to a
`Disposition`.

```typescript
// src/engine/ingest-disposition.ts (existing pattern, lines 13-48)
switch (result.kind) {
  case "processed":
    return disposition.accepted();
  case "rejected":
    return disposition.stale(inputCategories.authorizationFailed);
  // ... existing cases ...
  case "skipped":
    switch (result.reason) {
      case "past-epoch":
        return disposition.stale(inputCategories.alreadyApplied);
      // NEW: case "self-evicted": return disposition.stale(inputCategories.staleEpoch);
      // ... existing cases ...
    }
  // eslint-disable-next-line no-fallthrough
  case "unreadable":
    return disposition.stale(inputCategories.invalidEncoding);
  // NEW: case "stateInvalidated": return disposition.accepted(); (or its own kind, TBD in planning)
}
```
One case per new reason/kind, matching the existing exhaustive-switch discipline exactly (CLAUDE.md: "Discriminated
union types use a `kind` string literal discriminant"; `ingestResultDisposition` is the canonical example).

---

### `src/engine/ingest.ts` (inbound seam — validate + SelfEvicted short-circuit)

**Analog:** itself, commit branch lines 595-663 (post-`processMessage`, pre-`setState` gate) and the `removedFromGroup`
detection at lines 618-634.

**Core pattern to extend** (exact insertion point — after `result.kind === "newState"` and the existing
`actionTaken === "reject"` branch, before `ctx.setState`):
```typescript
// src/engine/ingest.ts lines 607-643 (existing)
if (result.kind === "newState") {
  if (result.actionTaken === "reject") {
    log("commit envelope:%s rejected by admin policy", envelopeLabel(envelope));
    ctx.dedup.remember(message);
    yield { kind: "rejected", result, envelope, message }; // ADD: reason: "admin-policy"
    continue;
  }

  const parentState = ctx.getState();

  // NEW (D-01/D-03 gate): validate BEFORE ctx.setState, using capturedProposals
  // from the admin callback side channel (see admin-policy.ts pattern below).
  // const violation = validateAppComponentIntegrity({...}) ?? validateAdminLeafCoupling({...});
  // if (violation) {
  //   ctx.dedup.remember(message);
  //   yield { kind: "rejected", result, envelope, message, reason: violation.reason };
  //   continue;
  // }

  ctx.setState(result.newState);

  // Existing removedFromGroup tombstone detection — CONV-02's marker/notification
  // wiring extends this branch, does not replace it:
  if (result.newState.groupActiveState.kind === "removedFromGroup") {
    log("commit envelope:%s removed us from the group", envelopeLabel(envelope));
    ctx.dedup.remember(message);
    yield { kind: "removed", result, envelope, message };
    return;
  }

  ctx.recordCommit(parentState, message, result.newState);
  ctx.dedup.remember(message);
  yield { kind: "processed", result, envelope, message }; // ADD: notifications: [...]
}
```

**SelfEvicted short-circuit (D-13)** — belongs near the top of the ingest loop, before any peel/decrypt, styled like
the existing early-exit skip yields (e.g. `wrong-wireformat` at lines 548-558):
```typescript
// Pattern to mirror (existing early skip, lines 548-558):
if (
  message.wireformat !== wireformats.mls_private_message &&
  message.wireformat !== wireformats.mls_public_message
) {
  yield { kind: "skipped", envelope, message, reason: "wrong-wireformat" };
  continue;
}
// NEW analog: if the group's removed-inactive marker is set, short-circuit the
// WHOLE BATCH before any peel/decrypt call — this needs a check earlier than the
// per-message loop (at the top of ingestEnvelopes / the batch entry point), not
// inside the commit-branch loop.
```

---

### `src/engine/admin-policy.ts` (capture proposals side channel)

**Analog:** itself — `createAdminCommitPolicyCallback`, full file (116 lines), specifically the wrapping-callback
shape research's Pattern 1 already specifies.

```typescript
// src/engine/admin-policy.ts (existing signature/style, lines 24-37)
export function createAdminCommitPolicyCallback(args: {
  ratchetTree: ClientState["ratchetTree"];
  adminPubkeys: string[];
  ciphersuiteId: number;
  onUnverifiableCommit?: "reject" | "retry";
}): IncomingMessageCallback {
  const { ratchetTree, adminPubkeys, ciphersuiteId, onUnverifiableCommit = "retry" } = args;
  return (incoming) => {
    if (incoming.kind === "proposal") return "accept";
    // ... existing per-proposal checks ...
  };
}

// NEW wrapper (research's Pattern 1, verbatim shape) — a thin decorator around
// the existing callback, added either in this file or as a new export:
export function createValidatingAdminCallback(args: {
  ratchetTree: ClientState["ratchetTree"];
  adminPubkeys: string[];
  ciphersuiteId: number;
  onCapturedProposals: (proposals: ProposalWithSender[]) => void;
}): IncomingMessageCallback {
  const inner = createAdminCommitPolicyCallback(args);
  return (incoming) => {
    if (incoming.kind === "commit") args.onCapturedProposals(incoming.proposals);
    return inner(incoming);
  };
}
```

---

### `src/engine/group-engine.ts` (`send()` — auto-couple, depletion guard, integrity validate, removed-group throw)

**Analog:** itself — `#sendInner`'s `"commit"` case, lines 464-573.

**Insertion points, in order, all inside the existing `case "commit":` block**:
1. **D-14 removed-group throw** — at the very top of `#sendInner` (or `send()`), before the `switch`, mirroring the
   existing `mayPrepareLocalCommit` guard style (lines 470-474):
   ```typescript
   // Existing guard pattern to mirror (line 470-474):
   if (!mayPrepareLocalCommit(this.#lifecycle)) {
     throw new Error(`Cannot prepare a commit while the group is ${this.#lifecycle}`);
   }
   // NEW, same shape, checked earlier (before any staging, D-14):
   // if (this.#removedInactive) throw new Error("Cannot send: removed from group.");
   ```
2. **D-05/D-07 auto-couple + depletion guard** — after `allProposals` is assembled (line 506) and before the
   non-admin authorization check (line 516), following the existing "derive → guard → mutate `allProposals`" shape
   already used for `newProposals`/`selectedProposals` (lines 482-506):
   ```typescript
   const allProposals = [...newProposals, ...selectedProposals]; // existing, line 506
   // NEW: removedLeaves = leavesRemovedBy(allProposals) [defaultProposalTypes.remove only, Pitfall 4]
   //      survivingAccounts = accountsSurviving(this.state, removedLeaves) [D-08, uses getPubkeyLeafNodeIndexes]
   //      if (resultingAdmins.length === 0 && currentAdmins.length > 0 && removedLeaves.size > 0)
   //        throw new AdminDepletionError(...); // D-07, same throw style as line 526-528 below
   //      if (resultingAdmins.length !== currentAdmins.length)
   //        allProposals.push({ proposalType: appDataUpdate, ... }); // D-05, splice into same commit
   ```
3. **Existing throw-style precedent to copy exactly** (lines 516-530 — the non-admin authorization check is the
   direct template for `AdminDepletionError`'s throw site and message style):
   ```typescript
   if (!groupData.adminPubkeys.includes(intent.actorPubkey)) {
     const selfUpdateOnly = allProposals.every(
       (p) => p.proposalType === defaultProposalTypes.update,
     );
     const selfRemoveOnly =
       allProposals.length > 0 &&
       allProposals.every((p) => p.proposalType === selfRemoveProposalType);
     if (!selfUpdateOnly && !selfRemoveOnly) {
       throw new Error(
         "Not a group admin. Non-admins may only commit a self-update-only or self_remove-only commit.",
       );
     }
   }
   ```
4. **D-01/D-02 integrity validate before wrap** — after `createCommit` returns `newState` (line 543-550) but before
   the lifecycle transition / envelope wrap (lines 552-572):
   ```typescript
   const parentState = this.state; // existing, line 542
   const { commit, newState, welcome } = await createCommit({ /* existing */ }); // line 543
   // NEW: const violation = validateAppComponentIntegrity({ currentExtensions: parentState.groupContext.extensions,
   //        resultingExtensions: newState.groupContext.extensions, appDataUpdateOps: allProposals-derived ops,
   //        requiredIds: getAppComponents(parentState.groupContext.extensions) ?? [] })
   //      ?? validateAdminLeafCoupling({...});
   // if (violation) throw new UsageError(violation.detail); // D-02, before wrap/publish
   this.#transitionLifecycle(groupLifecycleStates.pendingPublish, "begin_pending", "commit"); // existing, line 552
   ```

---

### `src/engine/fork-recovery.ts` (`#buildBranches`/`explore()` — validate candidate edges, D-04/D-09)

**Analog:** itself, `explore()` lines 157-230, specifically the `processMessage` call (175-184) and the
`actionTaken === "reject"` filter (line 188).

```typescript
// src/engine/fork-recovery.ts, existing pattern (lines 173-211)
let next: ProcessMessageResult;
try {
  next = await processMessage({
    context: { cipherSuite: this.#ciphersuite, authService: marmotAuthService, externalPsks: {} },
    state,
    message,
    callback,
  });
} catch {
  continue;
}
if (next.kind !== "newState" || next.actionTaken === "reject") continue;
// NEW (D-01/D-04 gate, same drop-the-candidate-edge shape as the actionTaken
// filter above — no yield/throw at this seam, just `continue` to skip the edge):
// const violation = validateAppComponentIntegrity({ currentExtensions: state.groupContext.extensions,
//   resultingExtensions: next.newState.groupContext.extensions, appDataUpdateOps: capturedProposals,
//   requiredIds: getAppComponents(state.groupContext.extensions) ?? [] }) ?? validateAdminLeafCoupling({...});
// if (violation) continue; // the commit never creates a branch edge (D-04: no grandfathering)
const tag = bytesToHex(next.newState.confirmationTag); // existing, line 189
```
The `callback` passed to `processMessage` here (line 176-183, param `callback: IncomingMessageCallback`, threaded in
from `#buildBranches`' caller) is the same seam that needs `createValidatingAdminCallback`'s proposal-capture wrapper
so `capturedProposals` is available at this call site too.

---

### `src/engine/state-notifications.ts` (new — StateNotification model + ledger)

**Analog:** `src/engine/delivered-payloads.ts` (`DeliveredPayloadLedger`, full file, 83 lines) — structural template
explicitly named by both CONTEXT.md (D-11) and RESEARCH.md.

**Doc-comment + module header pattern** (copy the framing style exactly):
```typescript
/** @module @category Engine */
import type { MlsMessage } from "ts-mls";
```

**Ledger class shape to mirror** (`DeliveredPayloadLedger`, lines 37-82 — same three methods, same bounded-array
internal storage, same epoch-based pruning):
```typescript
export class StateNotificationLedger {
  #entries: { digest: string; epoch: number; notifications: StateNotification[] }[] = [];

  get size(): number {
    return this.#entries.length;
  }

  record(digest: Uint8Array, epoch: number, notifications: StateNotification[]): void {
    this.#entries.push({ digest: bytesToHex(digest), epoch, notifications });
  }

  /** Mirrors DeliveredPayloadLedger.invalidatedByRewind exactly — same signature shape. */
  invalidatedByRewind(
    forkEpoch: number,
    canonicalDigests: ReadonlySet<string>,
  ): StateNotification[] {
    const invalidated: StateNotification[] = [];
    const kept: typeof this.#entries = [];
    for (const entry of this.#entries) {
      if (entry.epoch > forkEpoch && !canonicalDigests.has(entry.digest)) {
        invalidated.push(...entry.notifications);
      } else {
        kept.push(entry);
      }
    }
    this.#entries = kept;
    return invalidated;
  }

  /** Mirrors DeliveredPayloadLedger.pruneBelow exactly. */
  pruneBelow(epoch: number): void {
    this.#entries = this.#entries.filter((e) => e.epoch >= epoch);
  }
}
```
Key difference from the template: keyed by `commitDigest` (hex) rather than `stateTag`/confirmation-tag, per D-10/D-11
— `commitDigest()` already exists in `src/core/convergence.ts` (reused, not reinvented, per "Don't Hand-Roll" table).

---

### `src/client/group/marmot-group.ts` (load-path realize call, marker storage)

**Analog:** itself — `fromClientState` (lines 465-480) for the load-path insertion point, `removed` event handling
(lines 679-683) and `#rejectQueuedOutbound` (line 627) for the existing partial CONV-02 machinery to extend, not
replace.

```typescript
// Existing removed-event handling to extend (lines 674-683):
if (result.kind === "removed") {
  this.log("removed from group by inbound commit");
  // NEW: persist removed-inactive marker here too (idempotent with load-time check)
  this.#rejectQueuedOutbound("Removed from group; outbound cancelled.");
  this.emit("removed", this);
}

// Existing load path to extend (lines 465-480):
static async fromClientState<...>(state: ClientState, options: ...): Promise<MarmotGroup<...>> {
  const cryptoProvider = options.cryptoProvider ?? defaultCryptoProvider;
  const cipherSuite = await cryptoProvider.getCiphersuiteImpl(state.groupContext.cipherSuite);
  const group = new MarmotGroup(state, { ...options, ciphersuite: cipherSuite });
  // NEW (D-12, state-derived realization on load): if state.groupActiveState.kind
  // === "removedFromGroup" and the persisted marker is unset, realize here —
  // emit selfRemoved, set marker. Mirrors the ingest-time detection at
  // ingest.ts lines 626-633 but runs on load instead of on a fresh commit.
  return group;
}
```

**Store pattern to mirror for the new marker store** (constructor option shape, line ~138, `rewindStore` — a sibling
`GenericKeyValueStore`, not a field grafted onto `ClientState`):
```typescript
// src/client/group/marmot-group.ts (existing option, ~line 138)
rewindStore?: GenericKeyValueStore<Uint8Array>;
// NEW, same shape (per research's D-12 recommendation):
// removedMarkerStore?: GenericKeyValueStore<boolean>;
```

---

### `src/client/groups-manager.ts` (`#connectGroup` drain — folded todo)

**Analog:** itself, `#connectGroup`'s drain, ~L495-540.

**Current (to be removed):** an unbounded `Set<NostrEvent>` object-identity dedup of rejected events.
**Target pattern (per D-* folded todo + `03-CONTEXT.md` "Folded Todos"):**
```typescript
// Replace rejectedEvents Set<NostrEvent> tracking with filtering solely on:
if (seen.has(event.id)) return; // existing `seen` id-set for ACCEPTED/processed events only
// Do NOT add rejected events' ids to `seen` — a same-id genuine event must still
// be processed later (WR-01 censorship-bug guard, explicitly called out).
```
Test analog: `src/__tests__/groups-manager.test.ts` — loosen `toHaveLength(1)` assertions to `.length >= 1` with all
`reason`s asserted, for the two named tests ("rejects an inbound 445 event with an invalid signature", "rejects a
properly-signed 445 event carrying a duplicate h tag").

---

### Test files

**`src/core/components/__tests__/integrity.test.ts` (new)**

**Analog:** any existing colocated `src/core/components/__tests__/*.test.ts` (e.g. an admin-policy or dictionary
test, structure: plain Vitest `describe`/`it`, construct `GroupContextExtension[]` fixtures by hand, assert on the
typed return value, no I/O, no mocks needed since this is a pure function). Follow CLAUDE.md's "Tests" convention:
colocated under `__tests__`, named `<module>.test.ts`.

**`src/engine/__tests__/<convergence-parity>.test.ts` (new, D-16)**

**Analog:** existing native engine tests under `src/engine/__tests__/` that construct two `MarmotGroupEngine`
instances from shared pre-fork state and feed them commits (the existing fork-recovery/convergence test suite is the
direct structural sibling — same `MockNetwork`/in-memory-store harness from `src/__tests__/helpers`, per CLAUDE.md's
"shared test doubles live in `src/__tests__/helpers`; prefer those over inline mocks"). Two `it()` blocks per D-16:
own-commit-not-rolled-back, and dual-ordering (same commits, opposite array order, same resulting
`confirmationTag`).

## Shared Patterns

### Discriminated union + exhaustive switch (`kind` discriminant)
**Source:** `src/engine/ingest-disposition.ts` (full file), `src/engine/types.ts` `IngestResult<TEnvelope>` union
(lines 207-215)
**Apply to:** every new/widened `IngestResult` variant, `StateNotification` variants, `RejectedIngestResult.reason`.
Never invent a new top-level `IngestResult` kind for a rejection/skip reason — extend the `reason` field instead
(explicitly rejected alternative per D-03/D-13 and the research's "Anti-Patterns" section).

### Throw vs. typed-result split
**Source:** `src/core/components/dictionary.ts` `buildAppDataDictionary` (`UsageError` throw, lines 99-111) vs.
`src/engine/ingest.ts` commit branch (`yield { kind: "rejected", ... }`, lines 607-616)
**Apply to:** `src/core/components/integrity.ts` (module itself never throws — returns `undefined | violation`);
`src/engine/group-engine.ts` `send()` (throws `UsageError`/`AdminDepletionError` on violation, D-02/D-07/D-14);
`src/engine/ingest.ts` and `src/engine/fork-recovery.ts` (typed `rejected` result / dropped candidate edge, D-03/D-04).

### Bounded ledger keyed by branch identity, pruned to retained horizon
**Source:** `src/engine/delivered-payloads.ts` (`DeliveredPayloadLedger`, full file)
**Apply to:** `src/engine/state-notifications.ts` (`StateNotificationLedger`) — same three-method shape
(`record`/`invalidatedByRewind`/`pruneBelow`), same "entries pruned below retained anchor stay bounded" invariant.

### Pure core / stateful engine split
**Source:** CLAUDE.md "Established Patterns" + `src/core/components/dictionary.ts` (zero I/O) vs.
`src/engine/group-engine.ts` (owns `ClientState`, calls `processMessage`)
**Apply to:** all five requirements — every validator (`integrity.ts`) is `src/core`; every seam adapter (ingest.ts,
fork-recovery.ts, group-engine.ts) is `src/engine`. `src/client` only owns the marker's storage location and event
re-emission, never validation logic.

### `.js` import extensions, named exports, `Uint8Array` binary data, `#` private fields
**Source:** every file read above — universal, no exceptions found.
**Apply to:** all new/modified files in this phase.

## No Analog Found

None — every file in the phase's canonical-refs list has at least a role-match analog in the current codebase; this
phase is a pure port/extension of existing structural patterns (delivered-payload ledger, admin callback wrapping,
named-outcome map, exhaustive disposition switch), not greenfield architecture.

## Metadata

**Analog search scope:** `src/core/components/`, `src/core/` (inbound.ts, group-members.ts, client-state.ts,
convergence.ts), `src/engine/` (types.ts, ingest.ts, ingest-disposition.ts, admin-policy.ts, group-engine.ts,
fork-recovery.ts, delivered-payloads.ts), `src/client/group/` (marmot-group.ts, proposals/remove-member.ts),
`src/client/groups-manager.ts`
**Files scanned:** 14 read in full or targeted sections (~3,500 lines total)
**Pattern extraction date:** 2026-08-04
