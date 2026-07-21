# Shelved: Exhaustive Gap Audit (was Phase 1 of milestone v1.0)

**Shelved:** 2026-07-21 — moved to backlog when milestone v1.0 was reset in favor of a different milestone.
**Original position:** Phase 1 of 4 (dark-matter single-device wire-complete).
**Depends on:** Nothing (was the first phase; the closure phases 999.4/999.5/999.6 depend on this).
**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03
**Prior work preserved:** `01-CONTEXT.md`, `01-DISCUSSION-LOG.md` (context gathered + discussion completed; no plans were written).

## Goal

A rewritten, verified `SPEC_GAP_REVIEW.md` supersedes the stale June 2026 snapshot and becomes
the authoritative closure backlog for the closure phases.

## Success Criteria

1. SPEC_GAP_REVIEW.md is rewritten with every confirmed gap pointing to source `file:line` and
   governing spec section (audit covers all seven spec areas in dependency order).
2. Every finding carries a confirmed present-or-absent verdict in code plus a classification:
   BLOCKER / MAJOR / MINOR / deferred.
3. All seven candidate likely gaps (NIP-40 expiration, routing-rotation subscription, QUIC VarInt
   canonicality, convergence apply-gating, `isCommitMessage` wireformat, kind-30443 tag validation,
   kind-1210 attribution) are either confirmed with evidence or closed with code evidence.
4. Multi-device (MIP-06), push (MIP-05), and QUIC data-plane surface is cataloged with explicit
   deferred disposition and the reason.

## To resume

`/gsd-review-backlog` to promote back into an active milestone, or `/gsd-discuss-phase 999.3`.
