---
quick_id: 260806-dza
slug: reference-findings-phase-4
date: 2026-08-06
type: docs
---

# Quick Task: Roll reference-submodule findings into Phase 4

## Why

`refs/marmot` and `refs/mdk` were fast-forwarded on 2026-08-06 (`d8ab0ac`): marmot
`7f2f5fa -> 4ad4ae2` (4 commits), mdk `3628ccc -> 790eb86` (193 commits). Reading the
deltas turned up material that changes the remaining v1.0 plan — most importantly that
the Rust reference already solves, structurally, the defect class three rounds of Phase 3
code review failed to close incrementally (CR-08 / CR-11).

Capture that before it decays, and make the reference sweep a standing per-phase step so
the next 193-commit gap is not discovered by accident.

## Scope

Docs only. No source changes.

1. **`.planning/ROADMAP.md`** — extend Phase 4's goal and success criteria to cover:
   - porting MDK's `OwnCommitConvergenceStamp` (record-at-confirm-time instead of
     reconstruct-at-recovery-time), which closes CR-08 and CR-11 structurally;
   - the `restart-delivery-faults.v1.json` vector, which covers the persist -> reload ->
     converge gap that let CR-08 and CR-09 through;
   - `foundation/conformance.md`'s canonical snapshot as the cross-impl oracle.
   Also note on the Phase 3 line that the CR-08/CR-11 structural fix has moved to Phase 4.

2. **`.planning/phases/04-feature-parity-conformance-vectors/04-REFERENCE-FINDINGS.md`** —
   new; the full detail with file:line citations into `refs/`.

3. **`CLAUDE.md`** — standing instruction to check `refs/marmot` and `refs/mdk` for
   upstream changes at the start of each phase.

## Out of scope

- Any source change. Phase 3's remaining local findings (CR-12, CR-13, CR-14, WR-*) stay
  in Phase 3 and are untouched here.
- Deciding whether Phase 3 closes before Phase 4 begins.

## Verification

- `pnpm lint` clean (prettier ignores `.planning/`, so this only guards `CLAUDE.md`).
- ROADMAP Phase 4 success criteria remain independently checkable statements of fact.
- Every `refs/` citation in REFERENCE-FINDINGS.md resolves at the pinned submodule commits.
