---
phase: 03-commit-integrity-convergence-parity
plan: 05
subsystem: convergence
tags: [mls, ts-mls, group-engine, commit-integrity, admin-policy, convergence, vitest]

# Dependency graph
requires:
  - phase: 03-01
    provides: validateAppComponentIntegrity, validateAdminLeafCoupling, validateCommitLegality, collectAppDataUpdateOps (src/core/components/integrity.ts)
  - phase: 03-04
    provides: withCapturedProposals (src/engine/admin-policy.ts), the wired inbound + pool-replay commit-legality seams, and commit-legality-seams.test.ts's seam-parity pattern
provides:
  - AdminDepletionError — exported error class thrown before any staging when a removal commit's carried-forward admin set would be emptied (D-07)
  - Auto-coupling of an admin-policy AppDataUpdate into a removal commit that de-leafs an admin account, using account-level survival (D-08), wired into #sendInner's case "commit" (D-05/D-06)
  - The send seam's validateCommitLegality gate — a locally-staged violating commit throws UsageError before it is wrapped or published (D-01/D-02)
  - #treeResolution's winner-chain re-validation on tree-fed re-convergence — every link is replayed and re-checked against validateCommitLegality before a persisted-tree-fed branch switch is adopted, failing closed (D-04/D-09)
  - src/engine/__tests__/send-commit-legality.test.ts (8 tests) covering all of the above
affects: [phase-04-conformance-parity]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Auto-coupling scan set: the union of Object.values(state.unappliedProposals).map(p => p.proposal) and the call's own by-value proposals, matching exactly what createCommit bundles by reference plus by value — reused identically for both the D-05..D-08 coupling scan and the D-01/D-02 validation gate"
    - "Fixture pattern for tree-fed re-convergence tests: a competing branch MUST be authored by a genuinely different committer than the engine under test, then REPLAYED via processMessage from the engine's own root copy (never the committer's own createCommit result) before being recorded via recordEdge — otherwise the stored snapshot is unreplayable later (RFC 9420's own-committer UpdatePath constraint, the same one CONV-04/03-03 works around in ForkRecovery)"

key-files:
  created:
    - src/engine/__tests__/send-commit-legality.test.ts
  modified:
    - src/engine/group-engine.ts

key-decisions:
  - "Auto-coupling and the D-07 depletion guard live in #sendInner's case \"commit\", never in proposeRemoveUser — send() accepts arbitrary composed proposals (D-06), so the coupling scan must run over every removal proposal that will actually land in the commit, including unapplied proposals createCommit bundles by reference, not just this call's own extraProposals"
  - "The removed-leaves scan deliberately excludes selfRemoveProposalType entries (Pitfall 4, matching validateAdminLeafCoupling's own carve-out) — an admin's SelfRemove is already refused by createAdminCommitPolicyCallback, and a non-admin's SelfRemove cannot change the admin set"
  - "D-08 account-level survival: an account survives if at least one of its leaves is NOT in the removed set, computed via getGroupMembers + getPubkeyLeafNodeIndexes over the CURRENT (pre-commit) state — never leaf-level, which would diverge the moment an account has two leaves"
  - "The D-01/D-02 validation gate and the D-05..D-08 coupling scan both build their proposal set the same way (unappliedProposals ∪ allProposals) so neither can silently diverge from what createCommit actually bundles into the commit"
  - "#treeResolution's winner-chain validation replays each link via processMessage using the SAME withCapturedProposals(this.#createAdminVerificationCallback()) pattern as the inbound/replay seams (03-04), and fails closed (abandons the whole switch, current tip stays) on ANY of: replay throwing, a non-newState/rejected replay outcome, a replayed confirmationTag that disagrees with the stored snapshot, or a validateCommitLegality violation — with no partial adoption"
  - "Test fixtures for the tree-fed re-convergence tests build the competing sibling chain from a genuinely different committer (admin2, joined via joinGroup) than the engine under test (admin1), then replay admin2's raw commit messages via processMessage against a fresh copy of admin1's own root state before recording snapshots with recordEdge — using the committer's own createCommit result directly as the recorded snapshot made every subsequent replay hit ts-mls's RFC 9420 \"No overlap between provided private keys and update path\" error, the same own-commit-replay constraint CONV-04 (03-03) fixed for ForkRecovery's real replay path"
  - "Did not add AdminDepletionError to the root src/index.ts barrel — the plan only requires it reach the ./engine subpath through src/engine/index.ts's existing `export *` line, which it already does; src/index.ts selectively re-exports engine symbols rather than blanket re-exporting, and extending that selection was out of this plan's scope"

requirements-completed: [WIRE-03, CONV-01]

