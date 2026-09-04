# Phase 4: Feature Parity & Conformance Vectors - Context

**Gathered:** 2026-09-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Bring marmot-ts into byte-for-byte and behavioral parity with the current Marmot specification and MDK reference for SafeAAD advertisement, portable conformance scenarios, own-commit convergence metadata, missing-parent deferral, restart/publish-failure recovery, bounded convergence scheduling, durable wrapper deduplication, and withdrawal/re-adoption outcomes. Terminal group disbanding remains Phase 04.1; the full cross-runtime release gate remains Phase 5.

</domain>

<decisions>
## Implementation Decisions

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

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets

- `src/engine/fork-recovery.ts`, `tree-convergence.ts`, `retained-store.ts`, and `ingestion-pool.ts` already provide the candidate, rewind, persistence, and deferred-input seams.
- `src/engine/convergence-parity.test.ts`, `ingest-deferred.test.ts`, and integration restart tests provide real-MLS test builders that should be extended instead of mocking cryptographic behavior.
- `src/core/components/nostr-routing.ts` and its codec tests are the direct target for the byte fixtures.
- `src/core/account-identity-proof.ts` and the existing Rust compatibility tests provide the proof-v2 fixture seam.
- MDK's `cgka-conformance-simulator`, canonical vectors, and offline-catchup family are pinned under `refs/mdk` at `a508e0be` by repository commit `6d7b7e3`.

### Established Patterns

- Protocol and state primitives remain pure under `src/core`; transport-agnostic state-machine behavior lives under `src/engine`; Nostr I/O remains under `src/client`.
- Expected multi-outcome flows use `kind`-discriminated unions; protocol bytes use `Uint8Array`; persisted formats require explicit compatibility handling.
- Tests use Vitest, real ts-mls crypto, in-memory stores, `MockNetwork`, and fully drained async generators. Relative source imports require emitted `.js` extensions.
- Publish-before-apply and the lifecycle FSM remain the safety boundary for local commits and outbound release.

### Integration Points

- Confirm-time stamp capture connects staged publication and confirmation in `MarmotGroupEngine`/`GroupRuntime` to retained history and persisted wire records.
- Missing-parent retention and expiry connect ingest categorization, the ingestion pool, candidate construction, and tree-fed convergence.
- Pass deadlines, admission gating, and anti-starvation connect the engine lifecycle, convergence scheduler, queued local intents, and injected timing.
- Durable wrapper deduplication connects the Nostr/client ingest boundary to restart-safe storage without coupling Nostr types into the engine.
- Conformance snapshots bridge core/engine state to the reusable scenario runner without defining a new interoperable wire format.

</code_context>

<specifics>
## Specific Ideas

- Preserve MDK scenario names as stable test identifiers so failures map directly back to upstream fixtures.
- Treat `restart-delivery-faults.v1.json`, publish-failure vectors, and offline-catchup-pressure as first-class regression families because prior convergence defects escaped without persist-reload coverage.
- Model re-adoption explicitly, matching MDK's `GroupStateRevalidated` behavior rather than making it an invisible local bookkeeping transition.

</specifics>

<deferred>
## Deferred Ideas

- Terminal `marmot.group.lifecycle.v1` disbanding is Phase 04.1.
- Full Node/Deno/Bun matrix execution and release-quality reporting are Phase 5.
- Multi-device, push notifications, QUIC data plane, application/tooling crates, and large MDK storage-performance changes remain outside this milestone's library scope.

</deferred>
