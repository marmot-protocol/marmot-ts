# Phase 4: Feature Parity & Conformance Vectors - Research

**Researched:** 2026-09-04
**Domain:** Marmot/MLS wire conformance, deterministic scenario execution, convergence persistence and restart recovery
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

### Reference-Parity Boundary

- Include every portable MDK manifest vector plus the new offline-catchup-pressure family; unsupported scenarios must be represented explicitly rather than silently omitted.
- Judge equality using the canonical snapshot projection from `refs/marmot/foundation/conformance.md`, including per-input dispositions and application-visible outputs.
- Include durable transport-wrapper deduplication and withdrawal/re-adoption semantics from MDK `a508e0be`, because both directly affect restart and convergence parity.
- The current Marmot specification governs protocol semantics; current MDK governs wire and reference behavior where the specification is silent. Record every intentional divergence.

### Conformance Harness Design

- Build a reusable TypeScript scenario runner that reads MDK's canonical JSON directly and declares capabilities for unsupported operations.
- Consume immutable fixtures from `refs/mdk` through test-only loaders. Keep small regression fixtures in the TypeScript repository only when runtime portability requires them.
- Inject a deterministic monotonic clock and explicit scheduler-driving hooks so pass deadlines, restarts, and queue ordering are reproducible.
- Run the portable smoke set in normal Vitest. Put large offline-pressure cases in a deterministic extended suite exercised by Phase 5's runtime matrix.

### Convergence Persistence and Recovery

- Persist a versioned own-commit convergence stamp beside confirmed wire bytes containing the authenticated committer, authorization-aware ordering priority, and sorted consumed proposal references.
- Decode older persisted records compatibly, but treat an unstamped own commit as deferred or unavailable for branch candidacy when safe reconstruction cannot be proven.
- Retain missing-parent commits while their authenticated source epoch is inside the rewind horizon; expire them only using the specification's epoch-distance rule.
- Persist stable wrapper IDs for every terminal disposition, including malformed or unsupported MLS messages, so restart replay cannot repeat processing or notifications.

### Pass Scheduling and Observable Outcomes

- Capture one monotonic deadline when a convergence pass opens; later input never extends it. Inject the clock for deterministic tests.
- While lifecycle is `PendingPublish` or `Merging`, retain inbound input without admitting it into a new convergence pass.
- After a bounded pass settles in `Stable`, give one already-queued, admin-authorized local intent one preparation attempt before opening another pass solely for inbound work.
- Emit each branch-selection withdrawal once, then emit an explicit revalidation if the same canonical state is re-adopted. Persist sufficient evidence for both behaviors to survive restart.

### the agent's Discretion

- Exact names and serialized shapes for the TypeScript convergence stamp, wrapper-ID ledger, clock abstraction, capability declarations, and revalidation result, provided they follow existing versioning and discriminated-union patterns.
- Plan and wave decomposition, including which portable vectors form the default smoke set and which offline-pressure scales belong only in the extended suite.
- Compatibility migration mechanics for existing stores, provided old data remains readable and unsafe own-commit reconstruction is not reintroduced.

### Deferred Ideas (OUT OF SCOPE)

- Terminal `marmot.group.lifecycle.v1` disbanding is Phase 04.1.
- Full Node/Deno/Bun matrix execution and release-quality reporting are Phase 5.
- Multi-device, push notifications, QUIC data plane, application/tooling crates, and large MDK storage-performance changes remain outside this milestone's library scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WIRE-04 | SafeAAD component (`0x0002`) is defined, `0x0001` is advertised in the leaf `app_components` list, and the empty SafeAAD entry is emitted so LeafNode/KeyPackage bytes match the reference. | The wire delta maps directly to `src/core/components/ids.ts`, `dictionary.ts`, the LeafNode extension builder, and byte-exact KeyPackage tests. |
| CONF-01 | MDK byte fixtures and portable convergence/admin/fork scenarios run as cross-implementation tests, including proof-v2 Rust-signed to TS-verified coverage. | The harness architecture, manifest capability handling, snapshot oracle, fixture loading, deterministic scheduler, and seam-to-vector map below make this plan-ready. |
</phase_requirements>

## Summary

