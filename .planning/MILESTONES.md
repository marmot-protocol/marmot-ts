# Milestones

## v1.0 Catchup (Shipped: 2026-09-11)

**Delivered:** marmot-ts resynced to the post-split marmot spec and MDK Rust reference —
closing every catalogued interop-breaker and reaching byte-exact parity on the wire surfaces
that have a Rust counterpart.

**Phases completed:** 7 phases (5 planned + 03.1, 04.1 inserted), 53 plans, 113 tasks
**Timeline:** 2026-07-01 → 2026-09-06 (last phase), closed 2026-09-11
**Git:** 460 commits; `src/` 124 files changed, +20,701 / −751; ~54k LOC TypeScript under `src/`
**Requirements:** 16/16 v1 requirements satisfied
**Closeout:** verified_closeout — all 7 phases verification `passed`; no milestone audit was run
(user chose to proceed). The one pending todo (`groupsmanager-rejectedevents-dos`) was already
fixed in code and moved to `todos/done/`.

**Key accomplishments:**

- **Proof v2** — account-identity-proof signs the canonical kind-450 event id; pinned Rust-signed → TS-verified fixture (PROOF-01)
- **Inbound trust & wire boundary** — verify-before-trust on 445/1059/30443, 84-day KeyPackage lifetime cap, #236 required-tag cardinality (SEC-01, WIRE-01, WIRE-02)
- **Commit integrity & convergence parity** — one `validateCommitLegality` adapter across send, inbound, pool-replay, and tree-fed paths; durable SelfEvicted removal; digest-attributed notifications withdrawn on rewind; 30 review findings closed in inserted Phase 03.1 (WIRE-03, CONV-01..04)
- **Structural own-commit convergence** — ported MDK's `OwnCommitConvergenceStamp`, missing-parent deferral inside the rollback horizon, bounded monotonic convergence passes, SafeAAD leaf advertisement (WIRE-04)
- **Terminal group disbanding** — `marmot.group.lifecycle.v1` codec and an absorbing, durable, canonically-selected `disbanded` state (LIFE-01, LIFE-02, CONV-05)
- **Conformance & quality gate** — MDK scenario vectors as an automated parity harness, six-runtime CI matrix, four byte-exact Rust/TS parity dossiers bound to one tested source SHA (CONF-01, QA-01, QA-02)

**Archives:** `milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`, `milestones/v1.0-phases/`

---
