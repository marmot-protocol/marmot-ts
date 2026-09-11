---
phase: 03-commit-integrity-convergence-parity
plan: 10
subsystem: convergence
tags: [mls, fork-recovery, retained-history, own-commit, proposal-reference]
requires:
  - phase: 03-commit-integrity-convergence-parity
    provides: shallow own-commit recovery and commit-legality gates
provides:
  - Parent-bound retained applied-link evidence for own-confirmed convergence
  - Complete reconstruction of chained own commits consuming proposal references
  - Native MDK-derived D-15/D-16 convergence regressions
affects: [03-11, phase-03-reverification, CONV-04]
tech-stack:
  added: []
  patterns: [parent-bound retained links, structural own-commit materialization]
key-files:
  created: []
  modified:
    - src/engine/retained-store.ts
    - src/engine/fork-recovery.ts
    - src/engine/__tests__/convergence-parity.test.ts
key-decisions:
  - "Retain each applied commit as an exact parent/message/resulting-state link instead of reconstructing own links from digest plus epoch lookups."
  - "Refresh the preceding link's resulting state when its child becomes the next commit parent, preserving staged proposal-reference evidence."
metrics:
  duration: 5min
  completed: 2026-09-01
status: complete
---

# Phase 03 Plan 10: Structural Own-Commit Convergence Summary

**Parent-bound retained links now preserve complete locally confirmed branches, including later commits that consume exact-parent proposals by reference.**

## Performance

- **Duration:** 5 minutes
- **Completed:** 2026-09-01
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Replaced digest-plus-epoch own-commit reconstruction with structural retained links carrying the exact parent, commit message, and resulting state.
- Preserved proposal-reference evidence by refreshing a preceding link when its resulting epoch becomes the next commit's parent.
- Added a native depth-two regression proving an own-confirmed branch with a by-reference proposal remains canonical against a shallower same-epoch sibling.
- Documented the direct MDK analogues used for own-link materialization and order-independent canonical selection without introducing Phase 4 vector infrastructure.

## Task Commits

1. **Task 1: Preserve one chained own branch with a by-reference proposal end to end** - `b8b381f`
2. **Task 2: Add native MDK-derived own-confirmed-commit regressions (D-15, D-16)** - `f76faba`

## Verification Evidence

| Command | Result |
| --- | --- |
| `pnpm vitest run src/engine/__tests__/convergence-parity.test.ts` | PASS — 5/5 tests |
| `pnpm compile` | PASS |
| `pnpm vitest run src/engine/__tests__/convergence-parity.test.ts src/engine/__tests__/commit-legality-seams.test.ts` | PASS — 10/10 tests |
| `pnpm build` | PASS |
| Lockfile SHA-256 after every pnpm command | PASS — `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` |

## Decisions Made

- Kept `appliedCommitsBetween` as a compatibility projection while adding `appliedLinksBetween` for the production structural path.
- Kept legacy/custom `RetainedView` implementations working through an optional fallback; the real `RetainedHistoryStore` always supplies parent-bound links.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Refreshed structural link evidence after proposal staging**

- **Found during:** Task 1
- **Issue:** The first structural implementation retained the epoch-2 resulting state before a proposal was staged there, so the later by-reference commit could not reconstruct that proposal when convergence revisited the link.
- **Fix:** When recording the next applied link, refresh the preceding link's resulting state from the exact parent state used for that commit.
- **Files modified:** `src/engine/retained-store.ts`
- **Verification:** The depth-two own-branch regression and full convergence-parity suite pass.
- **Commit:** `b8b381f`

**Total deviations:** 1 auto-fixed bug. **Impact:** The planned structural design now retains the exact proposal-bearing parent evidence required by chained commits.

## Authentication Gates

None.

## Known Stubs

None.

## Issues Encountered

- The first test fixture attempted proposal combinations rejected by MLS validation; it was corrected to stage a distinct Add proposal and consume it through the self-update path.
- The pre-change valid regression passed because existing CR-08 state retention covered the live case; introducing explicit structural links exposed the stale resulting-state edge and drove the final parent-bound refresh fix.

## Next Phase Readiness

- CONV-04 now covers shallow, competing, dual-order, and chained by-reference own-confirmed branches.
- Plan 03-11 can re-verify phase closure against structural own-link convergence.

## Self-Check: PASSED

- All three modified files exist.
- Task commits `b8b381f` and `f76faba` exist in Git history.
- All task acceptance criteria and plan-level verification commands passed.
- No stubs, skipped tests, unrun verification, or new threat surface remain.
- The authoritative `pnpm-lock.yaml` remained byte-for-byte unchanged.

---

_Phase: 03-commit-integrity-convergence-parity_
_Completed: 2026-09-01_