Phase 4 should be planned as one conformance spine with four cooperating layers: wire codecs, durable engine evidence, deterministic scheduling, and a reusable MDK scenario adapter. SafeAAD is a small byte-level change, but the scenario suite will expose structural restart/convergence gaps unless own-commit stamps, missing-parent retention, terminal wrapper deduplication, and withdrawal/re-adoption evidence land before the broad vector wave. [VERIFIED: `src/core/components/ids.ts`, `src/core/components/dictionary.ts`, `refs/marmot/foundation/conformance.md`, `refs/mdk/crates/cgka-conformance-simulator/vectors/manifest.v1.json`]

The refreshed MDK range through `93ecfbca` strengthens the required behavioral boundary. A client must preserve a bounded pass continuation, retry input refused for temporary capacity, retain intermediate authenticated anchors needed by later descendants, deduplicate every terminally handled transport wrapper across restart, and make branch withdrawal/re-adoption visible exactly once. The Rust implementation's exact byte limits, SQLite tables, accounting maps, telemetry, and campaign sizes are implementation choices, not canonical-state equality. [VERIFIED: MDK commits `a653714f`, `44e43eb7`, `7851a840`, `6aba6ef9`, `6bf697f9`, `93ecfbca`; `refs/marmot/foundation/conformance.md`]

**Primary recommendation:** implement and test durable evidence plus deterministic scheduling first, then plug those seams into a manifest-driven scenario runner; do not translate the Rust simulator or storage layer wholesale. [VERIFIED: current TS architecture and MDK capability boundary]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| SafeAAD LeafNode/KeyPackage bytes | Core protocol/crypto | Client KeyPackage API | The dictionary and supported-component declaration are wire primitives; client creation/publishing consumes them. [VERIFIED: codebase grep] |
| Canonical conformance snapshot | Engine test adapter | Core protocol/crypto | Engine owns lifecycle, convergence, dispositions and outputs; core/ts-mls provides GroupContext, exporter and leaves. [VERIFIED: `refs/marmot/foundation/conformance.md`] |
| Own-commit convergence stamp | Engine | Client runtime | Engine derives/stores candidate evidence; runtime supplies the publish-confirm boundary. [VERIFIED: `src/engine/group-engine.ts`, `src/client/runtime/group-runtime.ts`] |
| Missing-parent retention and intermediate anchors | Engine | Persistence store | Candidate validation and horizon policy are transport-agnostic; stores preserve required states across restart. [VERIFIED: `src/engine/ingestion-pool.ts`, `history-tree.ts`, `retained-store.ts`] |
| Durable wrapper dedup | Client/Nostr ingress | Persistence store | Wrapper identity exists before peel and must remain outside the transport-agnostic engine's Nostr types. [VERIFIED: `src/client/group/nostr-peeler.ts`, MDK `44e43eb7`] |
| Bounded pass scheduling and local-intent fairness | Client group orchestrator | Engine lifecycle | `MarmotGroup` owns queued intents/timers; engine owns convergence/lifecycle transitions and explicit drive hooks. [VERIFIED: `src/client/group/marmot-group.ts`, `src/engine/group-engine.ts`] |
| Withdrawal and re-adoption results | Engine | Client event projection | Branch decisions originate in engine; application-visible event delivery/reconciliation is client responsibility. [VERIFIED: MDK `a653714f`, `src/engine/state-notifications.ts`] |
| MDK JSON scenario execution | Test infrastructure | Engine/client adapters | JSON actions are test orchestration, while subjects exercise real client/engine APIs and real MLS crypto. [VERIFIED: MDK simulator vectors and current tests] |

## Project Constraints (from AGENTS.md)

- Use pnpm 10; use `pnpm vitest run` for one-shot tests, `pnpm compile` for focused strict typechecking, and `pnpm build` for the library build. [VERIFIED: `AGENTS.md`]
- Preserve ESM NodeNext imports with emitted `.js` suffixes, named exports, `Uint8Array` protocol bytes, and no `Buffer` dependency. [VERIFIED: `AGENTS.md`]
- Keep protocol/crypto/state logic in `src/core`, transport-agnostic state-machine work in `src/engine`, and Nostr/storage/lifecycle integration in `src/client`; optional stores belong in `src/extra`. [VERIFIED: `AGENTS.md`]
- Use real ts-mls crypto, in-memory stores, shared network doubles, and fully drain async generators in tests. [VERIFIED: `AGENTS.md`]
- Treat current `refs/marmot` and `refs/mdk` as the wire/behavior source of truth; inspect MDK before custom convergence, recovery, or encoding solutions, and record divergences. [VERIFIED: `AGENTS.md`]
- Do not use deprecated `MIP-NN` citations in new comments; cite topic-organized `refs/marmot/...` paths. [VERIFIED: `AGENTS.md`]
- Full cross-runtime matrix is Phase 5, but code introduced now must remain Node 20+, Deno 2, and Bun 1.1+ compatible. [VERIFIED: `AGENTS.md`, `04-CONTEXT.md`]

