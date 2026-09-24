---
phase: 09-self-update-replacement-leaf-identity-binding
plan: 03
subsystem: mls-protocol
tags: [mls, account-identity-proof, admission, self-update, proposals, ts-mls]

# Dependency graph
requires:
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "01"
    provides: "classifyChangedLeaf, AccountIdentityProofRejectReason's member-identity-changed/unattributable-leaf, account-identity-proof-fixtures.ts test helpers (forgeKeyPackage, spliceLeafAtIndex, stripLeafAccountIdentityProof)"
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "02"
    provides: "CommitLegalityOutcome tri-state, UPD-01 replacement-leaf identity binding at commit time, non-short-circuiting undecidable propagation pattern"
provides:
  - "validateUpdateProposalAccountIdentityProofs -- the pure pre-apply Update-branch admission validator (CommitIntegrityViolation | undefined, not the tri-state -- pre-apply admission never defers per D-10)"
  - "UPD-04 closed: a standalone Update proposal is checked for 0x8009 proof validity and account identity equality at both admission seams before it is queued"
  - "Both admission seams wired: admin-policy.ts's inbound proposal branch (incl. the undecodable-admin-policy fallback) and group-engine.ts's local propose path"
  - "ingest.ts's standalone-proposal rejection-labeling fallback extended to the Update branch, so a rejected standalone Update surfaces the real account-identity-proof reason/proofReason instead of the generic admin-policy fallback"
