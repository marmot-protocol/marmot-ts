---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
plan: 04
subsystem: testing
tags: [mls, account-identity-proof, seam-parity, convergence, fork-recovery, ts-mls]

# Dependency graph
requires:
  - phase: 08-groupcontext-profile-requirement-legality-seam-extension
    provides: "validateCommitAccountIdentityProofs wired into validateCommitLegality (08-01); standalone-Add admission and D-05 identical rejection labeling across ingest/fork-recovery (08-02); forgeKeyPackage/dropAccountIdentityProofRequirement shared fixtures (08-01)"
provides:
  - "src/__tests__/helpers/engine-seam-fixtures.ts: testPeeler, seamGroup (two-admin group with an optional forged-proof third member added in the raw founding commit), buildAdmin1PerspectiveChain, edgeFromReplay, snapshot -- re-homed from commit-legality-seams.test.ts/send-commit-legality.test.ts so the GRP-02 matrix does not re-derive them"
  - "src/engine/__tests__/account-identity-proof-seams.test.ts: the GRP-02 targeted seam-parity matrix (3 D-04 fixtures x 4 seams + 1 legal tree-fed control, 14 tests) proving send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence report the IDENTICAL projected verdict { reason: account-identity-proof, proofReason, leafIndex } for a requirement-drop commit, a proof-less Add, and an update-path leaf carrying an invalid proof"
  - "GRP-02 marked complete in REQUIREMENTS.md -- the phase's primary defense against the mdk#707 seam-asymmetry defect class is now test-proven, not just implemented"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A shared engine-seam-fixtures.ts module (testPeeler/seamGroup/buildAdmin1PerspectiveChain/edgeFromReplay/snapshot) re-homing the exact patterns two prior seam-parity test files already established, so a third seam-parity file does not re-derive fork-replay/history-edge-injection machinery a fourth time"
    - "adminCallbackFor(parent, impl) test helper builds the identical IncomingMessageCallback the engine itself would construct for a given parent state, so resolveCandidateParent's independently-computed verdict is directly comparable to the engine's own disposition for the same input"

key-files:
  created:
    - src/__tests__/helpers/engine-seam-fixtures.ts
    - src/engine/__tests__/account-identity-proof-seams.test.ts
  modified: []

key-decisions:
  - "Computed the proof-less-Add fixture's expected proofReason dynamically via validateKeyPackageAccountIdentityProof in a beforeAll, rather than hardcoding 'missing-support' -- so the test tracks the validator's own source of truth for which check fires first, per the plan's explicit instruction"
  - "Split the proof-less-Add fixture into 4 separate `it` blocks (one per seam) rather than one combined test, to satisfy Pitfall 3's warning sign ('only 3 describe/it blocks per fixture instead of 4') and the plan's >=8-tests acceptance criterion for Task 1"
  - "The update-path fixture's replay and tree-fed rows first prove admin1's own benign commit is unaffected by the unchanged forged leaf (D-01: unchanged leaves are trusted), before ingesting/tree-feeding the forged member's own self-update -- so a false pass from an unrelated engine failure is ruled out"

requirements-completed: [GRP-02]

coverage:
  - id: D1
    description: "A commit dropping the 0x8009 GroupContext requirement is refused identically (reason account-identity-proof, proofReason missing-requirement, no leafIndex) on send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/account-identity-proof-seams.test.ts#GRP-02 seam parity: commit that drops the 0x8009 requirement (D-04)"
        status: pass
    human_judgment: false
  - id: D2
    description: "An Add proposal whose KeyPackage carries no 0x8009 proof is refused identically (reason account-identity-proof, proofReason from the validator, no leafIndex -- pre-apply) on send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/account-identity-proof-seams.test.ts#GRP-02 seam parity: Add whose leaf has no proof (D-04, D-08)"
        status: pass
    human_judgment: false
  - id: D3
    description: "An update-path leaf carrying forward an already-invalid 0x8009 proof is refused identically (reason account-identity-proof, proofReason invalid-proof, leafIndex = the forged member's true MLS leaf index -- post-apply) on send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence; a legal two-deep sibling branch on the same forged-member group still switches, proving the abandonment is caused by the proof gate"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/account-identity-proof-seams.test.ts#GRP-02 seam parity: update-path leaf with an invalid proof (D-04, D-02, D-03)"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-09-15
status: complete
---

# Phase 8 Plan 4: GroupContext Profile Requirement & Legality-Seam Extension (GRP-02 Seam-Parity Matrix) Summary

**A new 14-test seam-parity matrix proves, for all three D-04 invalid inputs (dropped 0x8009 requirement, proof-less Add, invalid update-path leaf), that send, inbound ingest, fork-recovery/pool replay, and tree-fed convergence all report the IDENTICAL structured `account-identity-proof` violation -- closing GRP-02 and the phase's primary defense against the mdk#707 seam-asymmetry defect class.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-09-15
- **Tasks:** 2
- **Files modified:** 2 (both new)