## Standard Stack

### Core

| Library/asset | Version | Purpose | Why Standard |
|---------------|---------|---------|--------------|
| TypeScript | workspace `6.0.3` | Library and test implementation | Existing strict NodeNext stack. [VERIFIED: `package.json`] |
| Vitest | workspace `3.2.6` | Portable smoke and deterministic extended suites | Existing colocated test runner and CI contract. [VERIFIED: `package.json`, `vitest.config.ts`] |
| ts-mls | workspace `2.0.0-rc.14` | Real MLS state, serialization, exporter, proposals and commits | Existing MLS source; synthetic crypto would not prove parity. [VERIFIED: `package.json`, workspace] |
| `@noble/hashes` | workspace `2.2.0` | SHA-256 and hex conversion for canonical projections/IDs | Already used in protocol and engine code and runtime-portable. [VERIFIED: `package.json`, codebase grep] |
| MDK fixture corpus | submodule `93ecfbca` | Canonical JSON scenarios and byte fixtures | Locked authoritative fixture source for CONF-01. [VERIFIED: `refs/mdk` HEAD] |
| Marmot specification | pinned submodule | Canonical semantics and snapshot equality | Governs where MDK implementation details are not protocol requirements. [VERIFIED: `refs/marmot/foundation/conformance.md`] |

### Supporting

| Asset | Purpose | When to Use |
|-------|---------|-------------|
| Existing `GenericKeyValueStore` and in-memory implementation | Persist versioned metadata and simulate restart | Reuse for own-commit records, wrapper ledger, and harness restart. [VERIFIED: codebase grep] |
| Existing `MockNetwork` and real-MLS builders | Deterministic delivery faults and convergence topologies | Extend rather than create inline fake crypto/network behavior. [VERIFIED: `src/__tests__/helpers`] |
| Applesauce event types/helpers | Nostr wrapper parsing and stable event ID semantics | Keep at client ingress; do not introduce EventStore/RxJS into engine conformance logic. [VERIFIED: project applesauce skill and current package usage] |

No external package installation is needed. [VERIFIED: existing stack covers JSON loading, hashing, clocks, stores, and tests]

## Package Legitimacy Audit

Not applicable: this phase should add no external packages. [VERIFIED: Standard Stack]

## Architecture Patterns

### System Architecture Diagram

```text
MDK manifest + JSON fixtures
          |
          v
test-only loader -> capability declaration -> deterministic scenario runner
                                             | actions / clock / delivery faults
                                             v
Nostr/client adapter -> durable wrapper ledger -> MarmotGroup queue/runtime
                                             |               |
                                             v               v
                                      MarmotGroupEngine <- confirm-time stamp
                                      | ingest/pass/recover
                         +------------+-------------+
                         |                          |
                 retained/history stores      disposition/effect ledger
                         |                          |
                         +------------+-------------+
                                      v
                         canonical snapshot projection
                                      |
                        expected snapshot/effect comparison
```

This flow keeps fixture orchestration test-only, Nostr identity at the client boundary, and branch semantics inside the transport-agnostic engine. [VERIFIED: current architecture and locked harness decision]

### Recommended Project Structure

```text
src/
├── core/components/                 # SafeAAD id/entry and wire codecs
├── engine/                          # stamps, candidate retention, pass state, effects
├── client/group/                    # queue fairness and Nostr wrapper ledger wiring
└── __tests__/
    ├── conformance/                 # runner, subject adapter, snapshot, capabilities
    ├── fixtures/                    # only runtime-portability copies
    └── integration/                 # restart/publish-failure real-MLS coverage
```

Exact new filenames are discretionary, but the conformance runner should be test-only and reusable across scenario files. [VERIFIED: `04-CONTEXT.md`, existing test layout]

