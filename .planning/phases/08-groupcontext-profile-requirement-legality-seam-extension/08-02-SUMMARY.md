---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
plan: 02
subsystem: auth
tags: [mls, account-identity-proof, admin-policy, proposal-admission, ts-mls]

# Dependency graph
requires:
  - phase: 08-groupcontext-profile-requirement-legality-seam-extension
    provides: "validateAddProposalAccountIdentityProofs, validateCommitAccountIdentityProofs, CommitIntegrityViolation.proofReason/.leafIndex, RejectedIngestResult.reason 'account-identity-proof' (08-01)"
provides:
  - "createAdminCommitPolicyCallback validates every Add (commit-embedded and standalone) through the one shared validateAddProposalAccountIdentityProofs helper -- closes the Phase 7 D-06 known gap"
  - "withCapturedProposals captures a standalone proposal's single ProposalWithSender (committerLeafIndex left undefined), not just commit-embedded proposals"
  - "Inbound standalone Add admission (ingest.ts non-commit branch): a rejected Add proposal surfaces as rejected with reason account-identity-proof + proofReason; only the ratchet advance is applied, recordProposalStaged is never called"
  - "D-05 identical labeling: an admin-callback commit rejection caused by an Add-proof failure reports account-identity-proof (with proofReason) instead of the generic admin-policy reason, on inbound ingest AND fork-recovery/resolveCandidateParent (shared by pool-replay and tree-fed convergence)"
  - "ParentResolution's rejected variant carries an optional structured CommitIntegrityViolation"
  - "Local outbound Add gates: engine.send({kind:'proposal'}) validates a raw Add before createProposal (throws AccountIdentityProofError, same as proposeInviteUser); #prepareOutboundCommitProposals validates the full committed union before createCommit (throws CommitLegalityError, pre-apply symmetry with the existing post-apply #assertStagedCommitLegal backstop)"
  - "#sweepResult wraps the admin callback with withCapturedProposals for both commit and non-commit framed messages, so an invalid standalone Add is never staged into a non-canonical fork snapshot"
  - "GRP-04 proven end-to-end: invite seam, raw local proposal, raw local commit Add, and inbound standalone Add all refuse a proof-less/forged KeyPackage before anything is proposed, queued, or committed"
