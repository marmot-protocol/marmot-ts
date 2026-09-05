---
phase: 04-feature-parity-conformance-vectors
plan: 03
subsystem: convergence-recovery
tags: [mls, convergence, deferred-input, rollback-horizon, fork-recovery]
requires:
  - phase: 04-feature-parity-conformance-vectors
    provides: confirmation-stamped own-commit convergence evidence
provides:
  - Authenticated source-epoch retention with strict rollback-horizon expiry
  - Retryable capacity refusal and retained-history pins for deferred descendants
  - Shared parent-resolution outcomes across live and persisted-tree recovery
affects: [convergence, ingestion-pool, retained-history, fork-recovery]
tech-stack:
  added: []
  patterns: [authenticated epoch retention, discriminated parent resolution]
key-files:
  created: []
  modified:
    - src/engine/ingestion-pool.ts
    - src/engine/ingest.ts
    - src/engine/types.ts
    - src/engine/group-engine.ts
    - src/engine/fork-recovery.ts
    - src/engine/__tests__/ingest-deferred.test.ts
    - src/engine/__tests__/ingestion-pool.test.ts
    - src/engine/__tests__/convergence-parity.test.ts
    - src/client/marmot-client.ts
key-decisions:
  - "Retain peeled deferred commits by their MLS-authenticated source epoch; opaque wrappers remain capacity-bounded without inventing an epoch."
  - "Capacity pressure refuses new work without evicting accepted entries or creating a terminal dedup disposition."
  - "Resolve parent authentication, authorization, and component legality through one discriminated result contract in both recovery seams."
patterns-established:
  - "Temporary parent-resolution refusal suppresses the entire candidate chain rather than scoring its valid prefix."
requirements-completed: [CONF-01]
coverage:
  - id: D1
    description: Deferred commits remain retryable through the exact rewind boundary, including an infinite horizon and capacity refusal.
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/engine/__tests__/ingest-deferred.test.ts
        status: pass
      - kind: integration
        ref: src/engine/__tests__/ingestion-pool.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Live and persisted-tree fork recovery share parent-relative authentication and legality outcomes without truncated candidates.
    requirement: CONF-01
    verification:
      - kind: integration
        ref: src/engine/__tests__/convergence-parity.test.ts
        status: pass
    human_judgment: false
duration: 10min
completed: 2026-09-05
status: complete
---

# Phase 04 Plan 03: Horizon-Correct Missing-Parent Recovery Summary

**Authenticated epoch retention and unified parent resolution preserve complete retryable fork candidates without arrival-time expiry or prefix truncation.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-09-05T15:02:49Z
- **Completed:** 2026-09-05T15:11:57Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Replaced arrival-time aging with the specification's strict `canonicalTipEpoch - sourceEpoch > maxRewindCommits` predicate, including `Infinity`.
- Made pool capacity refusal retryable and exposed active authenticated source epochs as retained-history pruning pins.
- Added one parent-resolution vocabulary that authenticates against an exact parent before authorization/component validation and is reused by live fork recovery and persisted-tree recovery.
- Prevented temporary refusal from admitting a shortened prefix as a competing branch while retaining 04-02 stamped-own-commit recovery.

## Task Commits

1. **Task 1 RED: Deferred retention boundaries** - `6636362` (test)
2. **Task 1 GREEN: Authenticated source-epoch retention** - `972fffe` (feat)
3. **Task 2 RED: Unified parent-resolution outcomes** - `e4c8eac` (test)
4. **Task 2 GREEN: Shared parent resolver** - `1755599` (feat)
5. **Task 1 REFACTOR: Pool formatting** - `16c8dad` (style)

## Files Created/Modified