### Pattern 1: Versioned Own-Commit Record Captured at Confirmation

**What:** keep the staged commit's authenticated committer, already-computed authorization-aware priority, sorted consumed proposal refs, and exact confirmed wire bytes together in a versioned persisted record. Capture before staged data is cleared. [VERIFIED: `refs/mdk/crates/traits/src/message.rs`, `04-REFERENCE-FINDINGS.md`]

**When to use:** only for self-authored commits that MLS cannot safely re-process after restart. [VERIFIED: MDK own-commit documentation]

```typescript
type StoredOwnCommitV1 = {
  version: 1;
  wire: Uint8Array;
  stamp: {
    committer: string;
    priority: CommitOrderingPriority;
    consumedProposalRefs: string[]; // sorted before persistence
  };
};

function decodeStoredOwnCommit(bytes: Uint8Array): StoredOwnCommitV1 | LegacyRecord {
  // Explicit version dispatch; legacy data remains readable.
}
```

The planner should locate stamp derivation beside staged commit creation/authorization, pass it through `PendingState`, and persist it in `confirmPublished` before pending state is released. [VERIFIED: `src/engine/group-engine.ts`, `src/client/session/group-session.ts`, `src/client/runtime/group-runtime.ts`]

### Pattern 2: One Durable Identity per Transport Wrapper and Terminal Outcome

**What:** classify a stable Nostr wrapper/event ID before peel; persist it atomically with every terminal outcome, including malformed and unsupported MLS content. Do not consume the durable ID on temporary transport deferral or resource refusal. [VERIFIED: MDK `44e43eb7`, `6bf697f9`, `93ecfbca`; `refs/marmot/foundation/errors.md`]

**When to use:** all kind-445 ingress and restart replay paths. Content-derived MLS dedup remains a separate inner-message identity and cannot substitute for wrapper dedup because malformed wrappers have no MLS message. [VERIFIED: `src/engine/message-dedup.ts`, MDK `44e43eb7`]

### Pattern 3: Explicit Pass Object with Immutable Deadline and Continuation

**What:** represent a pass as state with a frozen input set/base epoch, an opening monotonic timestamp/deadline, and an explicit continuation/drain method. New input is retained separately and cannot reset the deadline. [VERIFIED: `refs/marmot/protocol-core/convergence.md`, MDK `6aba6ef9`]

**When to use:** convergence collection, bounded continuation after a deadline, and harness-driven deterministic ticks.

```typescript
type MonotonicClock = { nowMs(): number };
type ConvergencePass = {
  openedAtMs: number;
  deadlineMs: number;
  baseEpoch: number;
  admittedIds: readonly string[];
};

const pass = {
  openedAtMs: clock.nowMs(),
  deadlineMs: clock.nowMs() + policy.maxConvergencePassMs,
  baseEpoch,
  admittedIds: Object.freeze([...eligibleIds]),
};
```

Use one sampled `now` value in real code to avoid a test-visible skew between `openedAtMs` and `deadlineMs`. [VERIFIED: deterministic-clock requirement]

### Pattern 4: State-Derived Withdrawal/Revalidation Reconciliation

**What:** persist branch disposition/effect identity, emit withdrawal only on the transition into branch-selection deferral, and emit `revalidated` only when a previously parked commit becomes accepted again. Reconcile durable disposition against application-visible effect state on load so a crash between state persistence and delivery is repairable. [VERIFIED: MDK `a653714f`, `refs/marmot/foundation/conformance.md`]

**When to use:** every convergence apply/restart boundary; result types should remain `kind`-discriminated unions. [VERIFIED: project conventions]

### Pattern 5: Capability-Declared Scenario Adapter

**What:** parse the manifest first, preserve upstream scenario IDs, expose a capability map, and return explicit unsupported results for operations the TypeScript library intentionally does not implement. Drive scenarios through public/near-public subject seams, not through fixture-specific branches. [VERIFIED: MDK manifest and locked context]

**When to use:** every portable manifest entry and generated offline pressure case. Unsupported is reportable data, never a skipped test discovered only by absence. [VERIFIED: `04-CONTEXT.md`]

### Anti-Patterns to Avoid