coverage:
  - id: D1
    description: "Removing a non-admin member produces a commit with no spliced admin-policy update, and the resulting admin-policy bytes are unchanged from the parent's"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#removing a non-admin member produces no spliced admin-policy update"
        status: pass
    human_judgment: false
  - id: D2
    description: "Removing an admin member from a two-admin group auto-splices an admin-policy update into the SAME commit, resulting in exactly the remaining admin"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#removing an admin member splices the admin-policy update into the same commit (D-05)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A removal that would empty the admin set is refused with AdminDepletionError before any staging; lifecycle stays Stable and nothing is staged"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#rejects a removal that would empty the admin set with AdminDepletionError before staging (D-07)"
        status: pass
    human_judgment: false
  - id: D4
    description: "An admin account with two leaves keeps its admin key when only one leaf is removed (account-level, not leaf-level, survival)"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#does not drop an admin's key when only one of its two leaves is removed (D-08)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A locally staged commit that would drop a required app component throws UsageError before the commit is wrapped or published, with SendResult's shape unchanged"
    requirement: "WIRE-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#throws UsageError before staging when the resulting extensions would drop a required component (D-01/D-02)"
        status: pass
    human_judgment: false
  - id: D6
    description: "A benign commit still returns a groupEvolution SendResult with its exact current field set (no false positive from the new gate)"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#a benign commit still returns a groupEvolution SendResult with the unchanged field set"
        status: pass
    human_judgment: false
  - id: D7
    description: "A tree-fed re-convergence switch validates every link of a legal winner chain and adopts it"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#switches to a legal winner chain fed entirely from the persisted history tree"
        status: pass
    human_judgment: false
  - id: D8
    description: "A tree-fed re-convergence switch abandons a winner chain containing a link that fails commit legality, leaving the current tip in place"
    requirement: "WIRE-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/send-commit-legality.test.ts#abandons a tree-fed switch when a winner-chain link fails commit legality"
        status: pass
    human_judgment: false

# Metrics
duration: 70min
completed: 2026-08-04
status: complete
---

# Phase 3 Plan 5: Wire WIRE-03/CONV-01 Into the Send and Tree-Fed Convergence Seams Summary

**Closed the third and final commit-legality seam (send/staging) and the tree-fed re-convergence path — auto-coupling admin-policy updates into removal commits, an `AdminDepletionError` guard, a `validateCommitLegality` throw before publish, and winner-chain re-validation on tree-fed branch switches — so all four routes to canonical state (send, inbound, pool-replay, tree-fed) now share one legality adapter.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 3 (Task 1: auto-coupling + depletion guard; Task 2: send-seam legality gate + tests; Task 3: tree-fed winner-chain validation + tests)
- **Files modified:** 2 (1 production file, 1 new test file)

## Accomplishments

