---
phase: 03-commit-integrity-convergence-parity
plan: 04
subsystem: convergence
tags: [mls, ts-mls, ingest, fork-recovery, commit-integrity, admin-policy, vitest]

# Dependency graph
requires:
  - phase: 03-01
    provides: validateAppComponentIntegrity, validateAdminLeafCoupling, validateCommitLegality, collectAppDataUpdateOps (src/core/components/integrity.ts)
  - phase: 03-02
    provides: widened RejectedIngestResult.reason union, SkippedIngestResult/StateNotification vocabulary
  - phase: 03-03
    provides: ForkRecovery's knownNextStates own-commit-replay fix (CONV-04) — read fresh and preserved untouched
provides:
  - withCapturedProposals — a pure decorator around IncomingMessageCallback that buffers a commit's own proposals for post-apply validation (src/engine/admin-policy.ts)
  - The inbound commit branch (ingest.ts) gated on validateCommitLegality after processMessage returns and before ctx.setState, with the admin-policy rejection now labelled reason: "admin-policy"
  - ForkRecovery#buildBranches/explore() gated on the same validator before a candidate edge is created — a violating commit produces no branch and no history-tree edge
  - src/engine/__tests__/commit-legality-seams.test.ts proving inbound and replay seams reach the same verdict for identical commit bytes
affects: [phase-03-plan-05-send-seam, phase-04-conformance-parity]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Side-channel decorator around an IncomingMessageCallback (withCapturedProposals) to bridge ts-mls's pre-apply-only callback hook with a validator that needs the post-apply GroupContext"
    - "Post-processMessage, pre-setState/pre-edges.push validation gate — both receive-side seams call the single shared adapter (validateCommitLegality) so neither can drift from the other (mdk#707 bug class)"

key-files:
  created:
    - src/engine/__tests__/commit-legality-seams.test.ts
  modified:
    - src/engine/admin-policy.ts
    - src/engine/ingest.ts
    - src/engine/fork-recovery.ts

key-decisions:
  - "withCapturedProposals is a pure decorator — createAdminCommitPolicyCallback's body is byte-for-byte unchanged (verified via git diff --unified=0); the MIP-03 admin gate, account-identity-proof check, and admin-self-remove guard keep their exact current behavior"
  - "Neither ingest.ts nor fork-recovery.ts re-derive requiredIds/resultingMemberAccounts locally — both call validateCommitLegality directly with (parentState, resultingState, proposals), letting the shared adapter (03-01) own that derivation so no seam can re-implement it slightly differently"
  - "In fork-recovery.ts, the WIRE-03/CONV-01 gate is applied only to the processMessage (else) replay branch, not the knownNextStates (CONV-04 own-commit) branch — commits reached via knownNextStates already passed one of the two gates when first applied (either this seam's own prior pass or the inbound seam), so re-validating them on every replay would be redundant; only genuinely-replayed peer commits need the gate"
  - "The component-integrity test commit uses an AppDataUpdate 'remove' proposal targeting a required component id, not a raw group_context_extensions dictionary rewrite — ts-mls's own validateAppDataUpdateProposals already refuses any GroupContextExtensions proposal that touches app_data_dictionary at all once required_capabilities lists AppDataUpdate (which every Marmot group's required_capabilities does), so a raw GCE tamper never reaches processMessage successfully. The AppDataUpdate-remove path is the only wire shape that reaches our WIRE-03 gate; it is still a genuine violation because validateAppComponentIntegrity's Rule 2 never permits a required id to be dropped, even through the legitimate channel"
  - "Did not mark WIRE-03 or CONV-01 complete in REQUIREMENTS.md — this plan wires two of the three seams (inbound, convergence/replay); the send seam is plan 03-05's responsibility per the explicit instruction in this plan's prompt context"

requirements-completed: []