- **Reconstructing own-commit proposal refs from a parent state:** the parent snapshot can no longer contain the consumed proposals; record them at confirmation. [VERIFIED: `04-REFERENCE-FINDINGS.md`]
- **Marking temporarily refused input as seen:** capacity refusal must permit later redelivery; only terminal dispositions consume the durable wrapper ID. [VERIFIED: MDK `6bf697f9`, `44e43eb7`]
- **Resetting a timer when input arrives:** this violates the fixed pass boundary and enables starvation. [VERIFIED: convergence spec]
- **Opening a pass during `PendingPublish` or `Merging`:** retain input, then admit it after the lifecycle safety boundary clears. [VERIFIED: convergence spec]
- **Copying MDK SQLite/storage layout:** canonical equality excludes storage encoding, row IDs and queue layout. [VERIFIED: `refs/marmot/foundation/conformance.md`]
- **Only comparing epoch/member count:** canonical comparison includes cryptographic context/exporter commitments, exact component bytes, gates, unresolved publications, dispositions and effects. [VERIFIED: conformance spec]
- **Mocking MLS for cross-implementation vectors:** it can validate orchestration but cannot establish wire or state parity. [VERIFIED: phase goal and existing test conventions]

## Required Correctness vs Out-of-Scope MDK Mechanics

| Refreshed MDK behavior | Required Phase 4 observable | Do not port as parity requirement | Current TS seam |
|------------------------|-----------------------------|-----------------------------------|-----------------|
| `a653714f` withdrawal/re-adoption | Once-only withdrawal, explicit revalidation, restart repair, ordered same-batch net verdict | Rust FFI/C bindings, app SQLite timeline schema, account maintenance internals | `StateNotificationLedger`, rewind apply, `MarmotGroupEvents` |
| `d94dc134` offline family | Deterministic generated family represented in harness; eventual snapshot/effect agreement under supported bounds | Rust campaign CLI/reporting and production-scale default sizes | conformance runner + MockNetwork + real-MLS builders |
| `44e43eb7` wrapper dedup | Stable wrapper IDs persisted for all terminal outcomes; replay after restart produces no duplicate effect | MDK migration number/table schema and trait layout | Nostr ingress, group stores, inner `contentDedupId` |
| `7851a840` intermediate anchors | Keep every authenticated intermediate state needed to validate descendants within horizon | OpenMLS-specific projection object layout | `GroupHistoryTree`, `RetainedHistoryStore`, tree resolution |
| `6aba6ef9` bounded continuation | Deadline expiry preserves remaining work and resumes deterministically; no stranded pending work | Simulator client's Rust task/polling implementation | engine pass state, injected scheduler hooks |
| `6bf697f9` capacity-refused redelivery | Temporary resource refusal is nonterminal and redeliverable after capacity frees | Retained-relay data structure and exact refill algorithm | ingestion pool/admission result and harness relay |
| `93ecfbca` deferred-peel byte budgets | Harness can exercise refusal/retry; implementation never terminal-dedups refused input and counts exact encoded bytes if TS adds a cap | Exact row/group/account thresholds, metrics, audit throttling, SQLite accounting | `IngestionPoolOptions`, pre-peel client ingress, result union |

Every row above is verified from the named local MDK commit and current TypeScript code. [VERIFIED: git history and codebase inspection]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MLS serialization/exporter | Custom byte encoder or KDF | ts-mls encoders and exporter API | Canonical bytes and cryptographic context must match the MLS implementation. [VERIFIED: conformance spec/current stack] |
| SHA-256/hex | Bespoke digest/hex loops | `@noble/hashes` | Existing cross-runtime audited primitive. [VERIFIED: current dependencies] |
| Scenario expectations | TS-specific duplicate fixtures for all vectors | Read immutable MDK JSON and manifest | Prevents fixture drift and preserves upstream IDs. [VERIFIED: locked decision] |
| Convergence branch ordering | Fixture-specific winner rules | Existing `fork-recovery.ts` ordering with stamped inputs | The harness must test production semantics, not encode the expected answer twice. [VERIFIED: phase goal] |
| Fake persistence restart | Object cloning only | Existing key-value abstraction + actual serialize/load path | Restart defects occur at encoding/hydration/effect boundaries. [VERIFIED: restart criteria] |
| Nostr reactive store | New EventStore/RxJS layer | Existing network/store interfaces and applesauce event primitives | Phase is protocol library work; engine must remain transport-agnostic. [VERIFIED: architecture and applesauce skill]

