---
phase: 05-quality-gate
plan: 01
subsystem: testing
tags: [github-actions, node, deno, bun, vitest, conformance]
requires:
  - phase: 04-feature-parity-conformance-vectors
    provides: Normal and isolated extended conformance suites
provides:
  - Six-runtime CI contract running normal and extended suites
  - Revision-bound local smoke evidence for Node 22, Deno 2, and Bun latest
affects: [quality-gate, release-evidence, QA-01]
tech-stack:
  added: []
  patterns: [runtime-resolved CI version logging, smoke-versus-authority evidence separation]
key-files:
  created:
    - .planning/phases/05-quality-gate/05-RUNTIME-EVIDENCE.md
  modified:
    - .github/workflows/tests.yml
key-decisions:
  - "Treat local Node 22, Deno 2, and Bun latest executions as smoke evidence only; the complete six-row CI matrix remains release authority."
  - "Record the local pnpm 12.3.4 installation honestly while retaining pnpm 10 plus frozen-lockfile installation as the CI contract."
patterns-established:
  - "Every runtime job reports its resolved runtime and pnpm versions before executing both Vitest configurations."
requirements-completed: [QA-01]
coverage:
  - id: D1
    description: Every supported CI runtime row executes both normal and isolated extended suites with resolved version logging.
    requirement: QA-01
    verification:
      - kind: other
        ref: node static workflow contract assertion from 05-01-PLAN.md
        status: pass
    human_judgment: false
  - id: D2
    description: Local smoke evidence is revision-bound and does not claim results for unavailable runtime versions.
    requirement: QA-01
    verification:
      - kind: integration
        ref: .planning/phases/05-quality-gate/05-RUNTIME-EVIDENCE.md runtime command table
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 1: Six-Runtime Test Matrix Summary

**Node, Deno, and Bun CI families now report resolved versions and run both normal and extended suites, backed by accurately scoped local smoke evidence.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-06T18:03:51Z
- **Completed:** 2026-09-06T18:12:51Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added normal plus isolated extended Vitest execution to all six declared CI runtime rows.
- Added explicit runtime and pnpm version reporting while preserving pinned pnpm 10 and frozen-lockfile installation.
- Captured SHA-bound SMOKE results only for installed Node 22, Deno 2, and Bun latest versions; marked Node 20, Node 24, and Bun 1.1 CI-required and untested locally.

## Task Commits

1. **Task 1: Run normal and extended suites in every runtime job** - `d425bac` (ci)
2. **Task 2: Capture locally available smoke evidence** - `9f497ac` (docs)

## Files Created/Modified

- `.github/workflows/tests.yml` - Reports resolved tool versions and runs both suite configurations in every matrix family.
- `.planning/phases/05-quality-gate/05-RUNTIME-EVIDENCE.md` - Records immutable provenance, local smoke outcomes, unavailable rows, and separate library gates.

## Decisions Made

- Local results remain explicitly non-authoritative SMOKE evidence; GitHub Actions must supply the complete six-runtime release record.
- Local pnpm was recorded as 12.3.4 and was not represented as CI's pinned pnpm 10 environment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking artifact] Removed a generated Deno lockfile**

- **Found during:** Task 2 runtime smoke execution
- **Issue:** Deno created an untracked `deno.lock` while resolving the npm Vitest command.
- **Fix:** Removed the generated file after the successful smoke run so runtime cache activity did not alter repository dependency state.
- **Files modified:** None retained
- **Verification:** `git status --short` showed no generated residue before the task commit.
- **Committed in:** Not applicable; cleanup restored the pre-command repository shape.

**2. [Rule 3 - State tracking] Repaired an unparseable initial phase position**

- **Found during:** Plan close-out
- **Issue:** `state.advance-plan` could not parse the pre-phase values `Plan: Not started` and `Status: Ready to plan`.
- **Fix:** Updated the current focus and position to Phase 5, Plan 2 of 8 after the other SDK state handlers completed successfully.
- **Files modified:** `.planning/STATE.md`
- **Verification:** State now names Phase 5 as current and Plan 2 of 8 as the next position.
- **Committed in:** Plan metadata commit.

---

**Total deviations:** 2 auto-fixed (2 Rule 3).
**Impact on plan:** No scope expansion or dependency change; the generated runtime artifact was excluded from the repository.

## Issues Encountered

`pnpm lint` exited 1 and reported nine pre-existing unformatted files outside this plan's scope. The failure is preserved in the runtime evidence rather than being repaired or described as a pass. Compile, clean build, and all six locally executable normal/extended runtime commands passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The six-row CI execution contract is ready for GitHub Actions. Phase 5 can aggregate CI job URLs and conclusions once that external run exists; local evidence must remain labeled SMOKE.

## Self-Check: PASSED

- Both key files exist.
- Task commits `d425bac` and `9f497ac` exist in repository history.
- The workflow contract assertion and all locally installed runtime smoke commands passed.

---

_Phase: 05-quality-gate_
_Completed: 2026-09-06_
