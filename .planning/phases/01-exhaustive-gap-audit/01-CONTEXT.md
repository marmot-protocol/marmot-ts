# Phase 1: Exhaustive Gap Audit - Context

**Gathered:** 2026-07-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Produce a **verified, classified single-device gap catalog** of the marmot-ts TypeScript
implementation against the *latest* darkmatter spec + Rust reference (submodule at
`c9d63de`, 59 commits ahead of the stale 2026-06-19 snapshot). Walk all seven spec areas
in dependency order, confirm every finding present-or-absent in code with evidence, and
drive that catalog into the **standard GSD planning artifacts** so Phases 2–3 are
requirement-driven.

**This phase writes documents and planning artifacts only — no protocol/source code
changes.** Closing the gaps is Phases 2–3; new capabilities belong in their own phases.

</domain>

<decisions>
## Implementation Decisions

### Deliverable shape (reframed from the roadmap wording)
- **D-01:** **Delete `SPEC_GAP_REVIEW.md`.** The bespoke repo-root backlog doc is retired,
  not rewritten. This supersedes the AUDIT-02 / Phase 1 Success-Criterion-#1 wording that
  says "rewrite SPEC_GAP_REVIEW.md" — the audit is authoritative and reshapes that item
  (see Requirement Deltas below).
- **D-02:** The full verified catalog lives as a **phase artifact**:
  `.planning/phases/01-exhaustive-gap-audit/01-AUDIT.md`. This is the durable, evidence-rich
  record of every finding (verdict + `file:line` + symbol + spec section + severity +
  Rust cross-ref).
- **D-03:** Confirmed **single-device** gaps then **fold into `REQUIREMENTS.md` +
  `ROADMAP.md` Phases 2–3** so closure work is driven by standard GSD requirements — not by
  a side document. Deferred items are recorded in `01-AUDIT.md`'s deferred catalog only.

### Verification rigor
- **D-04:** **Read-only audit.** Each finding must cite **source `file:line` + governing
  spec section + Rust reference location**. Verdicts come from reading code/spec/Rust.
