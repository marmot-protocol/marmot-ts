---
phase: 09-self-update-replacement-leaf-identity-binding
verified: 2026-09-24T18:10:02Z
status: passed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 9: Self-Update / Replacement-Leaf Identity Binding Verification Report

**Phase Goal:** Replacing a member's leaf — via self-update or a committer's update-path — preserves the member's
account identity and keeps the `0x8009` proof correctly bound to the leaf's resulting signature key, on every
legality seam. Validation-only this milestone; no new key-rotation API.

**Verified:** 2026-09-24T18:10:02Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | An Update proposal or committer update-path leaf whose `BasicCredential` identity differs from the member's prior account identity is rejected on every seam | ✓ VERIFIED | `validateCommitAccountIdentityProofs` (src/core/components/integrity.ts:502-543) compares `getCredentialPubkey(entry.leaf.credential)` against `getCredentialPubkey(entry.parentLeaf.credential)` for both `update-proposal` and `committer-update-path` classification buckets, returning `member-identity-changed`. This is the single chokepoint reached by all six `src/` call sites (`fork-recovery.ts` ×3, `group-engine.ts` ×2, `ingest.ts` ×1) — confirmed by direct grep/read of each site. Pinned by `integrity.test.ts` Tests 1–9 in the "replacement-leaf identity (UPD-01...)" describe block (both buckets, distinctness from invalid-proof, freed-slot regression, fail-closed, both undecidable paths, precedence, privacy, positive control) — all 62 tests in `integrity.test.ts` pass. |
| 2 | A replacement leaf whose `0x8009` proof does not bind that leaf's resulting signature key (a stale or reused proof) is rejected | ✓ VERIFIED | Same proof-validity check in `validateCommitAccountIdentityProofs` runs before classification for every changed leaf (integrity.ts:471-496), unconditionally. Pinned by `integrity.test.ts` "UPD-02" describe block (4 tests): a genuinely stale proof (`forgeKeyPackage({proof:"stale"})`, validly signed but bound to a *different* MLS signature key) rejects as `invalid-proof`; envelope decodes cleanly (proves rejection is signature-verification, not decode failure); stale and tampered rejections assert byte-identical `reason`/`proofReason` (D-08 indistinguishability, executable, not just documented); positive control confirms an honest leaf stays legal. |
| 3 | A commit that removes `0x8009` support or data from a non-blank member leaf is rejected | ✓ VERIFIED | Two independent, already-existing enforcement paths, both regression-pinned with zero new validator code (confirmed via `git show --stat` on commits `4a5aa7c`/`d8852ad` — only `integrity.test.ts` touched): (a) the changed-leaf proof check in `validateCommitAccountIdentityProofs` rejects a stripped replacement leaf, proofReason derived dynamically from the validator's own throw; (b) `validateAppComponentIntegrity`'s pre-existing leaf-only guard rejects an `AppDataUpdate` targeting `0x8009` as `component-integrity`. Pinned by `integrity.test.ts` "UPD-03" describe block (4 tests, all pass), including a control that a blanked/removed leaf is never misreported as a removal. |
| 4 | A standalone Update proposal is re-checked for proof validity and identity equality at admission, before it is queued | ✓ VERIFIED | `validateUpdateProposalAccountIdentityProofs` (integrity.ts:676-751) is wired at three admission points, confirmed by direct read: `admin-policy.ts`'s inbound proposal branch (line 298), `group-engine.ts`'s local `case "proposal"` send path (line 1013), and `group-engine.ts`'s undecodable-admin-policy fallback callback (line 3511). `ingest.ts`'s standalone-proposal rejection-labeling path also re-derives the violation through this validator (line 632) so the surfaced reason is correct, not the generic `admin-policy` fallback. Pinned by `standalone-update-admission.test.ts` (5 tests, all pass): local-gate rejection (missing proof, identity swap), inbound rejection, honest-inbound-staged no-false-positive control, and honest `selfUpdate` control — plus 6 pure-validator tests in `integrity.test.ts`. |