- Exported `AdminDepletionError` from `src/engine/group-engine.ts` and wired auto-coupling into `#sendInner`'s `case "commit":`: any removal that de-leafs an admin account splices an `AppDataUpdate` admin-policy update into the SAME commit (D-05), using account-level survival over the union of by-reference unapplied proposals and by-value extra proposals (D-06/D-08) — matching MDK's `do_send_remove_members` shape. A removal that would empty the admin set throws `AdminDepletionError` before any staging (D-07).
- Added the D-01/D-02 gate: immediately after `createCommit` returns and before the lifecycle transitions to `PendingPublish`, `validateCommitLegality` runs on the staged commit; a violation throws `UsageError`, leaving the engine `Stable` with nothing staged. `SendResult<TEnvelope>` is unchanged.
- Added winner-chain re-validation to `#treeResolution`: every link of a tree-fed winner chain is replayed via `processMessage` (using the same `withCapturedProposals` decorator the inbound/replay seams use) and re-checked against `validateCommitLegality` before adoption — failing closed (abandoning the whole switch) on a replay throw, a rejected/non-newState replay, a confirmationTag mismatch against the stored snapshot, or a legality violation. This closes D-04/D-09: a persisted tree edge written by a pre-upgrade build is never grandfathered past the gate.
- Added `src/engine/__tests__/send-commit-legality.test.ts` (8 tests) covering all of the above, including two tree-fed re-convergence tests whose fixtures had to be built carefully to avoid RFC 9420's own-committer replay constraint (see Decisions Made).
- Re-ran the full engine suite and the full project suite after each task; `convergence-parity.test.ts` (CONV-04) and `commit-legality-seams.test.ts` (03-04's inbound/replay parity) are untouched and still pass. Full suite: 73 files / 691 tests green (up from the 72/683 baseline).

## Task Commits

Each task was committed atomically:

1. **Task 1: Auto-couple the admin policy into removal commits and guard admin depletion (D-05..D-08)** - `4cad3fb` (feat)
2. **Task 2: Validate the staged commit before wrapping and throw on violation (D-01/D-02)** - `6a069a7` (feat)
3. **Task 3: Validate the winner chain on a tree-fed re-convergence switch (D-04/D-09)** - `bbd82b6` (feat)

**Plan metadata:** (this commit) - `docs(03-05): complete plan`

## Files Created/Modified

- `src/engine/group-engine.ts` - Added `AdminDepletionError`; auto-coupling + depletion guard in `#sendInner`'s `case "commit":`; the `validateCommitLegality`/`UsageError` gate before the `PendingPublish` transition; winner-chain replay + re-validation in `#treeResolution`
- `src/engine/__tests__/send-commit-legality.test.ts` - New: 8 tests covering the send seam (auto-coupling, depletion guard, account-level survival, the legality throw, unchanged `SendResult` shape) and the tree-fed seam (legal switch, abandoned switch on violation)

## Decisions Made

See frontmatter `key-decisions` for the full list. Highlights:
- Auto-coupling/depletion-guard logic lives entirely in send/staging, never in `proposeRemoveUser` (D-06), because `send()` must catch every removal proposal that ends up in the commit, including ones bundled by reference from `state.unappliedProposals` that the caller never explicitly named.
- Both the coupling scan (Task 1) and the validation gate (Task 2) derive their proposal set identically (`unappliedProposals` ∪ `allProposals`), so the two mechanisms can never silently see a different commit shape than what `createCommit` actually produces.
- The tree-fed re-convergence test fixtures required a genuinely different committer (admin2) than the engine under test (admin1), with the sibling chain's snapshots derived by REPLAYING admin2's raw commits from a copy of admin1's own root — not by recording the committer's own `createCommit` result directly — to avoid ts-mls's RFC 9420 "no overlap between provided private keys and update path" error on later replay. This is the same own-commit-replay constraint CONV-04 (03-03) fixed for `ForkRecovery`, hit here by test-construction rather than by the real engine, and worth recording since it shapes how any future tree-fed-convergence test fixture must be built.

## Deviations from Plan

None — plan executed as written. The only substantive discovery was during test authoring (not production code): the first attempt at the two `#treeResolution` tests built the sibling chain from the committer's own `createCommit` result, which is unreplayable on a later hop for the RFC 9420 reason above; the fixture was corrected to replay through a third party's (admin1's) own state instead, per Decisions Made. No production-code behavior changed as a result.

## Issues Encountered

- Initial `#treeResolution` test fixtures triggered `InternalError: No overlap between provided private keys and update path` (and a related `ValidationError: Could not find common ancestor`) when the new winner-chain validation replayed the second hop of a two-commit sibling chain, because the recorded child snapshot was the committer's own post-commit state (private keys and all) rather than a third party's replayed view. Resolved by authoring the sibling chain with a genuinely different committer (admin2) and replaying its raw commit messages via `processMessage` from a fresh copy of admin1's root before recording snapshots — see Decisions Made.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three commit-legality seams named in this phase's objective (send, inbound, convergence/replay) — plus the tree-fed re-convergence path, a fourth route to canonical state — now call the single shared `validateCommitLegality` adapter (`src/core/components/integrity.ts`, 03-01). `commit-legality-seams.test.ts` (03-04) proves inbound/replay parity; `send-commit-legality.test.ts` (this plan) proves the send seam matches and the tree-fed seam fails closed on a violation.
- WIRE-03 and CONV-01 are marked `Complete` in `REQUIREMENTS.md` (checkbox list + traceability table) — this plan's tests are the last piece needed per the explicit instruction in 03-04's summary ("Plan 03-05 must wire the third seam... before WIRE-03/CONV-01 can be marked complete").
- CONV-02/CONV-03 remain untouched and Pending, owned by plans 03-06/03-07 per this plan's explicit scope boundary.
- Pre-existing, out-of-scope items from earlier plans in this phase remain open (see `deferred-items.md`): `pnpm lint` failing repo-wide on `refs/mdk/target/**` (missing `.prettierignore` entry) — not touched by this plan (verified via `npx prettier --check` on this plan's own touched files instead, per the phase's documented workaround).

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*

## Self-Check: PASSED

- FOUND: `src/engine/group-engine.ts`
- FOUND: `src/engine/__tests__/send-commit-legality.test.ts`
- FOUND: `.planning/phases/03-commit-integrity-convergence-parity/03-05-SUMMARY.md`
- FOUND commit: `4cad3fb` (feat: auto-couple admin policy + depletion guard)
- FOUND commit: `6a069a7` (feat: staged-commit legality gate + tests)
- FOUND commit: `bbd82b6` (feat: tree-fed winner-chain validation + tests)