**Key insight:** the reusable artifact is the subject adapter and canonical projection; production correctness remains in the existing core/engine/client seams. [VERIFIED: MDK `ConvergenceSubject` boundary]

## Common Pitfalls

### Pitfall 1: SafeAAD Is Advertised in the Wrong Dictionary

**What goes wrong:** `0x0002` is added to group state or only added to the supported-ID list, producing different LeafNode/KeyPackage bytes. [VERIFIED: WIRE-04 and current builders]

**How to avoid:** define the ID, include `0x0001` in the advertised list as required by current reference bytes, emit a separate empty `0x0002` LeafNode dictionary entry, and keep group-component integrity rejection for SafeAAD. Pin the complete encoded extension bytes. [VERIFIED: WIRE-04, MDK reference]

### Pitfall 2: Confirmation Clears Evidence Before Persistence

**What goes wrong:** `PendingState` is merged/cleared before its committer, priority and proposal refs are durably recorded. Restart then re-enters the CR-08 reconstruction path. [VERIFIED: current confirm seams and MDK stamp design]

**How to avoid:** make stamp creation part of preparation and stamp persistence part of the same ordered confirmation operation as confirmed wire persistence; add crash-boundary tests. [VERIFIED: conformance crash contract]

### Pitfall 3: Missing Parent Is Confused with Invalid Parent

**What goes wrong:** a candidate is dropped after the first retained state fails authentication/authorization, or a truncated prefix competes. [VERIFIED: convergence spec and `04-REFERENCE-FINDINGS.md`]

**How to avoid:** parent resolution is all-or-nothing and parent-relative; defer until an authenticating parent is found or epoch-distance expiry proves it beyond horizon. Keep `known-state` and tree resolution on one result vocabulary. [VERIFIED: convergence spec]

### Pitfall 4: Durable Dedup Is Inner-Message-Only

**What goes wrong:** malformed/unsupported wrappers have no `contentDedupId`, so replay repeats parsing, rejection notifications, or side effects after restart. [VERIFIED: current `message-dedup.ts`, MDK `44e43eb7`]

**How to avoid:** outer wrapper ID ledger at Nostr ingress plus existing content dedup after peel; atomic terminal disposition persistence; no durable consume on retryable refusal. [VERIFIED: MDK changes]

### Pitfall 5: Pass Deadline and Quiescence Window Are Collapsed

**What goes wrong:** one timer is reused for both collection bound and settled quiescence; new traffic extends a pass or queued local work starves. [VERIFIED: convergence contract and current `MarmotGroup` `now`/scheduler]

**How to avoid:** separate immutable pass deadline from settle/quiescence timing and expose deterministic drive hooks for both. After settle, attempt exactly one already-queued authorized local state intent before inbound-only work opens another pass. [VERIFIED: locked decision]

### Pitfall 6: Re-adoption Revives the Wrong Effects

**What goes wrong:** every invalidation is reversed, including terminal or non-branch-selection withdrawals, or same-batch withdrawal/revalidation is reduced by unordered set membership. [VERIFIED: MDK `a653714f`]

**How to avoid:** revalidate only branch-selection withdrawals for the same origin commit, resolve multiple verdicts in event order, and reconcile state after restart. [VERIFIED: MDK `a653714f`]

### Pitfall 7: Offline Pressure Turns into a Storage Project

**What goes wrong:** planning expands into byte-budget telemetry, SQLite migrations, and large campaigns while missing behavioral continuation/refusal tests. [VERIFIED: scope and canonical exclusions]

**How to avoid:** implement only storage necessary for correctness/durability; use small deterministic pressure in normal Vitest and tag larger scales for Phase 5. [VERIFIED: locked context]

## Code Examples

### Manifest-driven explicit capability handling

```typescript
type Capability =
  | "create_group"
  | "invite_member"
  | "restart"
  | "publish_failure"
  | "delivery_faults"
  | "offline_catchup";

type ScenarioSupport =
  | { kind: "supported" }
  | { kind: "unsupported"; capability: Capability; reason: string };

for (const entry of manifest.entries.filter((item) => item.status === "portable")) {
  test(entry.id, async () => {
    const scenario = await loadMdkScenario(entry.artifact);
    const support = subject.supports(scenario);
    if (support.kind === "unsupported") {
      expect(recordUnsupported(entry.id, support)).toMatchObject({ explicit: true });
      return;
    }
    expect(await runScenario(subject, scenario)).toEqual(scenario.expected);
  });
}
```

