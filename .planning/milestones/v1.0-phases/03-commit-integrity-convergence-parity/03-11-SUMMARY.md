---
phase: 03-commit-integrity-convergence-parity
plan: 11
subsystem: commit-authorization
tags: [mls, authorization, proposals, wire-03, conv-01]
requires:
  - phase: 03-commit-integrity-convergence-parity
    provides: shared commit-legality adapter and outbound auto-coupling
provides:
  - Exact-union actor authorization for commit and selfUpdate
  - Reference-identity preservation across authorization, MLS construction, and legality validation
  - Outbound authorization matrix for by-value, selected-reference, and implicit proposals
affects: [phase-03-reverification, WIRE-03, CONV-01]
tech-stack:
  added: []
  patterns: [single normalized proposal union, peer-equivalent pre-construction authorization]
key-files:
  created: []
  modified:
    - src/engine/group-engine.ts
    - src/engine/__tests__/send-commit-legality.test.ts
key-decisions:
  - "Keep unapplied proposals as MLS references and add only true caller/coupled proposals by value."
  - "Run createAdminCommitPolicyCallback over the normalized proposal-with-sender union before createCommit."
patterns-established:
  - "Outbound commit preparation resolves authorization, coupling, construction inputs, and legality evidence from one proposal union."
requirements-completed: [CONV-01, WIRE-03]
coverage:
  - id: D1
    description: "commit and selfUpdate authorize the exact proposal union before MLS construction"
    requirement: CONV-01
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#outbound exact-union actor authorization matrix"
        status: pass
    human_judgment: false
  - id: D2
    description: "WIRE-03 and CONV-01 post-create legality consume the same normalized union"
    requirement: WIRE-03
    verification:
      - kind: integration
        ref: "pnpm vitest run src/engine/__tests__/send-commit-legality.test.ts src/engine/__tests__/commit-legality-seams.test.ts src/core/components/__tests__/integrity.test.ts"
        status: pass
    human_judgment: false
metrics:
  duration: 4min
  completed: 2026-09-01
status: complete
---

# Phase 03 Plan 11: Exact-Union Outbound Authorization Summary

**Local commit and self-update construction now applies peer-equivalent actor authorization to one exact, identity-preserving proposal union before MLS staging.**

## Performance

- **Duration:** 4 minutes
- **Started:** 2026-09-01T21:35:37Z
- **Completed:** 2026-09-01T21:38:39Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Unified commit and selfUpdate preparation behind one exact-union helper covering implicit references, caller by-value proposals, and D-05 auto-coupled policy updates.
- Reused the inbound admin callback before `createCommit`, preventing non-admin local authorship of peer-rejected admin-only commits.
- Stopped copying selected references into `extraProposals`, preserving proposal identity and preventing double application.
- Added a 20-test outbound suite and passed 47 focused legality tests across send, inbound/replay, and pure validation seams.

## Task Commits

1. **Task 1 RED: Add failing self-update authorization regression** - `7bd9de9`
2. **Task 1 GREEN: Authorize self-update proposal union** - `dd1c685`
3. **Task 2: Complete outbound authorization matrix** - `49e646d`

## Verification Evidence

| Command | Result |
| --- | --- |
| `pnpm vitest run src/engine/__tests__/send-commit-legality.test.ts` | PASS — 20/20 tests |
| `pnpm vitest run src/engine/__tests__/send-commit-legality.test.ts src/engine/__tests__/commit-legality-seams.test.ts src/core/components/__tests__/integrity.test.ts` | PASS — 47/47 tests |
| `pnpm build` | PASS |
| `sha256sum -c /tmp/marmot-ts-phase-03-pnpm-lock.sha256` after every pnpm command | PASS — `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` |

## Decisions Made

- Selected proposal references are validation selectors only; ts-mls already commits every unapplied proposal by reference, so selected entries must not also enter `extraProposals` by value.
- Actor identity must match the engine's local private leaf before authorization, preventing caller-supplied `actorPubkey` from misrepresenting the actual committer.
- The existing inbound authorization callback remains the single policy authority; outbound preparation supplies it the exact proposal-with-sender union rather than duplicating its rules.

## Deviations from Plan

None - plan executed exactly as written.

## Authentication Gates

None.

## Known Stubs

None.

## Issues Encountered

- The first build exposed an unused legacy `selfRemoveProposalType` import and a branded `LeafIndex` type mismatch introduced by the refactor. Both were corrected before Task 2 completion; the focused suites and build then passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 3's outbound authorization gap is closed across both commit-producing intents.
- WIRE-03 and CONV-01 remain green across send, inbound/replay, and pure legality suites.
- No stubs, skipped tests, unrun verification, or new security-relevant surface remain.

## Self-Check: PASSED

- Both modified files exist.
- Task commits `7bd9de9`, `dd1c685`, and `49e646d` exist in Git history.
- All task acceptance criteria and plan-level verification commands passed.
- The authoritative `pnpm-lock.yaml` remained byte-for-byte unchanged.

---

_Phase: 03-commit-integrity-convergence-parity_
_Completed: 2026-09-01_