- `src/engine/ingestion-pool.ts` - Stores optional authenticated source epochs, applies strict horizon expiry, and refuses overflow without eviction.
- `src/engine/ingest.ts` and `src/engine/types.ts` - Carry the authenticated framed-message epoch on deferred outcomes.
- `src/engine/group-engine.ts` - Retains deferred commits, pins their source states, and reuses shared parent resolution for tree recovery.
- `src/engine/fork-recovery.ts` - Defines and applies discriminated parent-resolution outcomes while suppressing incomplete candidates.
- `src/engine/__tests__/ingest-deferred.test.ts` - Covers boundary, beyond-boundary, Infinity, pins, and capacity redelivery.
- `src/engine/__tests__/ingestion-pool.test.ts` - Updates real-engine pool coverage for retryable refusal and authenticated expiry.
- `src/engine/__tests__/convergence-parity.test.ts` - Pins stamped success and authentication-mismatch outcomes alongside full fork scenarios.
- `src/client/marmot-client.ts` - Updates the public tuning documentation to the source-epoch horizon option.

## Decisions Made

- Opaque undecryptable wrappers do not receive fabricated source epochs; bounded capacity limits them until authentication supplies protocol metadata.
- A duplicate pool insertion may upgrade an opaque entry with an authenticated source epoch but never rewrites an already-authenticated epoch.
- A stamped own commit is treated as already authenticated and authorized only when its recorded parent tag matches the exact candidate parent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Updated existing pool contract coverage and public option documentation**

- **Found during:** Task 1
- **Issue:** The planned files did not include the existing ingestion-pool integration test or the public option JSDoc, both of which encoded the removed arrival-age/oldest-eviction behavior.
- **Fix:** Migrated them to retryable capacity refusal and authenticated source-epoch terminology.
- **Files modified:** `src/engine/__tests__/ingestion-pool.test.ts`, `src/client/marmot-client.ts`
- **Verification:** Focused pool tests, compile, and full suite passed.
- **Committed in:** `972fffe`

**2. [Rule 1 - Bug] Preserved visible deferred outcomes after retaining them**

- **Found during:** Full-suite verification after Task 2
- **Issue:** The first retention implementation suppressed accepted deferred outcomes, causing convergence status to miss outstanding work and remain non-Resolving.
- **Fix:** Retained the entry while still yielding its retryable deferred disposition; neither retained nor refused work enters terminal deduplication.
- **Files modified:** `src/engine/group-engine.ts`
- **Verification:** `convergence-status.test.ts` and all 795 tests passed.
- **Committed in:** `1755599`

---

**Total deviations:** 2 auto-fixed (1 missing critical functionality, 1 bug).
**Impact on plan:** Both changes preserve the intended externally visible retry semantics and remove stale public guidance; no scope expansion or dependency changes.

## Issues Encountered

- A local default-pnpm `exec prettier` attempted a workspace modules refresh and aborted without a TTY. The required pinned pnpm 10.18.3 launcher was used instead; no lockfile or dependency files changed.

## TDD Gate Compliance

- Task 1 has distinct RED (`6636362`) and GREEN (`972fffe`) commits.
- Task 2 has distinct RED (`e4c8eac`) and GREEN (`1755599`) commits.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `CI=true npx --yes pnpm@10.18.3 vitest run src/engine/__tests__/convergence-parity.test.ts src/engine/__tests__/ingest-deferred.test.ts` — 11 tests passed.
- `CI=true npx --yes pnpm@10.18.3 compile` — passed.
- `CI=true npx --yes pnpm@10.18.3 vitest run` — 82 files and 795 tests passed.
- `pnpm-lock.yaml` remained at SHA-256 `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932`.

## Next Phase Readiness

- Missing-parent recovery now preserves complete candidates through the protocol horizon for later scheduling and conformance-vector plans.
- No blockers remain for Plan 04-04.

## Self-Check: PASSED

- All modified files exist.
- Commits `6636362`, `972fffe`, `e4c8eac`, `1755599`, and `16c8dad` exist in repository history.
- Focused suites, strict compile, and the complete Vitest suite pass.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