- **D-05:** **Red-proof tests are deferred to the closure phases (2–3)**, not written in
  Phase 1. Phase 1 does not have to make the suite red or green; it produces evidence and
  classification. (Aligns with Success Criteria wording: "confirmed present-or-absent verdict
  in code plus classification.")

### Catalog structure (`01-AUDIT.md`)
- **D-06:** **Organized by spec area in dependency order**: foundation → protocol-core →
  app-components → transports → features. This mirrors the audit walk and satisfies
  Success-Criterion coverage of "all seven spec areas in dependency order."
- **D-07:** **Each finding is tagged** with: severity (`BLOCKER` / `MAJOR` / `MINOR` /
  `deferred`), requirement ID (existing AUDIT/MEDIA/CONV/WIRE/SEC/API/CONF/DOC ID or a new
  proposed ID), `file:line` **plus symbol name** (symbol is stable against line-drift),
  governing spec section, and Rust cross-reference where a byte-exact counterpart exists.
- **D-08:** Include a **Deferred catalog** section (MIP-06, MIP-05, QUIC data-plane +
  anything triaged out) and carry forward the **Completed-baseline** record so closed items
  are not reopened.

### Audit execution strategy
- **D-09:** **Parallel fan-out per spec area**, findings **adversarially cross-checked
  against the Rust reference** (`darkmatter/crates/`). Not a single sequential read.
- **D-10:** **Triage the 59 post-June darkmatter commits.** Clearly single-device features
  (e.g. rename-events #726) become **active gaps** and fold into Phases 2–3; multi-device
  (#725 push-token gossip, MIP-06), push (MIP-05), chat-list left-vs-removed semantics that
  are multi-device, and QUIC data-plane → **deferred catalog with reason**.

### Reference fixup (part of the deliverable)
- **D-11:** **Remove all `SPEC_GAP_REVIEW.md` references entirely** (do not repoint them).
  Known reference sites to clean: `examples/opentui/README.md`, `.planning/PROJECT.md`
  context note. Planning-doc references (`ROADMAP.md`, `REQUIREMENTS.md`, `research/*`,
  `codebase/CONCERNS.md`) are handled as part of the fold/reconcile, not left dangling.

### Requirement Deltas (audit output → GSD reconciliation)
- **D-12:** The audit records a **Requirement Deltas** section (in `01-AUDIT.md`) covering:
  already-closed pre-flagged items, newly-discovered single-device gaps (new proposed IDs),
  and retirements (e.g. WIRE-03 NIP-40 expiration / WIRE-04 routing-rotation are
  "pending audit confirmation" and may be closed-as-not-applicable). These deltas are what
  gets folded into `REQUIREMENTS.md` + `ROADMAP.md`; the AUDIT-02 wording is updated from
  "rewritten SPEC_GAP_REVIEW.md" to "verified audit artifact + folded planning."

### Claude's Discretion
- Exact severity-threshold boundaries between MAJOR and MINOR per finding.
- Depth of the deferred catalog entries (name + reason minimum; add byte-level delta only
  where cheap and useful for the future milestone).
- Whether the fan-out uses the Workflow tool vs. spawned Agents — planner/executor choice.
- Cross-runtime scope of the read-only audit (the code is runtime-agnostic; verdicts are
  the same across runtimes — no per-runtime audit needed in Phase 1).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (source of truth for wire format)
- `darkmatter/spec/foundation/` — foundational protocol definitions (audit area 1)
- `darkmatter/spec/protocol-core/` — core Marmot/MLS-over-Nostr protocol (audit area 2)
- `darkmatter/spec/app-components/` — app component codecs incl.
  `group-blossom-image-v1.md`, avatar-url, agent-text-stream (audit area 3)
- `darkmatter/spec/transports/` — transport bindings, QUIC/VarInt profile (audit area 4)
- `darkmatter/spec/features/` — feature specs incl. `encrypted-media.md`,
  `retained-history.md` (audit area 5)

### Rust reference (byte-exact cross-check)
- `darkmatter/crates/` — the Rust darkmatter reference implementation; the adversarial
  cross-check target for every confirmed finding (e.g. `cgka-engine/src/convergence.rs`,
  `canonicalization.rs` were used for the m5 verdict)
- darkmatter submodule at `c9d63de` (`marmotkit-v0.2.0-59-gc9d63de`) — audit MUST scan the
  59 post-June commits (#725, #726, #766, …) for new single-device requirements

### Planning + existing catalog
- `SPEC_GAP_REVIEW.md` (repo root) — the **stale 2026-06-19 snapshot being deleted**; read
  it once to carry forward the Completed-baseline record and the open items (M9, m3, m7, m8,
  m9), then remove it
- `.planning/REQUIREMENTS.md` — the pre-flagged closure item set the audit confirms /
  splits / retires
- `.planning/ROADMAP.md` — phase structure the confirmed gaps fold into
- `.planning/PROJECT.md` — milestone scope, constraints, out-of-scope table

### Codebase maps (orient the read)
- `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `STACK.md`, `CONVENTIONS.md`,
  `CONCERNS.md`, `INTEGRATIONS.md`, `TESTING.md` — layer map (utils ← core ← engine ←
  client), file layout, and known concerns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Existing codebase maps under `.planning/codebase/` — use to select which `src/` modules
  map to each spec area rather than re-deriving the layout.
- The Completed-baseline section of `SPEC_GAP_REVIEW.md` already records B1–B7, M1–M8,
  m1–m6 verdicts with evidence — carry these forward rather than re-auditing.

### Established Patterns
- Layer boundary is strict: `utils ← core ← engine ← client`. Wire/codec gaps live in
  `src/core/`; convergence/retention gaps in `src/engine/`; validation-order gaps span
  `src/client/` ingest + `src/core/`.
- Findings cite **symbol name alongside `file:line`** because the codebase convention favors
  module-level stability (line numbers drift; the retired doc deliberately avoided line refs).

### Integration Points
- Audit output integrates with GSD: `01-AUDIT.md` (evidence) → `REQUIREMENTS.md` +
  `ROADMAP.md` (folded confirmed gaps) → Phase 2/3 plans (closure).

</code_context>

<specifics>
## Specific Ideas

- User's explicit goal: **"remove the SPEC_GAP_REVIEW.md document"** and use the standard GSD
  approach — audit findings become GSD requirements/phases + a phase artifact, not a bespoke
  root-level backlog.
- Post-June darkmatter commits called out by name to triage: rename-events **#726**,
  chat-list left-vs-removed **#766**, push-token gossip **#725**.
- Seven candidate likely-gaps the audit must resolve with evidence (from ROADMAP SC#3):
  NIP-40 expiration, routing-rotation subscription, QUIC VarInt canonicality, convergence
  apply-gating, `isCommitMessage` wireformat, kind-30443 tag validation, kind-1210
  attribution.

</specifics>

<deferred>
## Deferred Ideas

- **Multi-device (MIP-06)** — ext 0xf2f0, External-Commit carve-out, join-PSK, pairing.
  Catalog + defer (spec bytes currently non-normative). → future milestone.
- **Push notifications (MIP-05 / #725)** — owner-authenticated push-token gossip. Catalog +
  defer. → future milestone.
- **QUIC data-plane (agent text streams)** — durable 0x8006 policy codec done; data plane
  deliberately absent. Catalog + defer.
- **blossom-image (0x8002) codec implementation** — documented as unsupported (DOC-01, Phase
  3), not implemented; Rust routes to avatar-url 0x8007.
- **Writing red-proof tests for confirmed gaps** — deferred to closure Phases 2–3 (D-05).

None of these are new scope for this phase — all are catalog-and-defer.

</deferred>

---

*Phase: 1-Exhaustive Gap Audit*
*Context gathered: 2026-07-01*