affects: [09-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Standalone-proposal admission validators (validateAddProposalAccountIdentityProofs, validateUpdateProposalAccountIdentityProofs) deliberately return CommitIntegrityViolation | undefined, never the CommitLegalityOutcome tri-state -- pre-apply admission is branch-independent (no candidate parent whose later arrival could make an unresolvable sender judgeable), so D-10 rejects rather than defers"
    - "A seam's admission-gate rejection path (ingest.ts's standalone-proposal branch) must re-derive the SPECIFIC violation for labeling, not just trust the callback's binary accept/reject verdict -- otherwise a new gate's rejection surfaces as the generic admin-policy fallback reason instead of its own reason/proofReason"
    - "ts-mls's wire codec requires an Update proposal's inner LeafNode to carry leafNodeSource \"update\" specifically (leafNodeUpdateDecoder's option guard); a KeyPackage-sourced leaf reused verbatim in an Update proposal decodes on the wire as an unrecognized custom proposal, never reaching any IncomingMessageCallback -- inbound-wire UPD-04 fixtures must build a genuine \"update\"-sourced leaf via createUpdateProposal first, then mutate it, to stay wire-shape-valid while becoming Marmot-layer-invalid"

key-files:
  created:
    - src/engine/__tests__/standalone-update-admission.test.ts
  modified:
    - src/core/components/integrity.ts
    - src/core/components/__tests__/integrity.test.ts
    - src/engine/admin-policy.ts
    - src/engine/group-engine.ts
    - src/engine/ingest.ts
    - src/engine/__tests__/group-engine.test.ts
    - src/__tests__/exports.test.ts

key-decisions:
  - "ingest.ts's standalone-proposal rejection branch now re-derives the labeled violation via validatePreApplyProposals(...) ?? validateUpdateProposalAccountIdentityProofs(...), mirroring the existing D-05 commit-branch labeling pattern a few lines below -- the callback's binary accept/reject verdict alone is insufficient for correct reason/proofReason labeling once a second independent gate can cause the same reject"
  - "group-engine.test.ts's pre-existing 'D-09/D-10: ... a standalone Update is unaffected' test asserted the OLD Phase-8-deferred behavior (blanket accept); updated in place to assert the new D-10 reject-on-unresolvable-sender behavior, since this plan explicitly closes that deferral -- the test's own name already named D-10 as the rule now enforced"
  - "exports.test.ts's inline snapshot updated (npx vitest run -u) to include the newly exported validateUpdateProposalAccountIdentityProofs"
  - "UPD-04 test fixtures for the LOCAL admission gate (Test 1/2) reuse a member's KeyPackage-sourced leaf directly, since the local gate throws before any wire construction; the INBOUND fixture (Test 3) instead builds a genuine createUpdateProposal-sourced leaf first and mutates it afterward, since ts-mls's decoder requires leafNodeSource \"update\" to even recognize the wire bytes as an Update proposal"

requirements-completed: [UPD-04]

coverage:
  - id: D1
    description: "The pure Update-branch admission validator (validateUpdateProposalAccountIdentityProofs) resolves the standalone proposal's sender, rejects an unresolvable sender (D-10), validates the replacement leaf's 0x8009 proof, and compares its identity against the resolved sender's -- reporting member-identity-changed on mismatch, the same literal the commit-time path uses"
    requirement: "UPD-04"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateUpdateProposalAccountIdentityProofs (UPD-04, D-09/D-10) -- Tests 1-6"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both admission seams (inbound admin-policy.ts proposal branch, including its undecodable-admin-policy fallback, and the local group-engine.ts propose path) run the shared Update validator before a proposal is queued or published (D-09)"
    requirement: "UPD-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-add-admission.test.ts, account-identity-proof-seams.test.ts, group-engine.test.ts (regression, all pass unchanged except the one intentionally-updated D-10 assertion)"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts -- all 5 UPD-04 cases"
        status: pass
    human_judgment: false
  - id: D3
    description: "A locally built raw Update proposal intent can no longer bypass every proof and identity check -- the engine throws CommitLegalityError before createProposal for both an invalid-proof leaf and an identity-swapped leaf"
    requirement: "UPD-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts#UPD-04: the engine refuses a raw Update proposal intent whose leaf carries no 0x8009 support or data"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts#UPD-04: the engine refuses a raw Update proposal intent whose leaf credential identity is not the local client's"
        status: pass
    human_judgment: false
  - id: D4
    description: "An honest standalone Update from a current member is still staged (no false positive) and an honest local selfUpdate is unaffected -- the join-time self-update flow does not break"
    requirement: "UPD-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts#UPD-04: an honest inbound standalone Update from a current member is still staged (no false positive)"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts#UPD-04: an honest local send({ kind: 'selfUpdate' })  still succeeds and still advances to a staged pending commit"
        status: pass
    human_judgment: false
  - id: D5
    description: "An inbound standalone Update carrying an invalid leaf is rejected and never queued, surfacing reason: account-identity-proof (not the generic admin-policy fallback) -- both in the ingest result and the audit trail"
    requirement: "UPD-04"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/standalone-update-admission.test.ts#UPD-04: an inbound standalone Update carrying an invalid leaf is rejected and never queued, surfacing reason: account-identity-proof"
        status: pass
      - kind: other
        ref: "pnpm compile (tsc -b tsconfig.build.json) and tsc -p tsconfig.json --noEmit both exit 0; full pnpm vitest run: 111 files / 1241 tests pass"
        status: pass
    human_judgment: false

# Metrics
duration: 28min
completed: 2026-09-24
status: complete
---

# Phase 9 Plan 3: UPD-04 Standalone-Update Admission Summary

**`validateUpdateProposalAccountIdentityProofs` closes the standalone-Update admission gap Phase 8 explicitly deferred (08 D-10) -- both proposal admission seams now reject an unresolvable-sender, invalid-proof, or identity-changed Update before it is queued, with a fixed ingest.ts labeling bug and an empirically-discovered ts-mls wire-codec constraint (Update proposals require `leafNodeSource: "update"` to even decode) both closed along the way**

## Performance

- **Duration:** 28 min
- **Started:** 2026-09-24T17:20:00Z (approx.)
- **Completed:** 2026-09-24T17:47:54Z
- **Tasks:** 3 completed
- **Files modified:** 7 (5 production, 2 test files beyond the plan's own list — see Deviations)

## Accomplishments

- `validateUpdateProposalAccountIdentityProofs(proposals, ratchetTree, ciphersuite)` added to `src/core/components/integrity.ts`, immediately after its Add-branch sibling. Pure, non-throwing, returns `CommitIntegrityViolation | undefined` (deliberately NOT the `CommitLegalityOutcome` tri-state, since D-10 makes pre-apply admission branch-independent — there is no deferral case). For each Update proposal it resolves the sender (rejecting undefined/unresolvable as `unattributable-leaf`, D-10), validates the replacement leaf's `0x8009` proof, and compares the replacement leaf's identity against the resolved sender's, reporting `member-identity-changed` on mismatch — the same literal `validateCommitAccountIdentityProofs` uses for the equivalent post-apply check (plan 09-02), so the two admission points cannot report the same violation differently
- Both standalone-proposal admission seams now run the validator before a proposal is queued or published: `admin-policy.ts`'s `createAdminCommitPolicyCallback` proposal branch (including its previously-unguarded undecodable-admin-policy fallback in `group-engine.ts`'s `#createAdminVerificationCallback`), and `group-engine.ts`'s local `case "proposal"` send path, which passes the local client's own leaf index as sender (a locally built Update's sender is always the local client, no resolution ambiguity)
- `src/engine/__tests__/standalone-update-admission.test.ts` (new file, 5 tests) mirrors `standalone-add-admission.test.ts`'s shape: two local-gate rejection cases (missing proof, identity swap), one inbound-rejection case, one honest-inbound-staged control (the join-time self-update false-positive guard), and one honest-`selfUpdate` control proving the new gate doesn't touch commit-producing send paths
- `src/core/components/__tests__/integrity.test.ts` gained a 6-test describe block for the pure validator directly, covering the honest case (built via `createUpdateProposal` from a genuinely joined member's own state), undefined sender, out-of-range sender, missing proof, identity mismatch, and non-Update pass-through for both bare `Proposal` and `ProposalWithSender`

## Task Commits

Each task was committed atomically:

1. **Task 1: The pure Update-branch admission validator** - `28ee8e8` (feat)
2. **Task 2: Wire the Update gate into both admission seams** - `d7891c8` (feat)
3. **Task 3: UPD-04 admission test suite** - `f94bac0` (test)

**Plan metadata:** commit pending (this SUMMARY, applied by the orchestrator after wave completion — this is a worktree-isolated executor run; STATE.md/ROADMAP.md are NOT updated here per orchestrator ownership)

## Files Created/Modified

- `src/core/components/integrity.ts` — `validateUpdateProposalAccountIdentityProofs`, the Update-branch sibling of `validateAddProposalAccountIdentityProofs`; a local `toLeafIndex` cast helper
- `src/core/components/__tests__/integrity.test.ts` — new `validateUpdateProposalAccountIdentityProofs (UPD-04, D-09/D-10)` describe block, 6 tests, plus a `twoPartyEpoch1GroupWithMemberJoin` helper for the honest-Update test's genuine member-perspective state
- `src/engine/admin-policy.ts` — `createAdminCommitPolicyCallback`'s proposal branch now runs the Update gate alongside `validatePreApplyProposals`; stale "deferred to Phase 9" comment replaced
- `src/engine/group-engine.ts` — local `case "proposal"` gets a sibling branch to the Add gate; `#createAdminVerificationCallback`'s undecodable-admin-policy fallback also runs the Update gate
- `src/engine/ingest.ts` — the standalone-proposal rejection-labeling fallback now also checks `validateUpdateProposalAccountIdentityProofs`, so a rejection caused solely by the Update gate surfaces its real reason/proofReason instead of the generic `admin-policy` fallback (deviation, see below)
- `src/engine/__tests__/standalone-update-admission.test.ts` — new file, 5 UPD-04 admission tests
- `src/engine/__tests__/group-engine.test.ts` — updated the pre-existing "D-09/D-10" test to assert the new reject-on-unresolvable-sender behavior instead of the old Phase-8-deferred blanket accept (deviation, see below)
- `src/__tests__/exports.test.ts` — inline snapshot updated for the new export (deviation, see below)

## Decisions Made

- `ingest.ts`'s standalone-proposal rejection branch re-derives the labeled violation as `validatePreApplyProposals(...) ?? validateUpdateProposalAccountIdentityProofs(...)`, mirroring the existing D-05 commit-branch labeling pattern — the admission callback's binary accept/reject verdict is not itself sufficient for correct labeling once a second independent gate can cause the same reject
- The pre-existing `group-engine.test.ts` "D-09/D-10" test asserted the OLD deferred behavior by name; updated in place rather than left stale, since its own title already named the rule (D-10) this plan closes
- UPD-04's inbound-wire fixture (Test 3) builds a genuine `createUpdateProposal`-sourced leaf first, then strips its proof, rather than reusing a member's KeyPackage-sourced leaf directly (which the local-gate tests do safely, since they never reach the wire) — required by an empirically-discovered ts-mls wire-codec constraint (see Deviations)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `ingest.ts` mislabeled a Update-gate rejection as the generic `admin-policy` reason**
- **Found during:** Task 3, writing the inbound-rejection test
- **Issue:** `ingest.ts`'s standalone-proposal rejection branch (the `result.actionTaken === "reject"` handler) re-derived the specific violation for labeling by calling ONLY `validatePreApplyProposals(captured.proposals, ...)`. Since a rejection caused solely by the new `validateUpdateProposalAccountIdentityProofs` gate produces `undefined` from that call, the branch fell back to the generic `reason: "admin-policy"` instead of `"account-identity-proof"` — the callback itself correctly rejected the message (its accept/reject verdict was right), but the labeled reason and `proofReason` surfaced to callers/audit were wrong
- **Fix:** Changed the re-derivation to `validatePreApplyProposals(captured.proposals, ctx.ciphersuite.id) ?? validateUpdateProposalAccountIdentityProofs(captured.proposals, parentForAuth.ratchetTree, ctx.ciphersuite.id)`, mirroring the existing D-05 pattern used a few lines below in the commit branch
- **Files modified:** `src/engine/ingest.ts`
- **Verification:** `src/engine/__tests__/standalone-update-admission.test.ts`'s inbound-rejection test asserts `reason: "account-identity-proof"`, `proofReason: "missing-support"`, and `rejectionReasons(audit)` containing `"account_identity_proof"` — all now correct
- **Committed in:** `f94bac0` (Task 3 commit)

**2. [Rule 1 - Bug] Stale pre-existing test asserted the now-closed D-10 deferral**
- **Found during:** Task 2, running the plan's named verification suites
- **Issue:** `group-engine.test.ts`'s `"D-09/D-10: a standalone Add with a valid proof is accepted; a standalone Update is unaffected"` test explicitly asserted the OLD Phase-8-deferred behavior — a standalone Update with no resolvable sender was blanket-accepted, with a comment stating "standalone Update admission is deferred to Phase 9". This plan's whole purpose is to close that deferral, so the test's assertion became false the moment Task 2's wiring landed
- **Fix:** Updated the test's name, comment, and final assertion (`"accept"` → `"reject"`) to reflect the new D-10 reject-on-unresolvable-sender behavior, using the exact same (unmodified) proposal input — no other test in the file changed
- **Files modified:** `src/engine/__tests__/group-engine.test.ts`
- **Verification:** `pnpm vitest run src/engine/__tests__/group-engine.test.ts` — 13/13 tests pass
- **Committed in:** `d7891c8` (Task 2 commit)

**3. [Rule 3 - Blocking] Updated `exports.test.ts`'s inline snapshot for the new export**
- **Found during:** Task 2, full-suite verification
- **Issue:** `validateUpdateProposalAccountIdentityProofs` is now re-exported via `src/core/components/index.ts`'s `export *`, growing the public export surface `exports.test.ts` pins by inline snapshot
- **Fix:** Ran `pnpm vitest run src/__tests__/exports.test.ts -u` to regenerate the snapshot with the one new export name inserted alphabetically
- **Files modified:** `src/__tests__/exports.test.ts`
- **Verification:** `pnpm vitest run src/__tests__/exports.test.ts` passes; diff confirmed as a single-line addition
- **Committed in:** `d7891c8` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 required snapshot update — all caught by empirical test verification before committing, none weakening any existing assertion)
**Impact on plan:** All three fixes are necessary corrections to keep this plan's own stated goal true — "the three named engine suites pass unchanged" is now true for every assertion EXCEPT the one that directly encoded the deferred behavior this plan exists to close, which was updated rather than left contradicting the shipped code. No scope creep beyond what Task 2/3's own acceptance criteria require.

## Issues Encountered

**ts-mls wire-codec constraint on Update proposal LeafNode source (empirical finding required by Task 3's plan text).** The plan explicitly anticipated needing to determine, empirically, whether an inbound standalone Update with an invalid inner leaf reaches the admission callback or is refused earlier by ts-mls. The actual finding is more specific than the plan's stated hypothesis (leaf *signature* verification): ts-mls's wire decoder (`leafNodeUpdateDecoder`) only recognizes an Update proposal's inner `LeafNode` when its own `leafNodeSource` field is literally `"update"` — reusing a genuine member's KeyPackage-sourced leaf (`leafNodeSource: "key_package"`) verbatim, which is safe for the LOCAL admission-gate tests (which never reach the wire), silently decodes on the *receiving* side as an unrecognized custom proposal (`proposalData` bytes), never reaching any `IncomingMessageCallback` as an Update at all. The inbound fixture was corrected to build a genuine `"update"`-sourced leaf via `createUpdateProposal` first, then mutate it (strip its `0x8009` proof) afterward — keeping the wire *shape* valid while making the Marmot-layer *content* invalid. Separately confirmed (by reading `ts-mls/src/clientState.ts`'s `applyTreeMutations` and `processProposal`): ts-mls does NOT validate an Update proposal's inner leaf *signature* at proposal-receive time either — only when a later commit applies it — so the resulting fixture is not "unreachable" for the reason the plan speculated; it needed a different, narrower correction (wire-shape validity of the inner leaf, not signature validity of the whole message).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- UPD-04 is fully closed: `validateUpdateProposalAccountIdentityProofs`, both admission seam wirings (including the undecodable-admin-policy fallback), and the ingest.ts labeling fix are all in place, tested, and committed
- `pnpm compile` (library build) and `tsc -p tsconfig.json --noEmit` (full typecheck including tests) both exit 0; full `pnpm vitest run` is green at 111 files / 1241 tests
- `refs/mdk` and `refs/marmot` submodules were initialized locally in this worktree (they were not checked out when the worktree was created) so the conformance smoke suite and group-runtime/nostr-routing fixture tests could run — this is worktree-local setup, not a code change, and needs no follow-up
- No blockers for plan 09-04.

---

*Phase: 09-self-update-replacement-leaf-identity-binding*
*Completed: 2026-09-24*

## Self-Check: PASSED

All 8 modified/created source files verified present on disk with expected content; all 4 commit hashes (`28ee8e8`, `d7891c8`, `f94bac0`, `b339391`) verified present in `git log --oneline`.