**Score:** 4/4 roadmap success criteria verified; 8/8 phase must-haves verified (see below).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/core/components/leaf-replacement.ts` | `classifyChangedLeaf`, D-01 three-bucket classifier | ✓ VERIFIED | Exists, 113 lines, pure/total/non-throwing, matches plan spec exactly (read in full — bucket order Add→Update→Committer→fallback, `undecidable` only from `input===undefined` or committer-absent-no-match, never from empty proposals array) |
| `ChangedLeaf.parentLeaf` (`tree-diff.ts`) | prior occupant field | ✓ VERIFIED | Field present, populated from `beforeLeaf` local at the single push site (line 78) |
| `deferredReasons.unjudgeableIdentity` (`inbound.ts`) | `"unjudgeable_identity"` | ✓ VERIFIED | Present at line 87 |
| `AccountIdentityProofRejectReason` literals | `member-identity-changed`, `unattributable-leaf` | ✓ VERIFIED | Both present in the union (account-identity-proof.ts:125-126) |
| `src/core/components/integrity.ts` `CommitLegalityOutcome` | tri-state union | ✓ VERIFIED | `{kind:"legal"}\|{kind:"violation",violation}\|{kind:"undecidable",detail}` at line 109; `validateCommitAccountIdentityProofs` and `validateCommitLegality` both return it, with non-short-circuiting precedence confirmed by direct read (integrity.ts:844-885) |
| `src/core/components/integrity.ts` `validateUpdateProposalAccountIdentityProofs` | pure Update-branch admission validator | ✓ VERIFIED | Exists at line 676, returns `CommitIntegrityViolation \| undefined` (not the tri-state, per D-10), matches plan spec |
| `src/engine/fork-recovery.ts` undecidable mapping | maps to `temporary_refusal` deferral | ✓ VERIFIED | `validateLegalityWithoutProposals` and both `resolveCandidateParent` sites switch on `outcome.kind`, confirmed by direct read (lines 176-300) |
| `src/engine/group-engine.ts` undecidable mapping | fail-closed on send, pooled on tree sweep | ✓ VERIFIED | `#assertStagedCommitLegal` and tree-sweep site confirmed (lines 1519-1531, 2111-2123) |
| `src/engine/ingest.ts` undecidable mapping | deferred with `unjudgeableIdentity`, no dedup/setState | ✓ VERIFIED | Confirmed at lines 835-864; no `dedup.remember`/`ctx.setState` in that branch |
| `src/engine/admin-policy.ts` inbound Update gate | admission branch | ✓ VERIFIED | Wired at line 298 inside the `incoming.kind === "proposal"` branch; stale "deferred to Phase 9" comment replaced |
| `src/engine/group-engine.ts` local Update gate + undecodable-fallback gate | admission branches | ✓ VERIFIED | Both confirmed (lines 1013, 3511) |
| `src/engine/__tests__/standalone-update-admission.test.ts` | UPD-04 admission suite | ✓ VERIFIED | 5 tests, all pass, substantive (real `MarmotGroupEngine`, real ingest, real proposal construction — not stubs) |
| `src/__tests__/helpers/account-identity-proof-fixtures.ts` | `spliceLeafAtIndex`, `stripLeafAccountIdentityProof`, `forgeKeyPackage({proof:"stale"})` | ✓ VERIFIED | All present and consumed by downstream plans' tests |
| Root exports snapshot (`src/__tests__/exports.test.ts`) | `classifyChangedLeaf`, `validateUpdateProposalAccountIdentityProofs`; no `CommitLegalityOutcome` leak | ✓ VERIFIED | Both names present (lines 144, 331); `CommitLegalityOutcome` absent (type-only, correctly excluded) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `validateCommitAccountIdentityProofs` | `classifyChangedLeaf` | direct call per changed leaf | ✓ WIRED | integrity.ts:498 |
| `validateCommitAccountIdentityProofs` | `getCredentialPubkey` | identity comparison | ✓ WIRED | integrity.ts:518-519 |
| `validateCommitLegality` | `validateCommitAccountIdentityProofs` | forwards `classification` | ✓ WIRED | integrity.ts:844-850 |
| `fork-recovery.ts` (×3) | `validateCommitLegality`/`validateLegalityWithoutProposals` | tri-state switch | ✓ WIRED | confirmed at all 3 sites |
| `group-engine.ts` (×2 legality, ×3 Update-admission) | `validateCommitLegality`/`validateUpdateProposalAccountIdentityProofs` | tri-state switch / admission gate | ✓ WIRED | confirmed at all 5 sites |
| `ingest.ts` | `validateCommitLegality` + `deferredReasons.unjudgeableIdentity` | undecidable → deferred yield | ✓ WIRED | confirmed |
| `ingest.ts` | `validateUpdateProposalAccountIdentityProofs` | rejection re-labeling | ✓ WIRED | confirmed at line 632 |
| `admin-policy.ts` | `validateUpdateProposalAccountIdentityProofs` | inbound proposal admission | ✓ WIRED | confirmed at line 298 |

