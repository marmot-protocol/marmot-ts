# Phase 1: Exhaustive Gap Audit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-01
**Phase:** 1-Exhaustive Gap Audit
**Areas discussed:** Verification rigor, Document structure, Req/roadmap reconciliation, Audit execution strategy

---

## Verification rigor

| Option | Description | Selected |
|--------|-------------|----------|
| Code-reading + file:line | Each finding cites source file:line + spec section + Rust ref; verdicts from reading. Red-proof tests deferred to closure phases. Pure read-only audit. | ✓ |
| Hybrid: tests for BLOCKER/sec | Code-evidence for all; BLOCKER + security findings additionally require a reproducing test/Rust vector. | |
| Failing-test for every gap | Every confirmed gap ships a red test before it counts. Maximally rigorous, heaviest. | |

**User's choice:** Code-reading + file:line
**Notes:** Keeps Phase 1 a read-only document deliverable; proof work belongs in closure Phases 2–3.

---

## Document structure

| Option | Description | Selected |
|--------|-------------|----------|
| By spec area, dependency order | foundation → protocol-core → app-components → transports → features; each finding tagged severity + req ID + file:line + symbol + spec section. Deferred + Completed-baseline sections. | ✓ |
| By severity (keep current shape) | Retain Completed baseline / BLOCKER / MAJOR / MINOR / TRACK, upgraded with file:line + symbol. | |
| By requirement ID | Organize around AUDIT/MEDIA/CONV/WIRE/… IDs for 1:1 Phase 2–3 mapping. | |

**User's choice:** By spec area, dependency order
**Notes:** Mirrors the audit walk and satisfies "cover all seven spec areas in dependency order." symbol name added alongside file:line for line-drift stability. NOTE: this structure now applies to the phase artifact `01-AUDIT.md`, not `SPEC_GAP_REVIEW.md` (see reconciliation).

---

## Req/roadmap reconciliation

| Option | Description | Selected |
|--------|-------------|----------|
| Gap doc + delta section only | Verdicts + 'Requirement deltas' section in SPEC_GAP_REVIEW.md; REQUIREMENTS/ROADMAP reconciled later via /gsd-transition. | |
| Edit planning docs inline | Audit edits REQUIREMENTS.md/ROADMAP.md directly. | |
| **(free text)** Standard GSD approach — remove SPEC_GAP_REVIEW.md | User reframed: delete the bespoke root doc; use standard GSD artifacts instead. | ✓ |

**User's choice:** Free-text — "Let's go with a standard GSD approach, my goal is to remove the SPEC_GAP_REVIEW.md document"

**Follow-up (Output location):**
| Option | Description | Selected |
|--------|-------------|----------|
| Phase AUDIT artifact + fold into planning | Full catalog in `.planning/phases/01-.../01-AUDIT.md`; confirmed single-device gaps fold into REQUIREMENTS.md + ROADMAP.md Phases 2–3. SPEC_GAP_REVIEW.md deleted. | ✓ |
| Fold straight into REQUIREMENTS/ROADMAP only | No standalone catalog; raw evidence in RESEARCH/verification notes. | |

**Follow-up (Reference fixup):**
| Option | Description | Selected |
|--------|-------------|----------|
| Update refs to point at GSD planning | Repoint all SPEC_GAP_REVIEW.md references. | |
| Remove refs entirely | Delete the mentions from example READMEs / PROJECT.md. | ✓ |
| Leave refs, decide later | Defer dangling-reference cleanup. | |

**Notes:** Deliverable reframed from "rewrite SPEC_GAP_REVIEW.md" (AUDIT-02 / Phase 1 SC#1) to "verified audit artifact + folded planning + doc deleted." Reference sites found: `examples/opentui/README.md`, `.planning/PROJECT.md` (+ planning docs handled during fold).

---

## Audit execution strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Parallel fan-out + triage new feats | Sub-agent/workflow per spec area, adversarially cross-checked vs Rust; single-device post-June features → active gaps; multi-device/push/QUIC → deferred. | ✓ |
| Fan-out, freeze scope | Same walk, but all newly-surfaced features cataloged as deferred; only pre-flagged set stays active. | |
| Sequential single-pass | One reader, all areas in order, no fan-out. | |

**User's choice:** Parallel fan-out + triage new feats
**Notes:** rename-events #726 is the archetype single-device candidate to pull in; push-token #725 and multi-device chat-list #766 semantics → deferred catalog.

---

## Claude's Discretion

- Exact MAJOR/MINOR severity thresholds per finding.
- Depth of deferred-catalog entries (name + reason minimum).
- Fan-out mechanism (Workflow tool vs. spawned Agents) — planner/executor choice.
- Cross-runtime audit scope (runtime-agnostic code → single verdict set).

## Deferred Ideas

- Multi-device (MIP-06), push (MIP-05 / #725), QUIC data-plane, chat-list multi-device semantics (#766) — catalog + defer.
- blossom-image (0x8002) codec implementation — documented unsupported (DOC-01), not built.
- Red-proof tests for confirmed gaps — deferred to closure Phases 2–3.
