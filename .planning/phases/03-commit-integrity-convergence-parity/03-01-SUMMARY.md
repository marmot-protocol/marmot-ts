---
phase: 03-commit-integrity-convergence-parity
plan: 01
subsystem: core
tags: [mls, ts-mls, app-components, commit-validation, admin-policy]

# Dependency graph
requires: []
provides:
  - "validateAppComponentIntegrity (WIRE-03): pure, non-throwing app-component attribution validator"
  - "validateAdminLeafCoupling (CONV-01): pure, non-throwing admin/leaf resulting-epoch coupling validator"
  - "validateCommitLegality: shared seam adapter deriving args from ClientState pairs, used by all three seams"
  - "collectAppDataUpdateOps: the single Proposal[] -> AppDataUpdateOp[] adapter"
affects: [03-02, 03-03, 03-04, 03-05, 03-06, 03-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure, non-throwing validators returning CommitIntegrityViolation | undefined so each seam (send/inbound/convergence) chooses its own disposition"
    - "Shared seam adapter (validateCommitLegality) derives requiredIds from the PARENT state only, never the resulting state, to close the mdk#707 re-derivation bug class"

key-files:
  created:
    - src/core/components/integrity.ts
    - src/core/components/__tests__/integrity.test.ts
  modified:
    - src/core/components/index.ts

key-decisions:
  - "Read the raw dictionary via ts-mls getAppDataDictionary rather than the typed accessors in dictionary.ts, so unknown component ids participate in the diff (spec's Unknown Data preservation rule)"
  - "requiredIds for validateAppComponentIntegrity MUST be derived from the CURRENT (pre-commit) extensions, never the resulting ones, to prevent a commit from adding an id to app_components and thereby retroactively protecting its own removal in the same commit (Pitfall 2)"
  - "validateAdminLeafCoupling evaluates the carried-forward (current-epoch) admin set when the resulting extensions carry no admin-policy bytes, rather than skipping the check, per admin-policy-v1.md and Pitfall 3"
  - "No SelfRemove carve-out added to validateAdminLeafCoupling (Pitfall 4) — a non-admin's SelfRemove trivially passes and an admin's SelfRemove is already refused upstream by createAdminCommitPolicyCallback"
  - "decodeAdminPolicyV1 failures are caught and converted to an admin-leaf-coupling violation rather than allowed to throw out of the pure validator (T-03-03)"

patterns-established:
  - "CommitIntegrityViolation { reason, detail } — detail names component ids/counts only, never raw pubkeys (diagnostics-privacy rule); the protocol-visible signal is the reason enum"

requirements-completed: [WIRE-03, CONV-01]

coverage:
  - id: D1
    description: "validateAppComponentIntegrity ports MDK's three-rule app-component attribution check (never drop app_data_dictionary, never drop a protected component, every changed entry must be backed by an AppDataUpdate op)"
    requirement: "WIRE-03"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateAppComponentIntegrity (10 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "validateAdminLeafCoupling ports MDK's resulting-epoch admin/leaf invariant, including the carried-forward fallback and the empty-resolved-set vacuous pass"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateAdminLeafCoupling (6 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "validateCommitLegality is the single shared seam adapter deriving requiredIds from the parent state and resultingMemberAccounts from the resulting state"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateCommitLegality (3 cases)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-04
status: complete
---

# Phase 03 Plan 01: Commit-Legality Validators (WIRE-03, CONV-01) Summary

**Ported MDK's app-component attribution rule and admin/leaf coupling invariant into one pure, non-throwing `src/core/components/integrity.ts` module, plus the `validateCommitLegality` shared seam adapter every later plan in this phase wires in.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-08-04T11:00:00Z (approx.)
- **Completed:** 2026-08-04T11:25:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- `validateAppComponentIntegrity` (WIRE-03): ported all three numbered MDK rules — the `app_data_dictionary` extension may never be dropped, the `app_components` id plus every current-epoch required id may never be dropped, and every changed dictionary entry must be attributable to one of the commit's own `AppDataUpdate` ops.
- `validateAdminLeafCoupling` (CONV-01): ported the resulting-epoch admin/leaf invariant, including the carried-forward admin-set fallback (Pitfall 3) and the deliberate absence of a SelfRemove carve-out (Pitfall 4).
- `validateCommitLegality`: the single shared adapter all three seams (send, inbound, convergence/replay) in this phase will call, deriving `requiredIds` from the parent state and `resultingMemberAccounts` from the resulting state so the derivation is written exactly once (closes the mdk#707 bug class).
- `collectAppDataUpdateOps`: the one `Proposal[] → AppDataUpdateOp[]` adapter, preserving commit order and not deduplicating.
- 21 unit tests, each asserting the exact violation `reason`, covering every rule, both pitfalls (2 and 3), the SelfRemove non-carve-out (4), and a decode-failure case for the T-03-03 threat mitigation.

## Task Commits

Each task was committed atomically:

1. **Task 1: Port the app-component integrity validator (WIRE-03)** - `fabfdd0` (feat)
2. **Task 2: Port the admin/leaf coupling validator and export both from the barrel (CONV-01)** - `9be1e91` (feat)
3. **Task 3: Unit-test both validators against hand-built extension fixtures** - `370f5e9` (test)

**Plan metadata:** (this commit)

## Files Created/Modified

- `src/core/components/integrity.ts` - New module: `CommitIntegrityViolationReason`, `CommitIntegrityViolation`, `AppDataUpdateOp`, `collectAppDataUpdateOps`, `validateAppComponentIntegrity`, `validateAdminLeafCoupling`, `validateCommitLegality`
- `src/core/components/index.ts` - Added `export * from "./integrity.js";` to the barrel
- `src/core/components/__tests__/integrity.test.ts` - 21 unit tests across four `describe` blocks

## Decisions Made

- Read the dictionary via `getAppDataDictionary` (ts-mls) rather than the typed accessors in `dictionary.ts`, so unknown component ids participate in the integrity diff (matches the spec's "Unknown Data" preservation rule).
- `requiredIds` is a caller-supplied parameter derived strictly from the CURRENT (pre-commit) extensions; the JSDoc documents this constraint explicitly per Pitfall 2, and the shared adapter (`validateCommitLegality`) enforces it by construction (`getAppComponents(parentState...)`).
- `validateAdminLeafCoupling` wraps both `getAdminPolicy` reads in a single try/catch so a decode failure on attacker-supplied resulting bytes becomes a typed `admin-leaf-coupling` violation rather than an escaping exception (T-03-03).
- Violation `detail` strings name component ids (hex) and counts only, never raw pubkeys, per the diagnostics-privacy rule (T-03-04) — the `reason` enum is the protocol-visible signal.
- For `validateCommitLegality`'s tests, used minimal `ClientState`-shaped fixtures (`{ groupContext: { extensions }, ratchetTree }` cast at the call site) rather than a full `createSimpleGroup` + `createCommit` round trip, since `getGroupMembers` only reads `ratchetTree` leaf credentials — keeps the tests fast and focused on the validator logic being tested, not MLS commit mechanics.

## Deviations from Plan

None - plan executed exactly as written. One addition beyond the plan's explicit test-case list: an extra `validateAdminLeafCoupling` case asserting a decode failure on malformed resulting admin-policy bytes returns a violation rather than throwing, directly exercising the T-03-03 threat-model mitigation (Rule 2 — auto-added test coverage for an existing threat-register mitigation, not a code change).

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `validateCommitLegality` is ready to be wired at the send, inbound, and convergence/replay seams in the remaining plans of this phase (03-02 through 03-07).
- The module has zero dependency on `src/engine` or `src/client` (verified via grep), preserving the `utils ← core ← engine ← client` layering constraint.
- `pnpm compile`, `pnpm vitest run src/core/components`, and `pnpm lint` (scoped to this plan's files) all pass.

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*
