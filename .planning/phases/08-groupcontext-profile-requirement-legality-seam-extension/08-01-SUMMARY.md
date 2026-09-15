---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
plan: 01
subsystem: auth
tags: [mls, account-identity-proof, commit-legality, app-components, ts-mls]

# Dependency graph
requires:
  - phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
    provides: "validateLeafAccountIdentityProof, validateKeyPackageAccountIdentityProof, classifyGroupAccountIdentityProofProfile, assertCurrentGroupAccountIdentityProofProfile, DEFAULT_GROUP_COMPONENT_IDS requiring 0x8009, the GRP-03 join gate in groups-manager.ts"
provides:
  - "diffChangedLeaves (src/core/components/tree-diff.ts): pure ratchet-tree diff finding every new/re-signed non-blank leaf by true MLS leaf index"
  - "getGroupProfileSupport: non-throwing GroupContext profile classifier wrapping assertCurrentGroupAccountIdentityProofProfile"
  - "validateCommitAccountIdentityProofs and validateAddProposalAccountIdentityProofs in src/core/components/integrity.ts, wired into validateCommitLegality between component-integrity and disband-legality (D-07)"
  - "CommitIntegrityViolationReason 'account-identity-proof' and CommitIntegrityViolation.proofReason/.leafIndex"
  - "RejectedIngestResult.reason 'account-identity-proof' plus .proofReason/.leafIndex in src/engine/types.ts"
  - "shared test fixtures forgeKeyPackage/dropAccountIdentityProofRequirement in src/__tests__/helpers/account-identity-proof-fixtures.ts"
  - "GRP-01 creation test and two new GRP-03 Welcome-join rejection tests"