affects: [08-03, 08-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One withCapturedProposals wrapper shared across both the non-commit and commit loops in ingestEnvelopes (its docstring already documents reuse across a loop of several messages), instead of two independent wrapped callbacks over the same admin policy"
    - "Pre-apply Add validation mirrors the post-apply backstop at every seam: local send (case 'proposal' / #prepareOutboundCommitProposals) gets the identical treatment as the inbound admin callback, so a bypass attempt via a hand-built raw Proposal is refused the same way proposeInviteUser already refuses it"

key-files:
  created:
    - src/engine/__tests__/standalone-add-admission.test.ts
  modified:
    - src/engine/admin-policy.ts
    - src/engine/ingest.ts
    - src/engine/fork-recovery.ts
    - src/engine/group-engine.ts
    - src/engine/__tests__/group-engine.test.ts
    - src/client/group/__tests__/marmot-group.test.ts
    - src/client/group/__tests__/invite.test.ts

key-decisions:
  - "Merged ingest.ts's two independent withCapturedProposals wrappers (one per loop) into one shared instance declared before both loops, since the decorator's own contract already documents safe reuse across a loop of several processed messages -- avoids constructing two wrapped callbacks over the identical admin policy"
  - "D-05's inbound-commit test (Task 3, test 5) uses an ADMIN committer (admin2) authoring the forged-Add commit, so the commit passes the pre-existing group-messaging.md admin gate and is rejected by the Add-proof check specifically -- proving the D-05 labeling fix rather than the pre-existing generic admin-policy path"

requirements-completed: [GRP-04]

coverage:
  - id: D1
    description: "createAdminCommitPolicyCallback validates every Add pre-apply, both commit-embedded and standalone, through validateAddProposalAccountIdentityProofs; standalone Update/Remove/SelfRemove proposals keep accepting (D-10, Phase 9 boundary)"
    requirement: "GRP-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/group-engine.test.ts#admin commit policy account identity proof gate (D-08/D-09/D-10 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Inbound standalone Add admission: a forged/missing-proof Add proposal is rejected with reason account-identity-proof + proofReason before being staged; a valid one is still staged (no false positive)"
    requirement: "GRP-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts#GRP-04: inbound standalone Add with a forged proof is rejected, not queued"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts#GRP-04: inbound standalone Add with a valid KeyPackage is still staged (no false positive)"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-05: an admin-callback commit rejection caused by an Add-proof failure is labeled account-identity-proof (with proofReason), not the generic admin-policy reason, on inbound ingest"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts#D-05: inbound commit carrying a forged Add is labeled account-identity-proof"
        status: pass
    human_judgment: false
  - id: D4
    description: "Local outbound Add gates: a raw Add proposal intent and a raw Add inside a commit's extraProposals are both refused pre-apply (AccountIdentityProofError / CommitLegalityError respectively), matching proposeInviteUser's own check"
    requirement: "GRP-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts#GRP-04: engine refuses a raw Add proposal intent with a forged KeyPackage before proposing"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts#GRP-04: engine refuses a raw Add inside a commit before createCommit"
        status: pass
    human_judgment: false
  - id: D5
    description: "proposeInviteUser (invite seam) rejects a proof-less or tampered invitee KeyPackage with AccountIdentityProofError before a Proposal is returned; a valid KeyPackage still resolves to an Add proposal"
    requirement: "GRP-04"
    verification:
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#proposeInviteUser account identity proof (GRP-04)"
        status: pass
    human_judgment: false
  - id: D6
    description: "ParentResolution's rejected variant carries the same structured violation as the inbound seam, shared by pool-replay and tree-fed convergence through resolveCandidateParent; #sweepResult's admin callback covers standalone proposals too, so an invalid Add is never staged into a fork snapshot"
    verification:
      - kind: unit
        ref: "pnpm vitest run src/engine (137/137 pass, including commit-legality-seams.test.ts and send-commit-legality.test.ts unaffected)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-15
status: complete
---

# Phase 8 Plan 2: GroupContext Profile Requirement & Legality-Seam Extension (Standalone-Add Admission) Summary

**Closed every standalone-Add admission gap (D-08/D-09) and made a pre-apply Add-proof rejection look identical on send, inbound ingest, pool-replay/fork-recovery, and the history-tree sweep (D-05), proving GRP-04 end-to-end with a new 5-test seam-admission file.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-15
- **Tasks:** 3
- **Files modified:** 8 (1 new, 7 modified)

## Accomplishments
- `createAdminCommitPolicyCallback` (`src/engine/admin-policy.ts`): the commit-embedded Add loop and the previously blanket-accepting `incoming.kind === "proposal"` branch are both replaced by one call each to `validateAddProposalAccountIdentityProofs` — closing the Phase 7 D-06 known gap (a proof-less Add is now rejected, not skipped) and adding standalone Add admission (D-09) with the identical validator. Standalone Update/Remove/SelfRemove proposals are untouched (D-10, deferred to Phase 9).
- `withCapturedProposals` now also captures a standalone proposal's single `ProposalWithSender` (`committerLeafIndex` stays `undefined`), so the side channel is complete for every seam that wraps the admin callback.
- `ingest.ts` non-commit branch (D-09 inbound): swapped the blanket-accept callback for the wrapped admin callback; a rejected Add advances only the ratchet (never `recordProposalStaged`) and yields `rejected` with `reason: "account-identity-proof"` + `proofReason`. The commit and non-commit loops now share one `withCapturedProposals` wrapper instead of two, per the decorator's own documented reuse contract.
- `ingest.ts` commit branch (D-05): an admin-callback commit rejection caused by an Add-proof failure now reports `account-identity-proof` + `proofReason` instead of the generic `admin-policy` reason; the existing `validateCommitLegality` rejection yield also now propagates `proofReason`/`leafIndex`.
- `fork-recovery.ts`: `ParentResolution`'s `rejected` variant carries an optional `violation?: CommitIntegrityViolation`, populated identically whether the rejection came from the admin callback or from `validateCommitLegality` — shared by pool-replay and tree-fed convergence through `resolveCandidateParent`.
- `group-engine.ts`: `case "proposal"` validates a raw Add before `createProposal` (throws `AccountIdentityProofError`, matching `proposeInviteUser`); `#prepareOutboundCommitProposals` validates the full committed proposal union (by-reference unapplied + by-value) before `createCommit` (throws `CommitLegalityError`, pre-apply symmetry with the existing post-apply `#assertStagedCommitLegal` backstop); `#sweepResult` wraps the admin callback with `withCapturedProposals` for both commit and non-commit framed messages, so an invalid standalone Add is never staged into a non-canonical fork snapshot.
- New `src/engine/__tests__/standalone-add-admission.test.ts` (5 tests) proves GRP-04 on every admission path: raw local proposal intent, raw local commit Add, inbound standalone Add (rejected + valid-still-staged), and an inbound commit with a forged Add labeled `account-identity-proof` (D-05). `invite.test.ts` gained 3 tests proving `proposeInviteUser` rejects a proof-less/tampered KeyPackage before returning a Proposal, and still resolves a valid one.

## Task Commits

Each task was committed atomically:

1. **Task 1: Admin callback validates every Add (commit and standalone) and the capture side channel sees standalone proposals** - `7042b02` (feat)
2. **Task 2: Seam wiring: inbound proposal admission, identical rejection labeling, and local outbound Add gates** - `5c7197d` (feat)
3. **Task 3: GRP-04 admission tests (invite seam, raw local Add, inbound standalone Add)** - `81919d1` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/engine/admin-policy.ts` - `createAdminCommitPolicyCallback` validates every Add via `validateAddProposalAccountIdentityProofs`; `withCapturedProposals` captures standalone proposals too
- `src/engine/ingest.ts` - shared `withCapturedProposals` wrapper for both loops; D-09 inbound proposal admission; D-05 commit-rejection labeling; `proofReason`/`leafIndex` propagation
- `src/engine/fork-recovery.ts` - `ParentResolution.rejected.violation?: CommitIntegrityViolation`, populated on both rejection paths in `resolveCandidateParent`
- `src/engine/group-engine.ts` - `case "proposal"` Add validation; `#prepareOutboundCommitProposals` pre-apply Add check; `#sweepResult` wraps the admin callback for both message kinds
- `src/engine/__tests__/group-engine.test.ts` - retitled/flipped the D-06→D-08 gap test; added D-09/D-10 standalone-proposal tests and a `withCapturedProposals` capture test
- `src/client/group/__tests__/marmot-group.test.ts` - updated the WR-01 control assertion's comment/expectation from throw to reject
- `src/client/group/__tests__/invite.test.ts` - new `proposeInviteUser account identity proof (GRP-04)` describe block
- `src/engine/__tests__/standalone-add-admission.test.ts` (new) - 5 GRP-04/D-05 seam-admission tests

## Decisions Made
- Merged `ingest.ts`'s commit-loop and non-commit-loop `withCapturedProposals` instances into one shared wrapper declared before both loops — the decorator's own docstring already documents safe reuse across a loop of several processed messages, so constructing two independent wrapped callbacks over the identical admin policy would have been redundant. (This also satisfied the plan's own acceptance-criteria grep count of 1 occurrence.)
- Task 3's D-05 inbound-commit test uses an admin committer (admin2) to author the forged-Add commit, so the commit passes the pre-existing `group-messaging.md` admin gate and is rejected specifically by the Add-proof check — proving the D-05 labeling fix distinctly from the pre-existing generic `admin-policy` rejection path (already covered by `commit-legality-seams.test.ts`).
- Left `REQUIREMENTS.md`'s `GRP-02` as Pending, marking only `GRP-04` complete. `GRP-02`'s full text ("...rejected identically on send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence") requires the targeted seam-parity matrix that plan 08-04 explicitly builds (`requirements: [GRP-02]` in its own frontmatter); this plan's D-05 labeling work is a necessary precondition for that matrix, not the matrix itself, matching the same discretion 08-01 already exercised for the same requirement.

## Deviations from Plan

None - plan executed exactly as written. The plan's own acceptance-criteria grep counts (e.g., `withCapturedProposals(ctx.createAdminCallback())` outputting `1` in `ingest.ts`) directly implied the single-shared-wrapper structure described above, which was applied during Task 2 rather than as an after-the-fact fix.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Every production `processMessage` call that can stage or apply an Add (ingest non-commit, ingest commit, `resolveCandidateParent` shared by pool-replay and tree-fed convergence, `#sweepResult`) now runs through an admin callback that calls `validateAddProposalAccountIdentityProofs`; only the documented no-group-data `acceptAll` fallback in `#createAdminVerificationCallback` remains a blanket-accept callback.
- `ParentResolution.rejected.violation` and the `proofReason`/`leafIndex` fields on `RejectedIngestResult` are ready for plan 08-04's GRP-02 seam-parity matrix (D-04), which asserts the identical projected verdict across all four seams for three fixture rows (dropped requirement, proof-less Add, invalid update-path leaf).
- Plan 08-03's D-11 unsupported-profile load-time classification and traffic refusal is unaffected by this plan's changes (different seams: load-time classification vs. per-message admission).
- Full suite: 100 files / 1136 tests passing (was 99/1125 before this plan); `pnpm compile` and full-project `tsc --noEmit` both clean; `pnpm exec prettier --check` clean on all touched paths.

---
*Phase: 08-groupcontext-profile-requirement-legality-seam-extension*
*Completed: 2026-09-15*

## Self-Check: PASSED

All 8 created/modified files listed above verified present on disk; all 3 task commit hashes (7042b02, 5c7197d, 81919d1) verified in `git log --all`.
