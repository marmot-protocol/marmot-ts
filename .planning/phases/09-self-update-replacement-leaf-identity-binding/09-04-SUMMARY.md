---
phase: 09-self-update-replacement-leaf-identity-binding
plan: 04
subsystem: mls-protocol
tags: [mls, account-identity-proof, regression-tests, self-update, ts-mls]

# Dependency graph
requires:
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "01"
    provides: "forgeKeyPackage({ proof: \"stale\" }), spliceLeafAtIndex, stripLeafAccountIdentityProof test fixtures"
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "02"
    provides: "CommitLegalityOutcome tri-state, validateCommitAccountIdentityProofs changed-leaf proof-validity check"
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "03"
    provides: "validateUpdateProposalAccountIdentityProofs exported, exports.test.ts snapshot already current"
provides:
  - "UPD-02 ratified: named regression tests pin that a replacement leaf whose 0x8009 proof does not bind its resulting MLS signature key is rejected as invalid-proof"
  - "UPD-03 ratified: named regression tests pin both of its existing enforcement paths (changed-leaf proof check, AppDataUpdate leaf-only guard)"
  - "D-08 cryptographic indistinguishability (stale vs tampered proof) asserted executably, not just documented"
  - "Full suite green at 111 files / 1249 tests with every Phase 9 gate active"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A wire-shape-valid-but-Marmot-layer-invalid replacement leaf must start from a genuine createUpdateProposal-sourced leaf (fresh signature) before being mutated -- diffChangedLeaves (tree-diff.ts) detects a 'changed' leaf only by comparing signature bytes against the parent leaf at the same index, so an in-place extension edit on an unmodified leaf (same signature bytes) is invisible to the changed-leaf loop and would silently report legal for the wrong reason"
    - "The classification bucket a test attributes a changed leaf to is not load-bearing for a proof-validity assertion: validateCommitAccountIdentityProofs runs its proof check (step b) unconditionally for every changed leaf, before classifyChangedLeaf (step c) ever runs -- proof-invalidity tests need no committer/proposal match to reach a violation"

key-files:
  created: []
  modified:
    - src/core/components/__tests__/integrity.test.ts

key-decisions:
  - "Split the single-file change into two commits by reconstructing intermediate file states (committed Task 1 content + appended Task 2 block) rather than one combined commit, preserving the per-task atomic-commit convention even though both tasks touch the same file and share import lines"
  - "UPD-02 Tests 1/3/4 splice the fixture leaf directly (no re-sign needed) since forgeKeyPackage's stale/tampered leaves are freshly generated KeyPackage-sourced leaves with their own distinct signature from the start -- only UPD-03's fixture (an in-place extension strip of an EXISTING member's own leaf) needed the createUpdateProposal re-sign workaround, because stripLeafAccountIdentityProof edits a leaf without ever re-signing it"
  - "UPD-03 Test 3 (AppDataUpdate leaf-only guard) needed no splice or re-sign fixture at all -- validateAppComponentIntegrity's leaf-only guard triggers purely from the commit's own proposal list (collectAppDataUpdateOps), independent of any tree diff, so parentState and resultingState can be the same unchanged ClientState"

requirements-completed: [UPD-02, UPD-03]

