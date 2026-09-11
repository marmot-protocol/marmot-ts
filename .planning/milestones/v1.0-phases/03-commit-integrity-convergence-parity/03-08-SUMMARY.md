---
phase: 03-commit-integrity-convergence-parity
plan: 08
subsystem: verification
tags: [ts-mls, submodules, wire-03, conv-01, vitest]
requires:
  - phase: 03-commit-integrity-convergence-parity
    provides: shared commit-legality validator and send/inbound/replay seam wiring
provides:
  - Materialized pinned ts-mls, Marmot spec, and MDK checkouts
  - Executable WIRE-03 and CONV-01 evidence across pure, inbound, replay, tree-fed, and send seams
affects: [03-09, 03-10, 03-11, phase-03-reverification]
tech-stack:
  added: []
  patterns: [pinned-gitlink verification, lockfile hash guard, frozen offline verification]
key-files:
  created: []
  modified: []
key-decisions:
  - "Treat the user-restored pnpm-lock.yaml SHA-256 as authoritative and verify it after every pnpm command."
  - "Use the existing shared validateCommitLegality suites as executable evidence without changing production code or assertions."
metrics:
  duration: 6h
  completed: 2026-09-01
status: complete
---

# Phase 03 Plan 08: Legality Seam Verification Summary

**Pinned MLS/spec/reference checkouts materialized at their recorded gitlinks, with 40 WIRE-03 and CONV-01 regression tests green across every existing legality seam and no lockfile drift.**

## Performance

- **Duration:** 6h elapsed, including a lockfile-restoration checkpoint
- **Started:** 2026-09-01T15:20:11Z
- **Completed:** 2026-09-01T21:19:00Z
- **Tasks:** 2
- **Files modified:** 0 production files

## Accomplishments

- Materialized `ts-mls`, `refs/marmot`, and `refs/mdk` at the exact commits recorded by the superproject.
- Built the pinned `ts-mls` workspace and compiled the library successfully.
- Passed the inbound/replay tracer suite: 5 tests in `commit-legality-seams.test.ts`.
- Passed all verification-owned legality suites together: 40 tests across pure validation, inbound, replay, tree-fed, and outbound send paths.
- Completed `pnpm build` while preserving the authoritative `pnpm-lock.yaml` byte-for-byte.

## Task Commits

Each task was committed atomically as a verification-only empty commit because the plan intentionally changes no repository files:

1. **Task 1: Materialize pinned dependencies and prove the tracer path** - `e426dd2`
2. **Task 2: Execute all WIRE-03 and CONV-01 seam regressions** - `22685e7`

## Verification Evidence

| Command | Result |
| --- | --- |
| `pnpm --filter ts-mls build` | PASS |
| `pnpm compile` | PASS |
| `pnpm vitest run src/engine/__tests__/commit-legality-seams.test.ts` | PASS — 5/5 tests |
| `pnpm vitest run src/core/components/__tests__/integrity.test.ts src/engine/__tests__/commit-legality-seams.test.ts src/engine/__tests__/send-commit-legality.test.ts` | PASS — 40/40 tests |
| `pnpm build` | PASS |
| Gitlink equality for `ts-mls`, `refs/marmot`, and `refs/mdk` | PASS |
| `sha256sum -c /tmp/marmot-ts-phase-03-pnpm-lock.sha256` after every pnpm command | PASS — `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` |

## Decisions Made

- The user-restored lockfile became the new authoritative baseline after the initial pnpm 11 invocation changed the prior dirty file and triggered the mandated hash gate.
- Resumed commands used frozen/offline pnpm configuration through environment variables; every dependency, build, and test command was immediately followed by a hash verification.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Prevented pnpm from rewriting the restored user-owned lockfile**

- **Found during:** Task 1
- **Issue:** The first execution attempt allowed pnpm 11 to resolve workspace dependencies and rewrite the pre-existing dirty lockfile; the hash gate stopped execution.
- **Fix:** Paused for exact user restoration, established the restored file as a new authoritative baseline, saved an exact temporary copy, and resumed with frozen/offline pnpm configuration plus per-command hash checks.
- **Files modified:** None retained; `pnpm-lock.yaml` matches the restored baseline exactly.
- **Verification:** SHA-256 remained `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` after every resumed command.
- **Commit:** N/A — environment-only recovery

**Total deviations:** 1 auto-fixed blocking issue. **Impact:** No scope increase and no repository-content drift; verification completed against the restored authoritative lockfile.

## Authentication Gates

None.

## Known Stubs

None. This plan created or modified no production files.

## Issues Encountered

- The initial run correctly stopped when pnpm 11 changed the user-owned lockfile. Exact recovery was not attempted from Git because that would have overwritten unrelated user changes. The user restored the file, after which all resumed checks passed.

## Next Phase Readiness

- The pinned Marmot and MDK sources are materialized for Plan 03-10.
- WIRE-03 and CONV-01 now have executable seam-level evidence for Phase 03 re-verification.
- No production fixes were required by this plan.

## Self-Check: PASSED

- All three materialized checkout paths exist and match their superproject gitlinks.
- Task commits `e426dd2` and `22685e7` exist in Git history.
- All task acceptance criteria and plan-level verification commands passed.
- The authoritative lockfile hash remained unchanged throughout resumed execution.

---

_Phase: 03-commit-integrity-convergence-parity_
_Completed: 2026-09-01_
