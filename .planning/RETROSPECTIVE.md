# Project Retrospective

_A living document updated after each milestone. Lessons feed forward into future planning._

## Milestone: v1.0 — Catchup

**Shipped:** 2026-09-11
**Phases:** 7 (5 planned + 2 inserted) | **Plans:** 53 | **Sessions:** not tracked

### What Was Built

- Account-identity-proof v2 with a Rust-signed → TS-verified fixture (Phase 1)
- Verify-before-trust inbound boundary, 84-day KeyPackage lifetime cap, #236 tag cardinality (Phase 2)
- Commit-legality validators (app-component integrity, admin/leaf coupling) on send, inbound, and fork-recovery seams; SelfEvicted and digest-attributed rewind-withdrawable notifications (Phases 3, 03.1)
- Confirm-time own-commit convergence stamp ported from MDK, missing-parent deferral, bounded convergence passes, SafeAAD advertisement, MDK scenario vectors as a parity harness (Phase 4)
- `marmot.group.lifecycle.v1` with an absorbing, durable `disbanded` terminal state (Phase 04.1)
- Six-runtime CI matrix and four byte-exact Rust/TS parity dossiers bound to one tested source SHA (Phase 5)

### What Worked

- Ordering by severity: interop-breakers (Phases 1–2) closed quickly in small plans before the larger convergence work
- Verify-first requirements (CONV-04) surfaced a real defect rather than assuming parity
- Checking how MDK solved a problem before hand-rolling a fix: porting `OwnCommitConvergenceStamp` closed a defect class structurally
- Converting open review findings into a planned, verified insertion phase (03.1) instead of another ad-hoc fix round

### What Was Inefficient

- Phase 3 went through three code-review rounds, each finding blockers in the previous round's fixes (7 → 4 → 5) before the work was replanned
- The `refs/` submodules drifted 4 and 193 commits behind before the 2026-08-06 sweep caught it, which late-added lifecycle-v1 scope (Phase 04.1)
- Planning bookkeeping drifted: stale "Gaps Found" traceability rows and a pending todo that had already been fixed in code were only caught at milestone close
- No milestone audit was run before close

### Patterns Established

- Standing per-phase upstream check of `refs/marmot` and `refs/mdk`, recorded as its own `chore(refs):` commit
- Diverging from the Rust reference is a recorded decision, not a default
- Byte-exact parity claims are backed by immutable, machine-validated dossiers pinned to a tested source SHA
- Restart/persist → reload → converge scenarios get automated vectors, not just in-memory tests

### Key Lessons

1. When incremental review fixes keep regressing, stop patching and look for the structural solution — often already in the reference implementation.
2. Refresh upstream references at the start of every phase, not only at milestone start.
3. Close todos and traceability rows in the same commit as the fix, so milestone close doesn't depend on archaeology.

### Cost Observations

- Model mix: not tracked
- Sessions: not tracked
- Notable: most plans ran 3–15 minutes; outliers were Phase 3 convergence work (45–95 min) and the 03-08 reference-materialization plan (~6h)

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions    | Phases | Key Change                                                       |
| --------- | ----------- | ------ | ---------------------------------------------------------------- |
| v1.0      | not tracked | 7      | Per-phase reference checks; review findings closed as a planned phase |

### Cumulative Quality

| Milestone | Tests        | Coverage     | Zero-Dep Additions |
| --------- | ------------ | ------------ | ------------------ |
| v1.0      | not recorded | not recorded | —                  |

### Top Lessons (Verified Across Milestones)

1. _(needs a second milestone to cross-validate)_