### Behavioral Spot-Checks / Regression Suite Execution

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Focused Phase 9 + regression suites (10 files) | `pnpm vitest run src/core/components/__tests__/{integrity,leaf-replacement,tree-diff}.test.ts src/engine/__tests__/{standalone-update-admission,standalone-add-admission,account-identity-proof-seams,commit-legality-seams,send-commit-legality,known-state-fallback-legality,group-engine}.test.ts` | 151/151 tests pass | ✓ PASS |
| Full workspace suite (run once) | `pnpm vitest run` | 111 files / 1249 tests pass, 0 failures | ✓ PASS |
| Library build typecheck | `pnpm compile` (`tsc -b tsconfig.build.json`) | exit 0 | ✓ PASS |
| Full typecheck incl. tests | `tsc -p tsconfig.json --noEmit` | exit 0 | ✓ PASS |
| D-01 freed-slot regression (not a false positive) | read `integrity.test.ts` Test 4 (lines 908-968) | explicit assertion that the new member's leaf lands in the *removed* member's slot before asserting `legal` | ✓ PASS (not weakened) |
| No new validator code in 09-04 (D-07 claim) | `git show --stat 4a5aa7c d8852ad` | both commits touch only `src/core/components/__tests__/integrity.test.ts` | ✓ CONFIRMED |
| No debt markers in phase-modified production files | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` over 10 modified files | 0 matches in any file | ✓ CLEAN |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| UPD-01 | 09-01, 09-02 | Identity-change rejection on every seam | ✓ SATISFIED | Single chokepoint (`validateCommitLegality`) reached by all six seam call sites; pure-validator tests pass for both classification buckets |
| UPD-02 | 09-04 (ratifies 08's check) | Stale/reused proof rejection | ✓ SATISFIED | Named regression tests using a genuinely stale (not tampered) proof |
| UPD-03 | 09-04 (ratifies 08's checks) | 0x8009 removal rejection | ✓ SATISFIED | Named regression tests on both independent enforcement paths |
| UPD-04 | 09-03 | Standalone Update admission re-check | ✓ SATISFIED | New validator wired at 3 admission points + ingest labeling fix, 11 total tests (5 engine + 6 pure-validator) |

No orphaned requirements: REQUIREMENTS.md's Phase 9 traceability rows (UPD-01..04) are all claimed by a plan's frontmatter `requirements` field.

**Note (non-blocking documentation staleness):** `.planning/REQUIREMENTS.md`'s checkbox list still shows `UPD-02`, `UPD-03`, `UPD-04` unchecked (`[ ]`) and its traceability table marks them `Pending`, even though `UPD-01`'s row was updated to `Complete` by the 09-02 wave-completion commit (`929888e`). The commits closing 09-03 (`d4c421c`) and 09-04 (`41d8334`) did not touch `REQUIREMENTS.md`. This is a documentation-sync gap in the wave-completion process, not a codebase gap — all four requirements are functionally implemented and test-verified as shown above. Recommend the orchestrator update `REQUIREMENTS.md`'s checkboxes and traceability table for UPD-02/03/04 as part of phase closeout.

### Anti-Patterns Found

None. No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers, no stub returns, no hardcoded-empty data paths in any of the 10 production/test files this phase modified.

### Assessment of the Load-Bearing Claim (09-04 / D-07)

Verified directly, not taken on SUMMARY's word: `git show --stat` on both 09-04 commits (`4a5aa7c`, `d8852ad`) confirms the only file touched in either commit is `src/core/components/__tests__/integrity.test.ts`. UPD-02 and UPD-03 are enforced entirely by Phase 8's pre-existing changed-leaf proof-validity check plus Phase 9's own tri-state (09-02), read and confirmed at integrity.ts:471-496 (proof check, unconditional, runs before classification) and the pre-existing `validateAppComponentIntegrity` leaf-only guard. This ratification claim holds.

### Assessment of the Deviations Called Out for Review

- **(a) Non-short-circuiting undecidable propagation** (`validateCommitLegality`/`validateLegalityWithoutProposals`): confirmed by direct read (integrity.ts:844-885) — an `undecidable` identity outcome is remembered but disband-legality and admin-leaf-coupling checks still run, with a violation from either outranking the remembered undecidable. `known-state-fallback-legality.test.ts` (the regression this fixes) passes.
- **(b) `ingest.ts` mislabeling fix**: confirmed at ingest.ts:628-635 — the standalone-proposal rejection branch now re-derives via `validatePreApplyProposals(...) ?? validateUpdateProposalAccountIdentityProofs(...)`, matching the pre-existing D-05 commit-branch pattern. `standalone-update-admission.test.ts`'s inbound-rejection test asserts the correct `reason`/`proofReason` and audit label.

Both deviations are structurally sound, narrowly scoped, and test-confirmed.

### Known, Documented Scope Limitation (D-11 seam-parity gap)

UPD-01's identity-change payload is tested at the pure-validator level only (`validateCommitAccountIdentityProofs` called directly with a spliced leaf), not with a full wire-valid forged commit at each of the four seams (send / inbound-ingest / fork-recovery / tree-fed). This is documented in `integrity.test.ts` itself and in the 09-02 SUMMARY: ts-mls does not export leaf-signing helpers from its package root (and CLAUDE.md forbids subpath imports, which would fail the vendor guard), so a wire-valid identity-changing replacement leaf cannot be constructed by this test suite; a hand-forged unsigned one would be refused by `processMessage`'s own signature check before reaching this validator, which would make the test pass for the wrong reason. This does not weaken the enforcement itself — the check lives in the single chokepoint (`validateCommitLegality`) reached by all six seam call sites, the same architecture pattern already established and verified in Phase 8 — it only means seam-level test breadth for this specific payload shape is narrower than for the other three requirements. This is called out as a deliberate, cross-referenced (Phase 11 QA gate) limitation rather than an oversight, and does not block this verification.

## Gaps Summary

No gaps found. All 4 roadmap success criteria and all plan-level must-haves are verified directly against the codebase: the classifier, tri-state, and identity-equality enforcement exist and are wired at every one of the six commit-legality call sites and three standalone-Update admission points; the full test suite (111 files / 1249 tests) passes; `pnpm compile` and a full `tsc --noEmit` both exit 0; no debt markers exist in any phase-modified file; the "no new validator code in 09-04" claim is confirmed by git diff, not assumed from SUMMARY text.

The only non-blocking finding is the stale `REQUIREMENTS.md` checkbox/traceability state for UPD-02/03/04 (documentation-sync only, noted above).

---

*Verified: 2026-09-24T18:10:02Z*
*Verifier: Claude (gsd-verifier)*
