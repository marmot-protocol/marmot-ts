---
phase: quick-260911-dqr
plan: 01
subsystem: testing
tags: [vitest, tsc, dead-code-removal]

requires: []
provides:
  - Removal of three dead Phase 5 quality-gate scripts (render-quality-gate.mjs, validate-quality-ci.mjs, validate-quality-dossiers.mjs)
  - self-remove.test.ts decoupled from an archived planning document, fixing ENOENT on every CI runtime
affects: [ci, testing]

tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - scripts/render-quality-gate.mjs (deleted)
    - scripts/validate-quality-ci.mjs (deleted)
    - scripts/validate-quality-dossiers.mjs (deleted)
    - src/__tests__/integration/self-remove.test.ts

key-decisions:
  - "Deleted all three Phase 5 scripts per locked user decision; kept tools/quality-gate/, scripts/publish-nostr.sh, scripts/release-next.sh untouched"
  - "Removed only the planning-prose assertion and its readFileSync/node:fs import from self-remove.test.ts; retained all appliedNotifications behavioral assertions"

patterns-established: []

requirements-completed:
  - quick-260911-dqr

coverage:
  - id: D1
    description: "Three dead Phase 5 quality-gate scripts removed from scripts/, with tools/quality-gate/, publish-nostr.sh, and release-next.sh unchanged"
    requirement: "quick-260911-dqr"
    verification:
      - kind: other
        ref: "git ls-tree -r --name-only HEAD -- scripts (script-name grep verify command from PLAN task 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "self-remove.test.ts decoupled from the archived planning document; both tests pass without filesystem coupling to planning docs"
    requirement: "quick-260911-dqr"
    verification:
      - kind: unit
        ref: "src/__tests__/integration/self-remove.test.ts (2 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Library build and test-inclusive typecheck both pass after the changes"
    requirement: "quick-260911-dqr"
    verification:
      - kind: other
        ref: "pnpm compile"
        status: pass
      - kind: other
        ref: "pnpm exec tsc -p tsconfig.json --noEmit"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-09-11
status: complete
---

# Quick Task 260911-dqr: Delete Phase 5 Quality-Gate Scripts and Decouple self-remove.test.ts Summary

**Deleted three dead Phase 5 quality-gate scripts and removed self-remove.test.ts's read of an archived planning document, fixing the ENOENT failure on every CI runtime.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-11T~14:52Z
- **Completed:** 2026-09-11T15:13:01Z
- **Tasks:** 2 completed
- **Files modified:** 4 (3 deleted, 1 modified)

## Execution Context

The first attempt at this task ran in an isolated Claude Code worktree and halted during preflight: the worktree was forked from `master` at tip `2f60dbb`, not from `next` at the required base commit `685e0a3`, so the worktree's HEAD did not match the plan's locked baseline. Per explicit user approval, this run executed directly in the primary checkout at `/home/robert/Projects/marmot-ts` on branch `next` instead of an isolated worktree. Preflight in the primary checkout confirmed branch `next`, HEAD `685e0a36fbad803b4ffe3f39d0c9a7a2d18a95dc`, a clean working tree, and present `node_modules`/`ts-mls` submodule before any edits were made.

## Accomplishments
- Deleted `scripts/render-quality-gate.mjs`, `scripts/validate-quality-ci.mjs`, and `scripts/validate-quality-dossiers.mjs` — all three hardcoded the pre-archive Phase 5 evidence directory and had no callers left anywhere in the tree outside the planning directory.
- Removed the `readFileSync` call and `toContain` assertion in `self-remove.test.ts` that read an archived Phase 3.1 plan file from disk, plus the now-unused `node:fs` import, while preserving the test name and all `appliedNotifications` behavioral assertions (digest, empty notifications array, `not.toBeNull`/`toBeDefined`).

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete the three dead Phase 5 quality-gate scripts** - `0f5df0a` (chore)
2. **Task 2: Decouple self-remove.test.ts from the archived planning document** - `c8a77ce` (test)

**Plan metadata:** committed separately by the orchestrator (per constraints, this run did not commit PLAN.md/SUMMARY.md/STATE.md).

## Files Created/Modified
- `scripts/render-quality-gate.mjs` - deleted (dead Phase 5 evidence renderer)
- `scripts/validate-quality-ci.mjs` - deleted (dead Phase 5 CI evidence validator)
- `scripts/validate-quality-dossiers.mjs` - deleted (dead Phase 5 dossier validator)
- `src/__tests__/integration/self-remove.test.ts` - removed planning-document read/assertion and unused `node:fs` import; behavioral assertions unchanged

## Decisions Made
None beyond the plan's locked decisions - followed the plan as specified (delete all three scripts, keep `tools/quality-gate/`, keep `publish-nostr.sh`/`release-next.sh`, remove only the planning-prose assertion from the test).

## Deviations from Plan

None - plan executed exactly as written. The only deviation from the original *process* (not the plan content) was executing in the primary checkout instead of an isolated worktree, per explicit user approval, documented above under "Execution Context."

## Issues Encountered

The first isolated-worktree attempt at this task halted at preflight due to a worktree/base-commit mismatch (worktree forked from `master` tip `2f60dbb` instead of `next` at `685e0a3`). No code changes were made in that attempt. This run re-executed cleanly on the primary checkout after the mismatch was identified and the user approved running there.

## Verification Results

All commands run from the repo root after both tasks:

- `pnpm vitest run src/__tests__/integration/self-remove.test.ts` — **2 passed (2)**
- `pnpm compile` — **exit 0**
- `pnpm exec tsc -p tsconfig.json --noEmit` — **exit 0**
- `git grep -n '\.planning' -- src` — **empty (no matches)**
- `git log --oneline -2` — `c8a77ce test(self-remove): drop assertion on archived planning document`, `0f5df0a chore(scripts): delete dead Phase 5 quality-gate scripts` (exactly the two task commits, in order)
- `git status --porcelain -- scripts src tools` — **empty**
- Full suite `pnpm vitest run` (one-shot, not watch mode) — **96 test files passed (96), 964 tests passed (964)**. This confirms the plan's note that the full suite was not pre-broken by a stale exports snapshot; the only prior failure (self-remove.test.ts) is now fixed and no other test regressed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

No blockers. `scripts/` now contains only `publish-nostr.sh` and `release-next.sh`. `tools/quality-gate/` is unchanged. `self-remove.test.ts` is green on its own and has no filesystem or planning-directory dependency. No file under `src/` references the planning directory. The library build and the test-inclusive typecheck both pass, and the full test suite is green (964/964).

---
*Phase: quick-260911-dqr*
*Completed: 2026-09-11*

## Self-Check: PASSED

- FOUND: scripts/render-quality-gate.mjs deleted as expected
- FOUND: scripts/validate-quality-ci.mjs deleted as expected
- FOUND: scripts/validate-quality-dossiers.mjs deleted as expected
- FOUND: src/__tests__/integration/self-remove.test.ts (present, modified)
- FOUND: commit 0f5df0a in git log
- FOUND: commit c8a77ce in git log