coverage:
  - id: D1
    description: "A replacement leaf whose 0x8009 proof is validly signed but bound to a DIFFERENT MLS signature key (a genuine key-rotation-stale proof, not a bit-flip) is rejected as invalid-proof, carrying the leaf's true MLS index"
    requirement: "UPD-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-02 Test 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "The stale proof's 104-byte envelope decodes cleanly (decodeAuthorizationProof succeeds, signerPubkey matches the real account) -- the rejection is attributable to signature verification (validator step 11), not a decode failure"
    requirement: "UPD-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-02 Test 2"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-08's cryptographic indistinguishability is an executable claim: a stale proof and a tampered proof surface byte-identical reason and proofReason (both invalid-proof)"
    requirement: "UPD-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-02 Test 3"
        status: pass
    human_judgment: false
  - id: D4
    description: "A leaf whose proof genuinely matches its own signature key (honest self-update) stays legal -- positive control proving Test 1 does not pass for an unrelated reason"
    requirement: "UPD-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-02 Test 4"
        status: pass
    human_judgment: false
  - id: D5
    description: "A replacement leaf with its app_data_dictionary stripped is rejected with the validator's own absent-support/absent-data reason (derived dynamically, not hardcoded), carrying the leaf's MLS index"
    requirement: "UPD-03"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-03 Test 1"
        status: pass
    human_judgment: false
  - id: D6
    description: "The rejection fires before any identity comparison -- a stripped leaf that preserves the member's credential identity is still rejected on a proof-material reason, never member-identity-changed"
    requirement: "UPD-03"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-03 Test 2"
        status: pass
    human_judgment: false
  - id: D7
    description: "An AppDataUpdate proposal targeting 0x8009 is rejected by validateCommitLegality as component-integrity (the independent Phase 7/8 leaf-only guard), not account-identity-proof"
    requirement: "UPD-03"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-03 Test 3"
        status: pass
    human_judgment: false
  - id: D8
    description: "A blanked (removed) leaf is never validated, so a legitimate Remove is not misreported as a 0x8009 removal"
    requirement: "UPD-03"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#UPD-03 Test 4"
        status: pass
    human_judgment: false
  - id: D9
    description: "The root exports snapshot already names both classifyChangedLeaf and validateUpdateProposalAccountIdentityProofs (landed in plans 09-01/09-03) and no type-only symbol (CommitLegalityOutcome) leaks into it; the entire suite is green with every Phase 9 gate active"
    verification:
      - kind: unit
        ref: "src/__tests__/exports.test.ts (unchanged; pnpm vitest run -u produced a zero-diff run)"
        status: pass
      - kind: other
        ref: "pnpm vitest run: 111 files / 1249 tests pass (baseline 111/1241 + 8 new); pnpm compile and tsc -p tsconfig.json --noEmit both exit 0; pnpm exec prettier --check src/core/components src/core/inbound.ts src/engine src/__tests__ exits 0"
        status: pass
    human_judgment: false

# Metrics
duration: 34min
completed: 2026-09-24
status: complete
---

# Phase 9 Plan 4: Self-Update Replacement-Leaf Identity Binding -- UPD-02/UPD-03 Regression Tests + Exports Snapshot Summary

**UPD-02 and UPD-03 ratified by 8 new named regression tests with zero new validator code -- both were already enforced by the Phase 8 changed-leaf path; the exports snapshot was already current from plans 09-01/09-03, and the full suite is green at 111 files / 1249 tests with every Phase 9 gate active**

## Performance

- **Duration:** ~34 min
- **Started:** 2026-09-24T17:52:00Z (approx.)
- **Completed:** 2026-09-24T18:26:00Z (approx.)
- **Tasks:** 3 completed (Task 3 required no code change -- verification only)
- **Files modified:** 1 (`src/core/components/__tests__/integrity.test.ts`)

## Accomplishments