[VERIFIED: pattern derived from locked capability-declaration decision and MDK manifest]

### Epoch-distance expiry

```typescript
function isBeyondRewindHorizon(
  canonicalTipEpoch: number,
  authenticatedSourceEpoch: number,
  maxRewindCommits: number,
): boolean {
  return canonicalTipEpoch - authenticatedSourceEpoch > maxRewindCommits;
}
```

With `Infinity`, this never expires by policy; do not replace it with wall-clock or queue-age expiry. [VERIFIED: `refs/marmot/protocol-core/convergence.md`]

### Outer wrapper terminal dedup ordering

```typescript
const wrapperId = envelope.id;
if (await terminalWrapperLedger.has(wrapperId)) return { kind: "skipped", reason: "duplicate" };

const result = await peelAndIngest(envelope);
if (isTerminal(result)) {
  await persistTerminalDispositionAndWrapperId(wrapperId, result);
}
return result; // deferred/resource-refused remains redeliverable
```

[VERIFIED: MDK `44e43eb7`, `6bf697f9`, `93ecfbca`; exact transaction API is discretionary]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Reconstruct own-commit candidate evidence after restart | Persist `OwnCommitConvergenceStamp` at confirmation | Present in refreshed MDK reference | Removes the CR-08/CR-11 defect class structurally. [VERIFIED: `04-REFERENCE-FINDINGS.md`] |
| Repeated withdrawal and silent re-adoption | Once-only withdrawal plus `GroupStateRevalidated` and load reconciliation | MDK `a653714f` | Application effects track the current branch verdict across passes/restart. [VERIFIED: commit] |
| In-memory/inner-only replay dedup | Durable outer wrapper IDs for terminal outcomes | MDK `44e43eb7` | Malformed and unsupported replay is idempotent after restart. [VERIFIED: commit] |
| Final-tip-only retained projection | Intermediate convergence anchors retained | MDK `7851a840` | Offline descendants can authenticate through the full chain. [VERIFIED: commit] |
| Deadline stops work without durable continuation | Bounded pass retains/resumes continuation | MDK `6aba6ef9` | Bounded execution no longer strands pending scenario work. [VERIFIED: commit] |
| Capacity refusal behaves like delivery | Refused retained history is redelivered | MDK `6bf697f9` | Resource pressure remains retryable and does not alter protocol outcome. [VERIFIED: commit] |
| Deferred peel bounded primarily by rows | Exact encoded-byte budgets at group/account scope | MDK `93ecfbca` | Useful hardening reference, but exact limits remain out of Phase 4 parity scope. [VERIFIED: commit and canonical exclusions] |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| — | None. Claims are grounded in the pinned local specification, pinned MDK source/history, repository code, or locked user decisions. | — | — |

## Open Questions

1. **Which portable vectors should be smoke versus extended?**
   - What we know: every portable manifest entry must be represented, while large offline pressure belongs in the extended suite. [VERIFIED: locked decision]
   - Recommendation: smoke at least three-client exchange, publish-fail, invite-publish-fail, restart-delivery-faults, both convergence selection vectors, one semantic fork, and one small offline family case; classify remaining portable entries explicitly by capability/runtime cost.

2. **Where should durable wrapper IDs live when callers omit optional stores?**
   - What we know: restart parity requires durable storage, but existing group APIs allow optional rewind/removal stores. [VERIFIED: `MarmotGroupOptions`]
   - Recommendation: plan one explicit persistence capability/constructor contract and test documented degradation or rejection; do not imply restart-safe dedup when no durable store exists.

3. **Does ts-mls expose all canonical snapshot fields without a new narrow accessor?**
   - What we know: current client-state projections inspect GroupContext/leaves, but exporter commitment and exact serialized GroupContext need confirmed API mapping. [VERIFIED: `src/core/client-state.ts`, conformance spec]
   - Recommendation: make this a Wave 0 spike/test; add the smallest ts-mls accessor only if the existing public surface cannot produce the canonical projection.