coverage:
  - id: D1
    description: "An inbound commit that drops a required app component is rejected pre-merge with reason 'component-integrity' and never reaches ctx.setState"
    requirement: "WIRE-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/commit-legality-seams.test.ts#rejects an inbound commit that drops a required app component (component-integrity)"
        status: pass
    human_judgment: false
  - id: D2
    description: "An inbound removal commit that de-leafs an admin without an admin-policy update is rejected with reason 'admin-leaf-coupling'"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/commit-legality-seams.test.ts#rejects an inbound removal commit that de-leafs an admin without an admin-policy update (admin-leaf-coupling)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A benign commit still processes and advances the epoch (no false positive from the new gate)"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/commit-legality-seams.test.ts#still processes a benign commit and advances the epoch (no false positive)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The pre-existing admin-policy rejection now carries reason: 'admin-policy', distinguishing it from the two new WIRE-03/CONV-01 reasons"
    requirement: "WIRE-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/commit-legality-seams.test.ts#labels the pre-existing admin-policy rejection with reason 'admin-policy'"
        status: pass
    human_judgment: false
  - id: D5
    description: "A violating commit replayed as a fork-recovery candidate creates no branch edge and no history-tree edge; the inbound and replay seams reach the same verdict for identical commit bytes"
    requirement: "CONV-01"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/commit-legality-seams.test.ts#drops the violating commit as a fork-recovery candidate edge — no branch adopted, no history-tree edge (replay parity)"
        status: pass
    human_judgment: false

# Metrics
duration: 45min
completed: 2026-08-04
status: complete
---

# Phase 3 Plan 4: Wire WIRE-03/CONV-01 Into the Inbound and Replay Seams Summary

**Wired the ported MDK commit-legality validators (validateAppComponentIntegrity, validateAdminLeafCoupling) into both receive-side seams — ingest.ts's inbound commit branch and fork-recovery.ts's candidate-edge builder — via a shared proposal-capture decorator, so a component-integrity or admin-leaf-coupling violation is rejected/dropped identically on both, without regressing CONV-04's own-commit-replay fix.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3 (Task 1: proposal-capture decorator; Task 2: inbound gate; Task 3: replay gate + seam-parity tests)
- **Files modified:** 4 (3 production files, 1 new test file)

## Accomplishments

- Added `withCapturedProposals` to `src/engine/admin-policy.ts`: a pure decorator around `IncomingMessageCallback` that buffers a commit's own proposals (even for a commit the admin gate itself rejects), with a documented `take()`-before/`take()`-after contract. `createAdminCommitPolicyCallback`'s body is byte-for-byte unchanged.
- Gated the inbound commit branch in `ingest.ts`: wrapped `ctx.createAdminCallback()` with the capture decorator, labelled the existing admin-policy rejection `reason: "admin-policy"`, and added the `validateCommitLegality` gate immediately after `processMessage` returns and before `ctx.setState` — a violation is yielded `rejected` with the violation's own reason and never reaches canonical state or `ctx.recordCommit`.
- Gated `ForkRecovery#buildBranches`'s `explore()` in `fork-recovery.ts`: wrapped the incoming admin callback once, cleared/read the buffer around the `processMessage` replay call, and added the same `validateCommitLegality` gate right after the existing `actionTaken === "reject"` filter and before `edges.push` — a violating candidate creates no branch and no history-tree edge, with no grandfathering for edges replayed out of retained history (D-04/D-09).
- Added `src/engine/__tests__/commit-legality-seams.test.ts` (5 tests) proving: an inbound component-integrity rejection, an inbound admin-leaf-coupling rejection, a benign commit still processing, the pre-existing admin-policy rejection now carrying its labelled reason, and — using the exact same violating commit bytes — that the replay seam drops the candidate with no branch adopted and no history-tree edge.
- Re-ran `convergence-parity.test.ts` and the full engine/project suites after each task; CONV-04's `knownNextStates` own-commit-replay fix (03-03) is untouched and still passes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the proposal-capture side channel around the admin callback** - `765cc43` (feat)
2. **Task 2: Gate the inbound commit branch on commit legality (WIRE-03 + CONV-01, D-03)** - `fa52d9a` (feat)
3. **Task 3: Drop violating candidate edges in fork recovery and prove seam parity** - `cdbcaea` (feat)

**Plan metadata:** (this commit) - `docs(03-04): complete plan`

## Files Created/Modified

- `src/engine/admin-policy.ts` - Added `withCapturedProposals`, a pure decorator buffering a commit's own proposals for post-apply validation; `createAdminCommitPolicyCallback` untouched
- `src/engine/ingest.ts` - Wrapped the admin callback with `withCapturedProposals`; labelled the admin-policy rejection; added the `validateCommitLegality` gate before `ctx.setState`
- `src/engine/fork-recovery.ts` - Wrapped the callback in `#buildBranches`; added the `validateCommitLegality` gate before `edges.push` in the `processMessage` replay branch of `explore()` (the `knownNextStates` own-commit branch is untouched, per CONV-04)
- `src/engine/__tests__/commit-legality-seams.test.ts` - New: 5 tests proving inbound/replay seam parity for both violation reasons plus a benign-commit control

