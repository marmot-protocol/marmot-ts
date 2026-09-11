---
phase: 04-feature-parity-conformance-vectors
plan: 02
subsystem: convergence-persistence
tags: [mls, convergence, restart, binary-codec, retained-history]
requires:
  - phase: 03-commit-integrity-convergence
    provides: parent-bound retained links and fork recovery
provides:
  - Versioned own-commit convergence stamp codec with legacy decoding
  - Confirmation-time capture and durable history persistence of own-commit evidence
  - Restart recovery of self-authored by-reference commit chains without proposal reconstruction
affects: [convergence, history-tree, group-registry, restart-recovery]
tech-stack:
  added: []
  patterns: [versioned binary storage envelope, stamped prevalidated own commits]
key-files:
  created:
    - src/engine/own-commit-stamp.ts
    - src/engine/__tests__/own-commit-stamp.test.ts
  modified:
    - src/engine/group-engine.ts
    - src/engine/history-tree.ts
    - src/engine/retained-store.ts
    - src/engine/fork-recovery.ts
    - src/client/group-registry.ts
    - src/engine/__tests__/convergence-parity.test.ts
key-decisions:
  - "Keep persisted record identity as SHA-256 of exact MLS commit bytes; stamp metadata never participates in identity."
  - "Treat only stamped retained links as prevalidated own commits; legacy links remain readable but receive no reconstructed authority."
patterns-established:
  - "Confirmation evidence is captured in PendingState, persisted with the exact commit bytes, and restored into RetainedAppliedLink."
requirements-completed: [CONF-01]
coverage:
  - id: D1
    description: Versioned own-commit records round-trip exact evidence while preserving legacy readability and wire identity.
    requirement: CONF-01
    verification:
      - kind: unit
        ref: src/engine/__tests__/own-commit-stamp.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: A persisted, reloaded self-authored by-reference chain remains a complete convergence candidate.
    requirement: CONF-01
    verification:
      - kind: integration
        ref: src/engine/__tests__/convergence-parity.test.ts#preserves a two-link own branch
        status: pass
    human_judgment: false
duration: 8min
completed: 2026-09-05
status: complete
---

# Phase 04 Plan 02: Own-Commit Convergence Evidence Summary

**Versioned confirmation-time stamps preserve exact self-authored MLS commit evidence across restart without reconstructing consumed proposals.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-09-05T14:52:33Z
- **Completed:** 2026-09-05T15:00:28Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments

- Added a strict versioned binary record that stores wire bytes, authenticated committer, authorization-derived priority, and canonically sorted proposal references.
- Captured stamp evidence before staged proposals disappear and persisted it alongside the exact commit bytes during confirmation.
- Rehydrated stamped retained links after a true store flush/load and recovered a two-link own branch containing a by-reference proposal without calling `framedCommitProposalsWithSender`.
- Preserved legacy bare commit records as an explicit unstamped variant with no inferred identity or authorization evidence.

## Task Commits

1. **Task 1 RED: stamp codec expectations** - `a86d6c2` (test)
2. **Task 1 GREEN: durable stamp codec** - `bcc986e` (feat)
3. **Task 2 RED: confirmation persistence expectations** - `ba524b5` (test)
4. **Task 2 GREEN: confirmation capture and restart recovery** - `4736722` (feat)
5. **Task 1 REFACTOR: repository formatting** - `461b2e7` (style)

## Files Created/Modified

- `src/engine/own-commit-stamp.ts` - Versioned record codec, legacy result, deterministic sorting, and stable identity.
- `src/engine/types.ts` - Carries transient own-commit evidence in `PendingState`.
- `src/engine/group-engine.ts` - Derives authorization priority, captures references, and confirms stamped commits.
- `src/engine/history-tree.ts` - Persists and reloads stamped records while exposing exact MLS bytes to existing callers.
- `src/engine/retained-store.ts` - Associates optional own-commit stamps with parent-bound applied links.
- `src/engine/fork-recovery.ts` - Admits only stamped own links through the no-replay path.
- `src/client/group-registry.ts` - Restores persisted stamps during retained-history hydration.
- `src/engine/__tests__/own-commit-stamp.test.ts` - Codec, corruption, sorting, legacy, and identity coverage.
- `src/engine/__tests__/convergence-parity.test.ts` - Publish rollback, persistence, real restart, and by-reference recovery coverage.

## Decisions Made

- Record identity remains the digest of exact MLS commit bytes for both stamped and legacy records.
- Priority is derived by applying the existing authorization decision to the staged proposal shape as a non-admin, matching MDK's privileged-versus-ordinary classification.
- Stamped own links bypass replay as prevalidated evidence; unstamped legacy links are never upgraded by guessing proposals from a parent snapshot.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Persisted stamps through the history tree and registry hydration seam**

- **Found during:** Task 2
- **Issue:** The plan's primary file list named retained-store changes, but `RetainedHistoryStore` is intentionally in-memory and rebuilt from `GroupHistoryTree`; changing it alone could not survive restart.
- **Fix:** Stored the versioned record under the existing history commit key and restored its stamp in `GroupRegistry` while preserving the exact existing child-tag and commit-digest identities.
- **Files modified:** `src/engine/history-tree.ts`, `src/client/group-registry.ts`
- **Verification:** Focused restart test, history-tree tests, strict compile, and full 791-test suite passed.
- **Committed in:** `4736722`

---

**Total deviations:** 1 auto-fixed (1 missing critical functionality).
**Impact on plan:** Required to make the requested persistence semantics real; no public wire format or record identity changed.

## Issues Encountered

- The first strict compile after removing proposal reconstruction found an unused logger; it was removed and the complete verification reran successfully.

## Verification

- `CI=true npx --yes pnpm@10.18.3 vitest run src/engine/__tests__/own-commit-stamp.test.ts src/engine/__tests__/convergence-parity.test.ts` — 10 tests passed.
- `CI=true npx --yes pnpm@10.18.3 compile` — passed.
- `CI=true npx --yes pnpm@10.18.3 vitest run` — 82 files, 791 tests passed.
- `rg "framedCommitProposalsWithSender" src/engine/fork-recovery.ts` — no matches; the own path has no reconstruction dependency.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Own-commit restart evidence is structurally available for later Phase 4 vector and scheduling work.
- No blockers remain for plan 04-03.

## Self-Check: PASSED

- All created files exist.
- All five task/TDD commits exist.
- Focused tests, full tests, compile, identity checks, and reconstruction-removal checks passed.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
