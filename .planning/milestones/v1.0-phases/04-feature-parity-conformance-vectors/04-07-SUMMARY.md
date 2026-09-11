---
phase: 04-feature-parity-conformance-vectors
plan: 07
subsystem: testing
tags: [conformance, mdk, offline-catchup, proof-v2, vitest]
requires:
  - phase: 04-06
    provides: validated manifest loader, deterministic subject, canonical snapshot projection
provides:
  - Exhaustive stable-ID representation for all 31 portable MDK manifest entries
  - Isolated deterministic offline-pressure suite for cases 6 through 23
  - Repository-local Rust proof-v2 fixture with production verification and mutation rejection
affects: [phase-05, CONF-01, WIRE-04]
tech-stack:
  added: []
  patterns: [manifest count-equality gate, isolated Vitest discovery contract]
key-files:
  created:
    - src/__tests__/conformance/smoke.test.ts
    - src/__tests__/conformance/extended.spec.ts
    - src/__tests__/fixtures/proof-v2-rust.json
    - vitest.extended.config.ts
  modified:
    - src/core/__tests__/darkmatter-invite-compat.test.ts
    - package.json
key-decisions:
  - "Portable Scenario IR entries that exceed the current production adapter surface are passing explicit unsupported-capability records, never skips or omissions."
  - "The manifest id is authoritative when MDK's valid-routing-update fixture_name differs from its manifest id at 93ecfbca."
  - "Extended cases 6-23 are isolated from root discovery and remain a Phase 5 runtime-matrix input."
requirements-completed: [CONF-01, WIRE-04]
duration: 6min
completed: 2026-09-05
status: complete
---

# Phase 04 Plan 07: Portable Conformance Corpus Summary

**All portable MDK entries are represented under immutable upstream IDs, deterministic offline pressure has an isolated execution path, and Rust proof-v2 bytes are permanently verified.**

## Performance

- **Duration:** 6 min
- **Completed:** 2026-09-05
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Added 31 manifest-generated stable-ID smoke cases plus a represented-count equality gate. Production routing byte fixtures execute directly; unsupported Scenario IR actions yield explicit capability evidence.
- Added deterministic offline pressure cases 6-23 across medium-96, large-384, and xlarge-1024 profiles, including retry after capacity refusal, retained intermediate epochs, restart reconstruction, and duplicate-free final state.
- Added `conformance:extended` and an exact Vitest include while proving root Vitest discovers zero `extended.spec.ts` cases.
- Promoted the Rust-produced proof-v2 bytes into a repository fixture and verified canonical kind-450 signing semantics plus mutation failure using production proof functions.

## Task Commits

1. **Task 1: Portable manifest smoke set** - `75339e1` (RED), `37214e2` (GREEN)
2. **Task 2: Deterministic offline pressure suite** - `65fdbaf` (RED), `de43f62` (GREEN)
3. **Task 3: Permanent Rust proof-v2 fixture** - `9ec96fd` (RED), `173a989` (GREEN)

## Verification

- Dedicated extended suite: 18 tests passed.
- Root suite: 85 files and 844 tests passed; extended suite absent from discovery.
- Focused proof and smoke suite: 41 tests passed.
- Strict TypeScript compile passed.
- Phase diff contains no UI, COVERAGE, or disband implementation files.

## Decisions Made

- The adapter does not pretend to execute Scenario IR operations it does not expose. Such entries are explicit `scenario_ir_v3` unsupported records, with the upstream id retained and fixture schema validated.
- MDK's manifest id remains the test identity for the valid routing update despite the fixture's older `fixture_name`; the test cites the pinned `93ecfbca` source discrepancy.
- Large deterministic scales remain isolated from normal test discovery and are not claimed as a Node/Deno/Bun runtime-matrix result.

## Deviations from Plan

None - the plan's explicit capability-result contract was used for Scenario IR operations outside the current adapter surface.

## TDD Gate Compliance

- Each task has a failing RED commit followed by a passing GREEN commit.

## Known Stubs

None.

## User Setup Required

None.

## Next Phase Readiness

Phase 5 can invoke `pnpm conformance:extended` under its controlled runtime matrix without changing default Vitest discovery.

## Self-Check: PASSED

- All four created files and both modified files exist.
- All six task commits exist.
- Focused, extended, full-suite, and compile verification passed.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