## Accomplishments
- New `src/__tests__/helpers/engine-seam-fixtures.ts`: `testPeeler`, `seamGroup` (a two-admin group at epoch 1, with an optional third member forged with a tampered `0x8009` proof added in the same raw founding commit -- the only way to get an already-invalid leaf into the tree, per Pitfall 2), `buildAdmin1PerspectiveChain`, `edgeFromReplay`, `snapshot` -- re-homed (copied, not imported) from the two prior seam-parity test files so this matrix does not re-derive their fork-replay/history-edge-injection machinery.
- New `src/engine/__tests__/account-identity-proof-seams.test.ts` (14 tests): three `describe` blocks, one per D-04 fixture, each with 4 `it` blocks (send/inbound/replay/tree-fed) asserting an identical `project(violation)` result -- `{ reason: "account-identity-proof", proofReason, leafIndex }`, dropping `detail` since pre-apply and post-apply wording legitimately differs. A fifth `it` per fixture-3 describe block is a legal-branch control proving a genuinely valid two-deep sibling branch on the SAME forged-member group still switches on tree-fed re-convergence -- ruling out branch-selection or replay-mismatch as the cause of the invalid rows' abandonment (Pitfall 3).
- Each seam keeps its own fixed disposition throughout: send throws `CommitLegalityError` with the epoch unchanged; inbound yields exactly one `rejected` result with the epoch unchanged; replay creates no history-tree edge for the violating commit digest and leaves the tip unchanged; tree-fed convergence abandons the switch (via `recordEdge` + `reconvergeFromHistory`) and keeps the tip, with `lifecycle` staying `"Stable"`.
- GRP-02 marked complete in `.planning/REQUIREMENTS.md` -- its full text ("...rejected identically on send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence") is now proven by this matrix, closing the requirement plans 08-01/08-02/08-03 deliberately left Pending per their own documented discretion.

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared seam fixtures and the matrix rows for requirement drop and proof-less Add** - `0e33872` (test)
2. **Task 2: Matrix rows for an update-path leaf with an invalid proof, plus the tree-fed legal control** - `56509d1` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/__tests__/helpers/engine-seam-fixtures.ts` (new) - `testPeeler`, `seamGroup`, `buildAdmin1PerspectiveChain`, `edgeFromReplay`, `snapshot`
- `src/engine/__tests__/account-identity-proof-seams.test.ts` (new) - 14 tests: 3 fixtures x 4 seams + 1 legal tree-fed control

## Decisions Made
- The proof-less-Add fixture's `expectedProofReason` is computed dynamically (catching `validateKeyPackageAccountIdentityProof`'s thrown reason in a `beforeAll`) rather than hardcoded, so the test tracks the validator's own source of truth rather than assuming which structural check fires first for a leaf with `leafNodeExtensions: []`.
- Split what the plan's action prose described as a bundled "run the same four seams" check into 4 independent `it` blocks per fixture (matching fixture 1's and 3's shape), rather than one `it` with 4 inline sub-blocks -- satisfies both the plan's own `>= 8 tests` (Task 1) / `>= 13 tests` (Task 2) acceptance criteria and Pitfall 3's explicit warning sign ("a D-04 test file with only 3 describe/it blocks per fixture instead of 4").
- The update-path fixture's replay row first sends and confirms admin1's own benign empty commit (which re-signs only admin1's leaf, leaving the forged member's leaf byte-identical and therefore untouched per D-01's "unchanged leaves are trusted") before ingesting the forged member's own self-update -- proving the benign-commit acceptance and the forged-commit rejection are independent facts, not a single conflated assertion.

## Deviations from Plan

None - plan executed exactly as written. All fixture-construction techniques (raw founding-commit forgery via `forgeKeyPackage`, `dropAccountIdentityProofRequirement`, `buildAdmin1PerspectiveChain`/`edgeFromReplay` for tree-fed persisted-edge injection) matched the plan's `<interfaces>` and `08-RESEARCH.md` Pattern 5 exactly; no production code was touched.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GRP-02 is now the last of GRP-01..04 to be marked complete in `REQUIREMENTS.md`; Phase 8 (GroupContext Profile Requirement & Legality-Seam Extension) has no remaining requirement work.
- Full suite: 103 files / 1164 tests passing (was 102/1150 before this plan); `pnpm compile` and full-project `tsc --noEmit` both clean; `pnpm exec prettier --check` clean on both new files.
- `src/__tests__/helpers/engine-seam-fixtures.ts` is available for any future seam-parity test file (e.g. a Phase 9 UPD-01..04 matrix for standalone Update admission and replacement-leaf identity) needing the same `seamGroup`/`buildAdmin1PerspectiveChain`/`edgeFromReplay` fork-replay pattern.

---
*Phase: 08-groupcontext-profile-requirement-legality-seam-extension*
*Completed: 2026-09-15*

## Self-Check: PASSED

All 2 created files verified present on disk; both task commit hashes (0e33872, 56509d1) verified in `git log --all`.
