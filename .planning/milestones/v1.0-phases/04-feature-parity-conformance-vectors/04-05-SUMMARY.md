---
phase: 04-feature-parity-conformance-vectors
plan: 05
subsystem: convergence-scheduling
tags: [convergence, monotonic-clock, fairness, retained-input]
requires:
  - phase: 04-03
    provides: retained missing-parent input and authenticated anchors
  - phase: 04-04
    provides: durable wrapper reconciliation and revalidation
provides:
  - Version-compatible 5000 ms convergence pass policy bound
  - Immutable monotonic pass identity with deterministic retained-input continuation
  - One-attempt fairness for already-queued group-state intents
affects: [04-06, 04-07, conformance-harness]
tech-stack:
  added: []
  patterns: [immutable pass snapshots, one-shot scheduler edges]
key-files:
  created: [src/engine/__tests__/convergence-scheduling.test.ts]
  modified: [src/core/convergence.ts, src/engine/types.ts, src/engine/group-engine.ts, src/client/session/group-session.ts, src/client/group/marmot-group.ts]
key-decisions:
  - "Use performance.now as the default monotonic clock and sample it once when a pass opens."
  - "Assign fairness only to commit intents present at settlement; the existing engine authorization path remains authoritative."
patterns-established:
  - "Absolute pass deadlines never move when selection-relevant input refreshes quiescence."
  - "A scheduler continuation drains one retained batch per explicit drive edge."
requirements-completed: [CONF-01]
coverage:
  - id: D1
    description: Bounded immutable convergence passes retain and resume excluded input
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/engine/__tests__/convergence-scheduling.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Settlement grants one pre-existing authorized state intent a preparation attempt
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/engine/__tests__/convergence-scheduling.test.ts
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-09-05
status: complete
---

# Phase 04 Plan 05: Bounded Convergence Scheduling Summary

**Immutable monotonic pass deadlines now bound collection while deterministic continuation and a one-attempt local commit slot prevent retained inbound pressure from starving administrative progress.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-09-05T15:29:00Z
- **Completed:** 2026-09-05T15:37:30Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Added the policy-v1 `maxConvergencePassMs` value with a compatibility normalizer for older policy input.
- Added immutable pass snapshots, exact-boundary retention, lifecycle-gated admission, and deterministic one-batch continuation.
- Added settlement fairness that snapshots the existing outbound queue, attempts one commit through the established authorization/send seam, and then resumes retained inbound.

## Task Commits

1. **Task 1 RED: bounded pass contract tests** - `9daeb49`
2. **Task 1 GREEN: immutable deadline and continuation** - `4047c3e`
3. **Task 2 RED: local-intent fairness tests** - `e886676`
4. **Task 2 GREEN: settlement fairness and resumed inbound** - `b037d94`
5. **Regression: public export snapshot** - `a4ca2ea`
6. **Coverage: unsafe lifecycle pass gates** - `af34b3e`
7. **Regression: resume retained input after publish lifecycle** - `d38408a`
8. **Regression: fresh monotonic engines start settled** - `2768a20`

## Files Created/Modified

- `src/core/convergence.ts` - Policy-v1 pass bound and legacy-input normalization.
- `src/engine/types.ts` - Immutable pass state constructors.
- `src/engine/group-engine.ts` - Monotonic pass lifecycle, retained input, cutoff scheduling, and drive hook.
- `src/client/session/group-session.ts` - Normal reconciliation for scheduler-driven continuation.
- `src/client/group/marmot-group.ts` - Pre-existing commit fairness slot before inbound continuation.
- `src/engine/__tests__/convergence-scheduling.test.ts` - Deadline, continuation, lifecycle, and fairness coverage.
- `src/core/__tests__/convergence.test.ts` - Policy-v1 constant coverage.
- `src/__tests__/exports.test.ts` - Public scheduler-policy export contract.

## Decisions Made

- The plan's `src/core/convergence-policy.ts` path was stale; implementation was placed in the existing public `src/core/convergence.ts` policy module.
- `MockNetwork` needed no new control: deterministic ordering and failure semantics were proven at the queue-selection and production engine send seams without adding unused test-double API.
- A failed commit preparation rejects that queued caller and consumes the single opportunity, after which retained inbound continues.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated the public export snapshot**
- **Found during:** Task 2 regression verification
- **Issue:** New public policy and fairness helpers correctly changed the root export surface, leaving the inline snapshot stale.
- **Fix:** Regenerated and verified the exact export snapshot.
- **Files modified:** `src/__tests__/exports.test.ts`
- **Verification:** `CI=true npx --yes pnpm@10.18.3 vitest run src/__tests__/exports.test.ts`
- **Committed in:** `a4ca2ea`

**2. [Rule 1 - Bug] Woke retained continuation after publish lifecycle settlement**
- **Found during:** Post-wave retained-history regression verification
- **Issue:** PendingPublish correctly retained inbound work, but confirmation/failure did not wake the owner after returning to Stable, so retained work could remain dormant.
- **Fix:** Schedule a zero-delay owner wake when a publish lifecycle settles with retained input, and update the pruning regression to assert no mutation while unsafe followed by deterministic continuation in Stable.
- **Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/group-engine.test.ts`
- **Verification:** focused group-engine and scheduling suites (15/15) plus strict compile.
- **Committed in:** `d38408a`

**3. [Rule 1 - Bug] Distinguished a fresh engine from a pass opened at monotonic time zero**
- **Found during:** Sequential full-suite regression verification
- **Issue:** Initializing the last-input timestamp to zero made a fresh engine appear Syncing during the first process-relative quiescence interval under `performance.now()`. Outbound calls queued with no active pass or timer to wake them, causing exact five-second test timeouts.
- **Fix:** Represent "no convergence pass has opened" as `undefined` and derive Settled directly until the first relevant input records a monotonic timestamp.
- **Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/convergence-scheduling.test.ts`
- **Verification:** sequential full suite: 83 files and 807 tests passed; focused scheduling/group-engine suites and strict compile also passed.
- **Committed in:** `2768a20`

**Total deviations:** 3 auto-fixed (1 blocking regression, 2 scheduler bugs). **Impact on plan:** All fixes enforce the planned scheduling contract; no feature scope expansion.

## Issues Encountered

- The plan named a policy file that does not exist in this codebase; the established `convergence.ts` module was used.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The conformance scenario adapter can drive retained convergence work via deterministic scheduler edges.
- No blockers for Plan 04-06.

## Self-Check: PASSED

- All key files exist.
- All eight task/regression commits exist.
- Sequential full suite passed (83 files, 807 tests), along with focused scheduler checks and strict compile.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