## Decisions Made

- `withCapturedProposals` buffers proposals unconditionally on every `incoming.kind === "commit"` call, including ones the wrapped admin gate itself rejects — this is required so the caller can still read a commit's proposals even when `actionTaken === "reject"`, though in practice both seams only consume `capturedProposals` after confirming `result.kind === "newState"` and `actionTaken !== "reject"`.
- The gate in `fork-recovery.ts` is scoped to the `processMessage`/replay branch only, not the `knownNextStates` (CONV-04) branch — those commits already passed a legality gate the first time they were applied (either this seam's own prior pass, or the inbound seam for an adopted inbound commit), so gating them again on every subsequent replay would be redundant work with no additional safety.
- Built the component-integrity test violation via an `AppDataUpdate` "remove" proposal (the sanctioned wire channel) rather than a raw `group_context_extensions` dictionary rewrite, after discovering ts-mls's own `validateAppDataUpdateProposals` already refuses any `GroupContextExtensions` proposal that touches `app_data_dictionary` when `required_capabilities` lists `AppDataUpdate` (which every Marmot group's does) — this is a real, useful defense-in-depth fact worth recording: WIRE-03's Rule 2 (never drop a required component) is strictly stronger than ts-mls's own protection, since ts-mls happily permits removing a required component via a legitimate `AppDataUpdate`, which is exactly the gap this phase closes.
- Did not mark WIRE-03/CONV-01 complete in `REQUIREMENTS.md` — per explicit instruction, the send seam (plan 03-05) is the third and final seam; marking these complete before that seam lands would repeat the exact premature-completion mistake `145e8a2` reset.

## Deviations from Plan

None - plan executed exactly as written. The only adaptation was in test construction (see Decisions Made: the AppDataUpdate-remove vs. group_context_extensions choice), which is a test-authoring detail within Task 3's stated flexibility ("If producing that shape through `createCommit` proves impractical, instead drive `validateCommitLegality` at the seam boundary...") rather than a deviation from production code behavior.

## Issues Encountered

- Initial attempt to build the component-integrity violation via a raw `group_context_extensions` proposal rewriting the `app_data_dictionary` failed at `createCommit` with ts-mls's own `ValidationError: GroupContextExtensions proposal cannot modify the app_data_dictionary extension when required capabilities include the AppDataUpdate proposal type` — resolved by switching to an `AppDataUpdate` "remove" proposal targeting the required component id instead (see Decisions Made).
- Two of the four synthetic hex pubkeys initially chosen for the test fixture (`"b".repeat(64)`, `"c".repeat(64)`) are not valid x-only secp256k1 public keys (only about half of all possible 32-byte values lift to a curve point); resolved by probing which repeated-hex-digit values are valid and switching to `"2".repeat(64)`/`"3".repeat(64)`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Two of the three WIRE-03/CONV-01 seams (inbound, convergence/replay) are wired and verified end-to-end against the live engine, with a seam-parity test proving they agree on identical commit bytes.
- Plan 03-05 must wire the third seam (send/staging, `group-engine.ts`'s `#sendInner` commit path per the pattern map's `send()` insertion points) before WIRE-03/CONV-01 can be marked complete in `REQUIREMENTS.md`.
- `ForkRecovery`'s `knownNextStates` own-commit-replay fix (CONV-04, 03-03) is confirmed unaffected by this plan's changes — `convergence-parity.test.ts` passes unchanged, and the new gate is scoped to skip that branch entirely.
- Pre-existing, out-of-scope items from earlier plans in this phase remain open (see `deferred-items.md`): stale `exports.test.ts` snapshot risk on future barrel changes (not triggered by this plan — `withCapturedProposals` is not re-exported from the top-level `src/index.ts`), and `pnpm lint` failing repo-wide on `refs/mdk/target/**` (missing `.prettierignore` entry) — neither touched by this plan.

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*

## Self-Check: PASSED

- FOUND: `src/engine/admin-policy.ts`
- FOUND: `src/engine/ingest.ts`
- FOUND: `src/engine/fork-recovery.ts`
- FOUND: `src/engine/__tests__/commit-legality-seams.test.ts`
- FOUND: `.planning/phases/03-commit-integrity-convergence-parity/03-04-SUMMARY.md`
- FOUND commit: `765cc43` (feat: proposal-capture side channel)
- FOUND commit: `fa52d9a` (feat: inbound commit-legality gate)
- FOUND commit: `cdbcaea` (feat: replay gate + seam-parity tests)