4. **How should an unstamped legacy own commit surface?**
   - What we know: it must not be unsafely reconstructed and must remain readable; context permits deferred or unavailable candidacy. [VERIFIED: locked decision]
   - Recommendation: use an explicit `deferred`/`missing_history`-style result when still within horizon, and only terminalize by the standard epoch-distance rule.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | build/test | ✓ | 22.23.1 | CI Node 20/22/24 in Phase 5 |
| pnpm | build/test | ✓, wrong major | 11.18.0; CI/workspace require 10 | run through the repository's pnpm 10/Corepack contract before verification |
| Git submodules | fixture/spec loading | ✓ | Marmot `4a2bc65`; MDK `93ecfbca` | no copied full corpus |
| Vitest | smoke/extended tests | ✓ | 3.2.6 | none |
| ts-mls workspace | real crypto/conformance projection | ✓ | 2.0.0-rc.14 | none |

No dependency is missing, but the interactive pnpm major differs from CI and must be normalized before accepting lockfile/build evidence. [VERIFIED: environment probes and `AGENTS.md`]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | MLS membership-tag/signature authentication against the candidate parent; never trust transport authorship as committer identity. [VERIFIED: convergence spec] |
| V3 Session Management | no | No web session surface. [VERIFIED: UI/spec scope] |
| V4 Access Control | yes | Authorization-aware commit priority and parent-relative admin policy checks. [VERIFIED: convergence spec/current admin policy] |
| V5 Input Validation | yes | Strict JSON schema/capability validation, TLS codec validation, duplicate component/relay rejection, stable result taxonomy. [VERIFIED: MDK fixture schema/current codecs] |
| V6 Cryptography | yes | ts-mls and noble primitives only; no hand-rolled MLS, exporter or hashing. [VERIFIED: stack] |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged wrapper poisons dedup before authentication/terminal classification | Denial of Service / Spoofing | Verify Nostr event at client boundary; atomically persist wrapper ID only with terminal disposition. [VERIFIED: existing trust-boundary design, MDK dedup change] |
| Missing-parent flood grows retained queues | Denial of Service | Epoch horizon plus optional resource refusal that stays retryable; measure exact persisted bytes if adding caps. [VERIFIED: convergence spec, MDK `93ecfbca`] |
| Arrival order changes branch selection | Tampering | Freeze authenticated input batch and use deterministic ordering keys/stamps. [VERIFIED: convergence spec] |
| Restart duplicates or loses application effects | Repudiation / Integrity | Stable effect identities, persisted dispositions, load-time state-derived reconciliation. [VERIFIED: conformance crash contract, MDK `a653714f`] |
| Malicious fixture path escapes submodule | Tampering | Resolve only manifest-declared relative artifacts beneath the pinned vectors root; reject traversal/absolute paths. [VERIFIED: untrusted-input boundary applied to JSON fixtures] |

## Sources

### Primary (HIGH confidence)

- `refs/marmot/foundation/conformance.md` — canonical projection, crash/restart equivalence, exclusions.
- `refs/marmot/protocol-core/convergence.md` — pass bounds, admission, horizon, candidate validation, fairness.
- `refs/marmot/foundation/errors.md` and `wire-envelopes.md` — retryable/resource/terminal taxonomy and identities.
- `refs/mdk/crates/cgka-conformance-simulator/vectors/manifest.v1.json` plus scenario/byte fixtures — portable corpus.
- MDK commits `a653714f`, `d94dc134`, `44e43eb7`, `7851a840`, `6aba6ef9`, `6bf697f9`, `93ecfbca` — refreshed reference behaviors.
- Current `src/core`, `src/engine`, `src/client`, and tests — concrete TypeScript seams.

### Secondary (MEDIUM confidence)

- `.planning/phases/04-feature-parity-conformance-vectors/04-REFERENCE-FINDINGS.md` — earlier pinned-range analysis, rechecked against current MDK.
- Project applesauce skill — Nostr package architecture constraints relevant to keeping wrapper handling at client ingress.

### Tertiary (LOW confidence)

- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — existing packages and versions were read from the workspace.
- Architecture: HIGH — derived from current code plus locked layer boundaries.
- Protocol/wire behavior: HIGH — pinned local specification and MDK sources/history.
- Pitfalls: HIGH — each maps to a documented prior defect or refreshed reference fix.

**Research date:** 2026-09-04
**Valid until:** 2026-09-11 (reference submodules move quickly; recheck both before planning/execution)