- **UPD-02** ratified with a 4-test `describe("UPD-02: replacement leaf whose 0x8009 proof does not bind its resulting signature key")` block: a genuinely stale proof (validly signed by the real account, but bound to a DIFFERENT MLS signature key -- `forgeKeyPackage({ proof: "stale" })` from plan 09-01) is rejected as `invalid-proof` carrying the leaf's true MLS index; the 104-byte envelope is shown to decode cleanly via `decodeAuthorizationProof` before the signature check fails, proving the rejection is attributable to step 11 (signature verification), not a decode failure; D-08's indistinguishability from a corrupt proof is asserted executably (stale and tampered rejections are byte-identical in `reason` + `proofReason`); a positive control confirms an honest self-update stays legal
- **UPD-03** ratified with a 4-test `describe("UPD-03: removing 0x8009 support or data from a non-blank member leaf")` block covering both of its independent enforcement paths: the changed-leaf proof check rejects a stripped replacement leaf (proofReason derived dynamically from the validator's own throw, not hardcoded, and pinned to fire before any identity comparison), and the pre-existing Phase 7/8 leaf-only guard separately rejects an `AppDataUpdate` targeting `0x8009` as `component-integrity`; a fourth test pins that a blanked (removed) leaf is never misreported as a `0x8009` removal
- **Root exports snapshot verified current**: `classifyChangedLeaf` and `validateUpdateProposalAccountIdentityProofs` (landed in plans 09-01 and 09-03 respectively) were already present; `pnpm vitest run src/__tests__/exports.test.ts -u` produced a zero-diff run, confirming no drift
- **Full suite verified green** at every Phase 9 gate: 111 files / 1249 tests (baseline 111/1241 + this plan's 8 new tests), `pnpm compile` and `tsc -p tsconfig.json --noEmit` both exit 0, and `pnpm exec prettier --check` over the phase's touched paths reports no differences

## Task Commits

Each task was committed atomically:

1. **Task 1: UPD-02 stale and reused proof regression tests** - `4a5aa7c` (test)
2. **Task 2: UPD-03 stripped-support and stripped-data regression tests** - `d8852ad` (test)
3. **Task 3: Exports snapshot, full-suite regression, and formatting** - no commit (verification-only; `src/__tests__/exports.test.ts` was already current, zero diff produced)

**Plan metadata:** commit pending (this SUMMARY, applied by the orchestrator after wave completion -- this is a worktree-isolated executor run; STATE.md/ROADMAP.md are NOT updated here per orchestrator ownership)

## Files Created/Modified

- `src/core/components/__tests__/integrity.test.ts` -- two new describe blocks (`UPD-02...`, `UPD-03...`, 8 tests total) plus supporting imports (`hexToBytes`, `getComponentData`, `decodeAuthorizationProof`, `AUTHORIZATION_PROOF_LENGTH`)

## Decisions Made

- Split the single-file change into two atomic commits (one per task) by reconstructing intermediate file states rather than combining both tasks into one commit, even though both edit the same file and share import lines -- preserved the per-task commit convention this project follows
- UPD-03's fixture needed a genuine `createUpdateProposal`-sourced leaf (fresh signature) before stripping, because `diffChangedLeaves` only classifies a leaf as "changed" by comparing `signature` bytes against the parent leaf at the same index; an in-place extension edit with no re-sign is invisible to that diff and silently returns `legal`. This is a genuine empirical finding about `tree-diff.ts`'s detection mechanism, not something the plan's read_first list called out explicitly, though it follows directly from `diffChangedLeaves`'s documented comment. UPD-02's stale/tampered leaves needed no such workaround because `forgeKeyPackage` builds a brand-new `KeyPackage` via `generateKeyPackageWithKey`, which always has its own freshly-generated, distinct signature from the leaf it replaces
- UPD-03 Test 3 (the `AppDataUpdate` leaf-only guard) needed no tree splice at all -- `validateAppComponentIntegrity`'s guard reads only the commit's proposal list (`collectAppDataUpdateOps`), so `parentState`/`resultingState` can be the same unchanged `ClientState`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Initial UPD-03 Test 1/2 fixtures produced `legal` instead of `violation`**
- **Found during:** Task 2, first test run after writing the block
- **Issue:** The first draft spliced `stripLeafAccountIdentityProof(adminNode.leaf)` directly at the SAME index the leaf already occupied. Since `stripLeafAccountIdentityProof` only edits `extensions` and never re-signs, the spliced leaf's `signature` bytes were byte-identical to the parent leaf's `signature` at that index. `diffChangedLeaves` (`tree-diff.ts`) treats a byte-identical signature as "unchanged" and skips it entirely (D-01: unchanged leaves are trusted, not re-validated) -- so the changed-leaf loop never even inspected the stripped leaf, and `validateCommitAccountIdentityProofs` correctly returned `legal` for a commit that, from the validator's structural perspective, changed nothing
- **Fix:** Rebuilt the fixture to first produce a genuinely re-signed replacement leaf via `createUpdateProposal` (the same technique plan 09-03's inbound UPD-04 fixture used for an analogous ts-mls wire-shape constraint), THEN strip that fresh leaf's `app_data_dictionary`. The fresh leaf's `signature` differs from the parent's (a real update path re-signs), so `diffChangedLeaves` now correctly reports it as changed, and the subsequent strip makes it Marmot-layer-invalid without needing to forge a signature
- **Files modified:** `src/core/components/__tests__/integrity.test.ts` (Task 2, before commit)
- **Verification:** `pnpm vitest run src/core/components/__tests__/integrity.test.ts` -- both tests pass with the corrected fixture; re-ran the full suite afterward with no other regressions
- **Committed in:** `d8852ad` (Task 2 commit; the flawed intermediate version was never committed)

**2. [Rule 3 - Blocking] `grep -c "UPD-03"` initially fell short of the acceptance criterion's minimum of 4**
- **Found during:** Task 2, acceptance-criteria self-check before commit
- **Issue:** The describe block title and its preceding JSDoc comment together only produced 2 literal `UPD-03` occurrences, short of the plan's stated `grep -c "UPD-03" ... outputs at least 4`
- **Fix:** Added an explicit `(UPD-03)` marker to each of the 4 test names in the block (matching the style already used for UPD-01's and UPD-04's test titles elsewhere in the same file), bringing the count to 6
- **Files modified:** `src/core/components/__tests__/integrity.test.ts`
- **Verification:** `grep -c "UPD-03" src/core/components/__tests__/integrity.test.ts` -> 6; also bumped UPD-02's equivalent count from an already-sufficient 4 by inspection, no change needed there
- **Committed in:** `d8852ad` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking acceptance-criteria gap) -- both caught and corrected before any commit landed; no existing assertion was weakened, and D-07 (no new production code) held throughout both fixes, which were test-fixture-only corrections
**Impact on plan:** Neither fix touched a non-test file; `git diff --name-only -- src | grep -v "__tests__"` lists nothing for either task's commit, satisfying the plan's own explicit acceptance criterion.

## Issues Encountered

- This worktree had `ts-mls`, `refs/mdk`, and `refs/marmot` git submodules uninitialized (all showed `-` in `git submodule status`) when spawned. Initialized all three with `git submodule update --init <path>` and ran `pnpm install --frozen-lockfile` (which also built the `ts-mls` fork via its `prepare` script) before any test could run. This is worktree-local setup, not a code change, and no submodule pointer appears in either commit (verified via `git diff --submodule=log`).
- No other issues. Both tasks' `<action>` text anticipated the exact empirical finding this plan required (the wire-codec / signature-detection constraint), so no architectural surprises (Rule 4) arose.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- UPD-02 and UPD-03 are both fully ratified: every requirement this phase set out to close (UPD-01 by plans 09-01/09-02, UPD-04 by plan 09-03, UPD-02/UPD-03 by this plan) now has named, passing regression coverage
- Full suite: 111 files / 1249 tests pass; `pnpm compile` and `tsc -p tsconfig.json --noEmit` both exit 0; `pnpm exec prettier --check` clean over the phase's touched paths
- No blockers for phase completion. Per the plan's own `<verification>` section, a code-review pass focused on the tri-state seam mappings (and whether each new regression row fails without its fix) is recommended as a follow-up after this plan lands -- not performed as part of this plan's scope
- `refs/mdk` and `refs/marmot` submodules were initialized locally in this worktree (not checked out when spawned); no follow-up needed, this is standard worktree-local setup already noted by plans 09-01 and 09-03

---

*Phase: 09-self-update-replacement-leaf-identity-binding*
*Completed: 2026-09-24*

## Self-Check: PASSED

Verified `src/core/components/__tests__/integrity.test.ts` exists and contains both `describe("UPD-02...")` and `describe("UPD-03...")` blocks (`grep -c "UPD-02"` -> 4, `grep -c "UPD-03"` -> 6). Both commit hashes (`4a5aa7c`, `d8852ad`) verified present in `git log --oneline`. `git diff --name-only -- src | grep -v "__tests__"` across both commits returns nothing, confirming D-07 (no new validator code). Full suite re-run after both commits: 111 files / 1249 tests pass.