affects: [08-02, 08-03, 08-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tree-diff-based changed-leaf detection (leaf.signature byte-inequality) instead of a proposal walk, to catch Adds/Updates/update-path leaves uniformly without needing ts-mls's unexported StagedCommit machinery"
    - "Non-throwing GroupProfileSupport wrapper mirrors the existing getAppComponents try/catch precedent, keeping validateCommitLegality's non-throwing contract for fork-recovery/tree-fed convergence callers that don't wrap the call"

key-files:
  created:
    - src/core/components/tree-diff.ts
    - src/core/components/__tests__/tree-diff.test.ts
    - src/__tests__/helpers/account-identity-proof-fixtures.ts
  modified:
    - src/core/components/integrity.ts
    - src/core/components/account-identity-proof.ts
    - src/core/components/index.ts
    - src/engine/types.ts
    - src/core/components/__tests__/integrity.test.ts
    - src/core/components/__tests__/account-identity-proof.test.ts
    - src/core/__tests__/group.test.ts
    - src/client/__tests__/join-account-identity-proof.test.ts
    - src/__tests__/exports.test.ts

key-decisions:
  - "diffChangedLeaves compares leaf.signature byte-inequality rather than re-implementing ts-mls's unexported leaf encoder/equality helpers"
  - "diffChangedLeaves reports the true MLS leaf index (nodeIndex/2), distinct from validateGroupMemberAccountIdentityProofs's member-enumeration index"
  - "validateCommitAccountIdentityProofs checks proof validity only on changed leaves (D-03) -- no prior-leaf identity comparison, deferred to Phase 9"
  - "validateAddProposalAccountIdentityProofs is a pure pre-apply helper (no wiring into admin-policy.ts/group-engine.ts in this plan -- that is 08-02's D-08/D-09 scope)"

patterns-established:
  - "New CommitIntegrityViolation optional fields (proofReason, leafIndex) stay pubkey-free by construction, matching the existing diagnostics-privacy convention"

requirements-completed: [GRP-01, GRP-02, GRP-03]

coverage:
  - id: D1
    description: "diffChangedLeaves finds exactly the new/re-signed non-blank leaves of a ratchet-tree diff, keyed by true MLS leaf index"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/tree-diff.test.ts#diffChangedLeaves"
        status: pass
    human_judgment: false
  - id: D2
    description: "validateCommitLegality rejects a commit that drops the 0x8009 requirement or carries an invalid changed-leaf proof, in D-07 order (component-integrity -> account-identity-proof -> disband -> admin-leaf-coupling), non-throwing"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateCommitAccountIdentityProofs and #validateCommitLegality D-07 tests"
        status: pass
    human_judgment: false
  - id: D3
    description: "validateAddProposalAccountIdentityProofs validates a standalone Add proposal's KeyPackage proof pre-apply, for plan 08-02 to wire in"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateAddProposalAccountIdentityProofs"
        status: pass
    human_judgment: false
  - id: D4
    description: "GRP-01: a newly created group requires 0x8009 in app_components, not required_capabilities, with no GroupContext-level 0x8009 data"
    requirement: "GRP-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/group.test.ts#GRP-01: a created group requires 0x8009 in app_components, not required_capabilities, with no GroupContext state"
        status: pass
    human_judgment: false
  - id: D5
    description: "GRP-03: joining via Welcome fails and persists nothing when the group does not require 0x8009 or a current member's proof is invalid"
    requirement: "GRP-03"
    verification:
      - kind: unit
        ref: "src/client/__tests__/join-account-identity-proof.test.ts#GRP-03 tests (4 cases)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-09-15
status: complete
---

# Phase 8 Plan 1: GroupContext Profile Requirement & Legality-Seam Extension (Core Adapter) Summary

**Extended the single shared `validateCommitLegality` adapter with a tree-diff-based `0x8009` profile/changed-leaf-proof check (D-01..D-07), plus the pure pre-apply Add-proposal helper for 08-02, and pinned GRP-01/GRP-03 with named tests.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-09-15
- **Tasks:** 3
- **Files modified:** 12 (3 new, 9 modified)

## Accomplishments
- New `src/core/components/tree-diff.ts`: `diffChangedLeaves` — a pure structural diff over two ratchet trees using `leaf.signature` byte-inequality to find every non-blank leaf that is new (Add) or re-signed (Update proposal, or the committer's own update-path leaf), keyed by the true MLS leaf index.
- `getGroupProfileSupport` (account-identity-proof.ts): a non-throwing wrapper over `assertCurrentGroupAccountIdentityProofProfile`, used by both the new commit-legality check and (future) D-11 load-time classification.
- `validateCommitAccountIdentityProofs` and `validateAddProposalAccountIdentityProofs` (integrity.ts): the former is wired into `validateCommitLegality` between component-integrity and disband-legality (D-07), so send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence all inherit profile-drift and changed-leaf proof enforcement from the one shared adapter with no seam-local changes. The latter is a pure pre-apply helper for plan 08-02 to wire into the standalone-Add admission gates.
- `CommitIntegrityViolationReason` gained `"account-identity-proof"`; `CommitIntegrityViolation` gained optional pubkey-free `proofReason`/`leafIndex`; the same literal and fields were added to `RejectedIngestResult` in `src/engine/types.ts`.
- Shared test fixtures (`forgeKeyPackage`, `dropAccountIdentityProofRequirement`) for forging missing/tampered-proof KeyPackages and a requirement-drop commit proposal, reused across this plan's own tests and available to 08-02..08-04.
- GRP-01 (creation) and GRP-03 (Welcome join, 4 rejection cases) pinned with named tests; the root exports snapshot updated for the 4 new runtime exports.

## Task Commits

Each task was committed atomically:

1. **Task 1: Pure changed-leaf tree diff and shared forged-fixture helpers** - `8000832` (feat)
2. **Task 2: Profile/proof check inside validateCommitLegality plus the Add-proposal helper** - `70792e3` (feat)
3. **Task 3: Exports snapshot, GRP-01 creation test, GRP-03 join tests, full-suite regression** - `97d46d8` (test)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/core/components/tree-diff.ts` - `ChangedLeaf`, `diffChangedLeaves`
- `src/core/components/__tests__/tree-diff.test.ts` - 4 tests over real MLS groups
- `src/__tests__/helpers/account-identity-proof-fixtures.ts` - `forgeKeyPackage`, `dropAccountIdentityProofRequirement`
- `src/core/components/integrity.ts` - `validateCommitAccountIdentityProofs`, `validateAddProposalAccountIdentityProofs`, extended reason union/violation shape, D-07 wiring
- `src/core/components/account-identity-proof.ts` - `GroupProfileSupport`, `getGroupProfileSupport`
- `src/core/components/index.ts` - re-export `tree-diff.js`
- `src/engine/types.ts` - `RejectedIngestResult` reason literal + `proofReason`/`leafIndex`
- `src/core/components/__tests__/integrity.test.ts` - new describe blocks + 3 D-07 ordering tests; 2 pre-existing fixtures fixed to declare 0x8009
- `src/core/components/__tests__/account-identity-proof.test.ts` - `getGroupProfileSupport` describe block
- `src/core/__tests__/group.test.ts` - GRP-01 test
- `src/client/__tests__/join-account-identity-proof.test.ts` - 2 new GRP-03 tests + retitled 2 existing tests
- `src/__tests__/exports.test.ts` - updated inline snapshot

## Decisions Made
- `diffChangedLeaves` reports the true MLS tree leaf index (`nodeIndex / 2`), never the member-enumeration index `validateGroupMemberAccountIdentityProofs` uses internally, per the plan's explicit warning that the two differ once any leaf is blank.
- `validateAddProposalAccountIdentityProofs` is left unwired in this plan (no `admin-policy.ts`/`group-engine.ts` changes) — that is plan 08-02's explicit D-08/D-09 scope per this plan's `files_modified` frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's Test 2 expectation for tree-diff didn't match RFC 9420 / ts-mls behavior**
- **Found during:** Task 1
- **Issue:** The plan's Test 2 expected an Add-only commit to also re-sign the committer's own leaf ("plus the committer's update-path leaf"). Per ts-mls's `needsUpdatePath` (`clientState.ts`), a commit whose proposals are entirely Add/PSK/ReInit/AppDataUpdate does not generate an update path, so the committer's leaf is genuinely untouched for an Add-only commit.
- **Fix:** Corrected the test to assert only the new member's leaf changes for an Add-only commit; the committer's-own-leaf-changes case remains covered by the self-update test (Test 1).
- **Files modified:** src/core/components/__tests__/tree-diff.test.ts
- **Verification:** `pnpm vitest run src/core/components/__tests__/tree-diff.test.ts` — 4/4 pass
- **Committed in:** 8000832 (Task 1 commit)

**2. [Rule 1 - Bug] Fixture import path bug in account-identity-proof-fixtures.ts**
- **Found during:** Task 2
- **Issue:** `makeLeafAppComponentsExtension` was imported from `account-identity-proof.js`, but it is defined in `dictionary.js` — a `TypeError: ... is not a function` at test run time.
- **Fix:** Moved the import to `../../core/components/dictionary.js`.
- **Files modified:** src/__tests__/helpers/account-identity-proof-fixtures.ts
- **Verification:** `pnpm vitest run src/core/components/__tests__/integrity.test.ts` — all `forgeKeyPackage`-dependent tests pass
- **Committed in:** 70792e3 (Task 2 commit)

**3. [Rule 1 - Bug] Two pre-existing `validateCommitLegality` test fixtures tripped the new D-01a profile check**
- **Found during:** Task 2
- **Issue:** "derives requiredIds from the PARENT state" and "returns undefined for a benign commit" used `app_components` lists that did not include `0x8009`, so with the new profile check wired in they now legitimately classify as `"neither"` (missing-requirement) instead of exercising only the component-integrity/admin-coupling logic they were written to test.
- **Fix:** Added `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` to both fixtures' required-component lists (and the corresponding `AppDataUpdate` proposal bytes for the first), so both represent a current-profile group — matching every real Marmot group and leaving the new check's coverage unweakened.
- **Files modified:** src/core/components/__tests__/integrity.test.ts
- **Verification:** `pnpm vitest run src/core/components/__tests__/integrity.test.ts` — 39/39 pass
- **Committed in:** 70792e3 (Task 2 commit)

**4. [Rule 1 - Doc-only] Removed a literal `integrity.js` string from a docstring**
- **Found during:** Task 2
- **Issue:** The plan's acceptance criteria mechanically grep `account-identity-proof.ts` for the string `"integrity.js"` (a circular-import guard) and expect 0 matches; a cross-reference comment in `getGroupProfileSupport`'s docstring used that exact literal, tripping the grep even though it was prose, not an import.
- **Fix:** Reworded the comment to describe `validateCommitLegality` without the literal module-specifier string. No behavior change.
- **Files modified:** src/core/components/account-identity-proof.ts
- **Verification:** `grep -c "integrity.js" src/core/components/account-identity-proof.ts` outputs 0
- **Committed in:** 70792e3 (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (3 test-correctness bugs, 1 doc-literal fix)
**Impact on plan:** All auto-fixes were necessary for test correctness or to satisfy the plan's own mechanical acceptance criteria. No scope creep — production logic matches the plan's D-01..D-09 design exactly.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `validateAddProposalAccountIdentityProofs` is ready for plan 08-02 to wire into `src/engine/admin-policy.ts` (D-08: remove the "no proof material" skip) and `src/engine/group-engine.ts`'s local `case "proposal"` send path (D-09).
- `getGroupProfileSupport` is ready for plan 08-03's D-11 load-time classification (`src/client/group-registry.ts` / `MarmotGroup.fromClientState`).
- The GRP-02 seam-parity matrix (D-04: identical `account-identity-proof` violation across send/inbound/replay/tree-fed) is not built in this plan — it is explicitly deferred to a later plan per the phase's roadmap note on a planned review-fix cycle.
- Full suite: 99 files / 1125 tests passing (was 98/1099 before this plan); `pnpm compile` and full-project `tsc --noEmit` both clean.

---
*Phase: 08-groupcontext-profile-requirement-legality-seam-extension*
*Completed: 2026-09-15*

## Self-Check: PASSED

All 8 created/modified files listed above verified present on disk; all 3 task commit hashes (8000832, 70792e3, 97d46d8) verified in `git log --all`.
