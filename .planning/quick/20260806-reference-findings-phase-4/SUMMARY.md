---
quick_id: 260806-dza
slug: reference-findings-phase-4
date: 2026-08-06
status: complete
type: docs
files_changed: 4
source_changes: 0
---

# Summary: Roll reference-submodule findings into Phase 4

## What changed

| File | Change |
| --- | --- |
| `.planning/ROADMAP.md` | Phase 4 goal extended; success criteria 5–8 added; Phase 3 line records that CR-08/CR-11 moved to Phase 4 |
| `.planning/phases/04-feature-parity-conformance-vectors/04-REFERENCE-FINDINGS.md` | New — full findings with `refs/` file:line citations |
| `AGENTS.md` (via the `CLAUDE.md` symlink) | New "Reference Submodules" section: per-phase upstream check, check-MDK-first rule, MIP-deprecation note |
| `.planning/STATE.md` | Quick Tasks Completed row |

No source files touched.

## Decisions recorded

1. **CR-08/CR-11 move from Phase 3 to Phase 4** and are fixed structurally by porting MDK's
   `OwnCommitConvergenceStamp` — recording an own commit's committer, authorization-aware
   ordering priority, and consumed proposal refs at confirm time — rather than by a fourth
   incremental patch to reconstruction logic in `fork-recovery.ts`. Three review rounds
   (7 → 4 → 5 findings) failed to close this class incrementally; the Rust reference does not
   have the defect because it does not reconstruct.

2. **Phase 3's remaining scope is its local findings only**: CR-12, CR-13, CR-14, the round-1
   carry-forwards, and WR-24's stale MIP citations. Whether Phase 3 closes before Phase 4
   begins was deliberately left open.

3. **The reference sweep becomes a standing per-phase step**, not a one-off. It is written
   into `AGENTS.md` so every agent sees it, with the 2026-08-06 near-miss as the rationale.

## Verification

- `pnpm lint` clean (prettier ignores `.planning/`; this guards the `AGENTS.md` edit).
- `CLAUDE.md` is a symlink to `AGENTS.md`; the real target was edited.
- All `refs/` citations resolve at the pinned submodule commits (`refs/marmot` @ `4ad4ae2`,
  `refs/mdk` @ `790eb86`, bumped in `d8ab0ac`).

## Follow-ups not actioned

- Phase 4 plans are still `TBD` — criteria 5–8 need breaking into plans.
- `DEFAULT_CONVERGENCE_POLICY` has not been checked against the new
  `max_convergence_pass_ms: 5000` field.
- The convergence anti-starvation rule, scheduler gating during `PendingPublish`/`Merging`,
  and terminal `disbanded` lifecycle are unimplemented and unassigned to any phase.
- `account-identity-proof-v2.md` moved to `app-components/` and grew; Phase 1's shipped
  implementation has not been re-checked against it.
