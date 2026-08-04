---
phase: 03-commit-integrity-convergence-parity
plan: 02
subsystem: engine
tags: [mls, convergence, ingest, notifications, typescript]

# Dependency graph
requires:
  - phase: 03-commit-integrity-convergence-parity (plan 01)
    provides: validateAppComponentIntegrity, validateAdminLeafCoupling, validateCommitLegality, collectAppDataUpdateOps (src/core/components/integrity.ts)
provides:
  - Widened RejectedIngestResult.reason (admin-policy | component-integrity | admin-leaf-coupling) — D-03
  - "self-evicted" SkippedIngestResult.reason with optional message — D-13
  - SelfEvicted -> inputCategories.staleEpoch in convergenceOutcomeToCategory — D-13
  - Optional notifications field on ProcessedIngestResult/RemovedIngestResult — D-10/D-12
  - Envelope-less StateInvalidatedIngestResult union member — D-11
  - StateNotification discriminated union + StateNotificationLedger (commit-digest-keyed) — D-10/D-11
  - Engine (group-engine.ts) and client (group-session.ts) exhaustive switches updated for the new variant/reasons
affects: [03-03, 03-04, 03-05, 03-06, 03-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Commit-digest-keyed bounded ledger (StateNotificationLedger), a structural sibling of DeliveredPayloadLedger but keyed by hex commitDigest instead of a delivery-state confirmation tag"
    - "Additive optional-field widening (reason?, notifications?, message?) on existing discriminated-union members instead of new top-level IngestResult kinds, preserving the kind <-> Disposition exhaustive-switch invariant"

key-files:
  created:
    - src/engine/state-notifications.ts
    - src/engine/__tests__/state-notifications.test.ts
  modified:
    - src/core/inbound.ts
    - src/engine/types.ts
    - src/engine/ingest-disposition.ts
    - src/engine/index.ts
    - src/engine/group-engine.ts
    - src/client/session/group-session.ts

key-decisions:
  - "RejectedIngestResult.reason declared as an inline literal union rather than importing the type from src/core/components/integrity.ts, per the plan's instruction to keep this types-and-plumbing plan independent of the sibling validation plan"
  - "StateInvalidatedIngestResult carries no envelope/event field; group-engine.ts's #emitIngestOutcome (audit emission) guards on this kind and returns early rather than fabricating a msg_id, since audit wiring for this variant is deferred to the seam-wiring plan that actually produces it"

patterns-established:
  - "StateNotificationLedger: record/invalidatedByRewind/pruneBelow keyed by hex commitDigest, for later CONV-02/CONV-03 wiring plans to attribute and withdraw notifications per commit"

requirements-completed: [WIRE-03, CONV-01, CONV-02, CONV-03]

coverage:
  - id: D1
    description: "IngestResult vocabulary widened for D-03 (RejectedIngestResult.reason) and D-13 (self-evicted skip reason, optional message, SelfEvicted convergence outcome), with ingestResultDisposition kept exhaustive"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "pnpm vitest run src/core"
        status: pass
      - kind: other
        ref: "pnpm compile"
        status: pass
    human_judgment: false
  - id: D2
    description: "StateNotification discriminated union + StateNotificationLedger (commit-digest-keyed bounded ledger with record/invalidatedByRewind/pruneBelow) exported through the engine barrel"
    requirement: "CONV-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notifications.test.ts (7 tests, all kinds)"
        status: pass
    human_judgment: false
  - id: D3
    description: "StateInvalidatedIngestResult added to IngestResult union and wired through every exhaustive switch in group-engine.ts and group-session.ts (client mirror), with the full pre-existing test suite still green"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "pnpm vitest run (674/675 pass; 1 pre-existing unrelated failure, see Deviations)"
        status: pass
      - kind: other
        ref: "pnpm compile"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-08-04
status: complete
---

# Phase 03 Plan 02: Widened Inbound Vocabulary + State Notification Model Summary

**Widened `IngestResult` (D-03 rejection reasons, D-13 self-evicted skip) and added a commit-digest-attributed `StateNotification`/`StateNotificationLedger` model plus the envelope-less `stateInvalidated` result variant, keeping every exhaustive `kind`-switch in the engine and client honest.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-08-04T12:15:00Z (approx)
- **Completed:** 2026-08-04T12:23:22Z
- **Tasks:** 3
- **Files modified:** 8 (2 new, 6 modified)

## Accomplishments

- `RejectedIngestResult` now carries an optional `reason?: "admin-policy" | "component-integrity" | "admin-leaf-coupling"` while its protocol-visible category stays `authorization_failed` (D-03)
- `SkippedIngestResult` gained a `"self-evicted"` reason (mapped to `disposition.stale(inputCategories.staleEpoch)`) and its `message` field is now optional so a self-evicted skip needs no peel/decrypt (D-13); `convergenceOutcomeToCategory` gained `SelfEvicted -> inputCategories.staleEpoch`
- New `src/engine/state-notifications.ts`: `StateNotification` (6-variant discriminated union, every variant carrying `commitDigest`) and `StateNotificationLedger` (a `DeliveredPayloadLedger`-shaped, commit-digest-keyed bounded ledger with `record`/`invalidatedByRewind`/`pruneBelow`), exported through the engine barrel
- New envelope-less `StateInvalidatedIngestResult` (`kind: "stateInvalidated"`, `commitDigest`, `forkEpoch`, `withdrawn: StateNotification[]`) added to the `IngestResult` union and to `ingestResultDisposition` (maps to `disposition.invalidated()`)
- Every exhaustive `switch (result.kind)` in `group-engine.ts` (`#isConvergenceRelevant`, `auditStaleReason`, `auditResultEpoch`, `#emitIngestOutcome`) and the client mirror in `group-session.ts` (`ProcessedIngestResult`, `RejectedIngestResult`, `SkippedIngestResult`, `RemovedIngestResult`, new `StateInvalidatedIngestResult`, `mapEngineIngestResult`, `ingestResultDisposition`) now handles the widened union without a `default` clause
- `pnpm compile` is clean and the full pre-existing test suite (674/675) is green

## Task Commits

Each task was committed atomically:

1. **Task 1: Widen the inbound result vocabulary (D-03, D-13) and keep the disposition map exhaustive** - `c33639e` (feat)
2. **Task 2: Add the StateNotification model and its bounded commit-digest ledger (D-10, D-11)** - `0b280f4` (feat)
3. **Task 3: Keep every downstream consumer of the IngestResult union compiling** - `1991ea3` (feat)

## Files Created/Modified

- `src/core/inbound.ts` - Added `SelfEvicted: inputCategories.staleEpoch` to `convergenceOutcomeToCategory`
- `src/engine/types.ts` - Widened `RejectedIngestResult`, `SkippedIngestResult`; added `notifications?` to `ProcessedIngestResult`/`RemovedIngestResult`; added `StateInvalidatedIngestResult` and its union member
- `src/engine/ingest-disposition.ts` - Added `case "self-evicted"` and `case "stateInvalidated"` to the exhaustive dispositioning switches
- `src/engine/state-notifications.ts` - New: `StateNotification` union + `StateNotificationLedger` class
- `src/engine/__tests__/state-notifications.test.ts` - New: 7 tests covering record/rewind-withdrawal/canonical-retention/pruning/selfRemoved
- `src/engine/index.ts` - Barrel export for `./state-notifications.js`
- `src/engine/group-engine.ts` - `#isConvergenceRelevant`, `auditStaleReason`, `auditResultEpoch`, `#emitIngestOutcome` handle `stateInvalidated`
- `src/client/session/group-session.ts` - Mirrors the widened engine vocabulary on client-facing types; `mapEngineIngestResult`/`ingestResultDisposition` pass `stateInvalidated` through unchanged

## Decisions Made

- Declared `RejectedIngestResult.reason` as an inline literal union in `src/engine/types.ts` rather than importing the type from `src/core/components/integrity.ts` (structurally compatible, keeps this plan independent per the plan's explicit instruction)
- `#emitIngestOutcome` in `group-engine.ts` (audit emission, not named in the plan's read list) needed a guard for `stateInvalidated` to keep `pnpm compile` green — it returns early on that kind rather than fabricating an audit `msg_id` from a non-existent envelope; actual audit wiring for this variant is left to the later seam-wiring plan that produces it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Guarded `#emitIngestOutcome` against the new envelope-less `stateInvalidated` variant**
- **Found during:** Task 3 (`pnpm compile`)
- **Issue:** `#emitIngestOutcome(result)` unconditionally reads `result.envelope`, which does not exist on `StateInvalidatedIngestResult`; this is a compile-blocking type error the plan's read-list didn't call out (it only named `#isConvergenceRelevant`, `auditStaleReason`, `auditResultEpoch`)
- **Fix:** Added an early return for `result.kind === "stateInvalidated"` before the `envelope` read, with a doc comment explaining audit wiring for this variant is deferred to later plans
- **Files modified:** `src/engine/group-engine.ts`
- **Verification:** `pnpm compile` exits 0
- **Committed in:** `1991ea3` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to satisfy the plan's own Task 3 acceptance criterion (`pnpm compile` exits 0); no scope creep — audit *behavior* for the new variant is explicitly left to later plans, matching the plan's "compile-preservation only" instruction.

## Issues Encountered

- `src/__tests__/exports.test.ts`'s inline snapshot was already failing before this plan started, caused by sibling plan 03-01 (which added `validateAppComponentIntegrity`, `validateAdminLeafCoupling`, `validateCommitLegality`, `collectAppDataUpdateOps` to the `src/core` barrel without regenerating the snapshot). Confirmed pre-existing by stashing all 03-02 changes and re-running — identical failure. Out of scope per the SCOPE BOUNDARY rule; logged to `.planning/phases/03-commit-integrity-convergence-parity/deferred-items.md`, not fixed here.
- `pnpm lint` fails repo-wide due to `refs/mdk/target/**` (vendored Rust build artifacts) missing from `.prettierignore` — also pre-existing and confirmed independent of this plan's changes (all 03-02-touched files individually pass `prettier --check`). Also logged to `deferred-items.md`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The widened `IngestResult` union, `StateNotification` model, and `StateNotificationLedger` are in place and exported through the engine barrel, ready for the seam-wiring plans (03-03 through 03-07) that will actually populate `reason`, `notifications`, and emit `stateInvalidated` results
- Two pre-existing, unrelated issues (stale exports snapshot from 03-01, `pnpm lint` noise from `refs/mdk/target/`) are documented in `deferred-items.md` for a later sweep — neither blocks this plan's own verification

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*
