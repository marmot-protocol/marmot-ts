---
phase: 04-feature-parity-conformance-vectors
plan: 04
subsystem: client-ingest-persistence
tags: [nostr, deduplication, convergence, persistence, restart]
requires:
  - phase: 04-02
    provides: confirmation-stamped durable convergence evidence
provides:
  - durable terminal Nostr-wrapper replay suppression
  - durable exactly-once withdrawal and explicit revalidation verdicts
  - public durable/ephemeral ingest persistence capability
affects: [04-05, 04-06, conformance-runner, restart-recovery]
tech-stack:
  added: []
  patterns: [group-namespaced versioned ledgers, stable commit-digest effect identity]
key-files:
  created: [src/client/group/wrapper-ledger.ts]
  modified: [src/client/marmot-client.ts, src/client/groups-manager.ts, src/client/group-factory.ts, src/client/group-registry.ts, src/client/group/marmot-group.ts, src/client/session/group-session.ts, src/engine/types.ts]
key-decisions:
  - "Resolve an omitted ingestStateStore once per MarmotClient and share that explicitly ephemeral store across every constructed group."
  - "Use the producing commit digest as both revalidation identity and durable effect-ledger key."
patterns-established:
  - "Terminal wrapper evidence is written only after a non-retryable disposition."
  - "Branch withdrawal and re-adoption transition one durable verdict between withdrawn and active."
requirements-completed: [CONF-01]
coverage:
  - id: D1
    description: Durable terminal wrapper deduplication across group reconstruction
    requirement: CONF-01
    verification:
      - kind: integration
        ref: src/__tests__/integration/app-message-replay-restart.test.ts#does not re-process a terminal wrapper when the ingest ledger is reloaded
        status: pass
    human_judgment: false
  - id: D2
    description: Public supplied-store and shared ephemeral fallback construction paths
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/client/__tests__/marmot-client.test.ts#MarmotClient ingest-state persistence capability
        status: pass
    human_judgment: false
  - id: D3
    description: Exactly-once durable withdrawal and explicit revalidation
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/engine/__tests__/state-notification-withdrawal.test.ts#persists exactly-once withdrawal and revalidation verdicts
        status: pass
    human_judgment: false
duration: 14min
completed: 2026-09-05
status: complete
---

# Phase 4 Plan 4: Durable Wrapper and Effect Reconciliation Summary

**Versioned group-scoped ledgers now suppress terminal Nostr wrapper replay and expose withdrawal/re-adoption exactly once across restart.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-09-05T15:14:07Z
- **Completed:** 2026-09-05T15:27:24Z
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments

- Threaded one resolved `ingestStateStore` through create, import, join, and load construction paths, with a stable durable/ephemeral capability declaration.
- Persisted verified outer event identities only after terminal outcomes; deferred and decrypt-retry input remains redeliverable.
- Added durable commit-digest verdicts and public `stateRevalidated` results so withdrawal and re-adoption each cross the observation boundary once.

## Task Commits

1. **Task 1: Persist outer-wrapper identity only with terminal disposition** — `d8460dc`, `4a4e2d8`, `df4b67c`, `9253fe7`
2. **Task 2: Reconcile once-only withdrawal and explicit re-adoption** — `684c7ea`, `101537f`
3. **Formatting verification** — `7cced09`

## Files Created/Modified

- `src/client/group/wrapper-ledger.ts` - Versioned terminal-wrapper and convergence-effect ledgers.
- `src/client/marmot-client.ts` - Public ingest store option and persistence capability.
- `src/client/groups-manager.ts`, `src/client/group-factory.ts`, `src/client/group-registry.ts` - Complete construction-path propagation.
- `src/client/group/marmot-group.ts`, `src/client/session/group-session.ts` - Group-scoped ledger ownership and result reconciliation.
- `src/engine/types.ts`, `src/engine/ingest-disposition.ts` - Public revalidation result and disposition.
- `src/engine/group-engine.ts` - Exhaustive handling of the added result variant.
- Focused client, engine, and restart tests prove the durable contracts.

## Decisions Made

- Omission creates one client-owned store, not one store per group, and reports `ephemeral` with reason `ingest_state_store_omitted`.
- Revalidation is restricted to effects with a prior durable branch-selection withdrawal; terminal invalidations cannot be revived.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added exhaustive engine cases for the new public result variant**
- **Found during:** Task 2 compile verification
- **Issue:** Strict TypeScript exhaustiveness checks in `group-engine.ts` failed after adding `stateRevalidated`.
- **Fix:** Classified revalidation as convergence-relevant and added non-stale audit/epoch cases.
- **Files modified:** `src/engine/group-engine.ts`, `src/engine/ingest-disposition.ts`
- **Verification:** `CI=true npx --yes pnpm@10.18.3 compile`
- **Committed in:** `101537f`

**Total deviations:** 1 auto-fixed (1 blocking issue). **Impact:** Required for correctness of the public discriminated union; no architectural scope expansion.

## Issues Encountered

- Targeted Prettier found pre-existing whole-file formatting drift in `src/client/group/marmot-group.ts`; unrelated formatting was reverted and left unchanged.

## User Setup Required

None - callers wanting restart-safe behavior supply their existing durable `GenericKeyValueStore<Uint8Array>` as `ingestStateStore`.

## Next Phase Readiness

- Durable wrapper/effect identities are ready for the manifest-driven conformance runner.
- Focused restart suites and strict library compile pass.

## Self-Check: PASSED

- Created ledger file exists.
- All seven plan commits exist in git history.
- Both planned focused Vitest commands and strict compile passed.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
