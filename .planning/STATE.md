---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: Phase 1)
current_phase: 01
current_phase_name: proof-v2
status: executing
stopped_at: ROADMAP.md, STATE.md, and REQUIREMENTS.md traceability written for milestone v1.0 catchup; awaiting `/gsd-plan-phase 1`
last_updated: "2026-07-21T14:15:59.509Z"
last_activity: 2026-07-21
last_activity_desc: Phase 01 execution started
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 2
  completed_plans: 1
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-21)

**Core value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte, with any spec-conformant peer (incl. the Rust MDK reference), across every supported runtime.
**Current focus:** Phase 01 — proof-v2

## Current Position

Phase: 01 (proof-v2) — EXECUTING
Plan: 2 of 2
Status: Ready to execute
Last activity: 2026-07-21 — Phase 01 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: —
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
| ----- | ----- | ----- | -------- |
| -     | -     | -     | -        |

**Recent Trend:**

- Last 5 plans: —
- Trend: —

_Updated after each plan completion_
| Phase 01-proof-v2 P01 | 15min | 3 tasks | 3 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Prior v1.0 phases (Exhaustive Gap Audit → Blocker & Security Closure → Wire/Conformance & Docs → Quality Gate) were shelved to the backlog (999.3–999.6); v1.0 was repurposed as "catchup" and the phase sequence restarted at Phase 1
- Catchup review is done (`.planning/research/SUMMARY.md` + PROOF-V2/SPEC-DELTAS/MDK-INTEROP); roadmap derived directly from its 13 v1 requirements — interop-breakers close first (Phase 1–2), then commit-integrity/convergence parity (Phase 3, CONV-04 verify-first), then feature parity + MDK vectors (Phase 4), then the quality gate (Phase 5)
- REQUIREMENTS.md traceability footer corrected from "12 total" to "13 total" — the itemized requirement list (PROOF-01, SEC-01, WIRE-01..04, CONV-01..04, CONF-01, QA-01, QA-02) was always 13; the summary count was a stale undercount
- [Phase 01]: Widened AccountIdentityProofSigner to a union (plain digest function | { signEvent } object) to preserve raw-key compatibility while adding external-signer parity for account-identity-proof v2
- [Phase 01]: mlsSignatureScheme() table already matched Rust ciphersuite.signature_algorithm() as u16 for all 7 ciphersuites; only decimal annotations added

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1 (Proof v2) has no shared MDK byte fixture to check against — the round-trip test must be built fresh (Rust-signed → TS-verified), per PROOF-V2.md
- Phase 3's CONV-04 is verify-first: run marmot-ts against MDK's own-confirmed-commit scenario vectors before writing any fix; only diverge-and-fix if the vectors actually fail
- Open question carried from SUMMARY.md: confirm marmot-ts `mlsSignatureScheme()` decimal values match Rust `ciphersuite.signature_algorithm() as u16` for every supported ciphersuite (Phase 1)
- Open question carried from SUMMARY.md: decide whether `AccountIdentityProofSigner` stays digest-only or is reshaped to "sign a Nostr event" for true external-signer parity (Phase 1, recommended but not required for minimal interop)

## Deferred Items

| Category        | Item                                                                | Status       | Deferred At     |
| --------------- | ------------------------------------------------------------------- | ------------ | --------------- |
| Multi-device    | MIP-06 (ext 0xf2f0, External-Commit, join-PSK, pairing payload)     | Catalog only | Milestone scope |
| Push            | MIP-05 (push-token gossip, #725)                                    | Catalog only | Milestone scope |
| QUIC data plane | Agent text-stream data plane, transport-quic-*                      | Not in scope | Milestone scope |
| App/tooling     | marmot-app, cli, uniffi, forensics, storage backends                | Not in scope | Milestone scope |
| Media           | encrypted-media/Blossom changes (mdk #852)                          | Not in scope | Milestone scope |
| Backlog (999.x) | Group image support, docs review, shelved v1.0 audit/closure phases | Backlog      | Prior milestone |

## Session Continuity

Last session: 2026-07-21T14:14:11.441Z
Stopped at: ROADMAP.md, STATE.md, and REQUIREMENTS.md traceability written for milestone v1.0 catchup; awaiting `/gsd-plan-phase 1`
Resume file: None
