---
phase: 09-self-update-replacement-leaf-identity-binding
plan: 02
subsystem: mls-protocol
tags: [mls, account-identity-proof, commit-legality, self-update, convergence, ts-mls]

# Dependency graph
requires:
  - phase: 09-self-update-replacement-leaf-identity-binding
    plan: "01"
    provides: "classifyChangedLeaf three-bucket classifier, ChangedLeaf.parentLeaf, deferredReasons.unjudgeableIdentity, AccountIdentityProofRejectReason's member-identity-changed/unattributable-leaf, spliceLeafAtIndex test fixture"
provides:
  - "CommitLegalityOutcome — the tri-state (legal/violation/undecidable) return type for validateCommitAccountIdentityProofs and validateCommitLegality"
  - "UPD-01 enforcement: a replacement leaf whose account identity differs from the prior occupant's is a terminal account-identity-proof/member-identity-changed violation"
  - "Six updated call sites (fork-recovery.ts x3, group-engine.ts x2, ingest.ts x1) each mapping undecidable into their own existing deferral idiom"
  - "9 pure-validator UPD-01 tests plus the documented D-11 seam-parity gap"
affects: [09-03, 09-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tri-state precedence: within validateCommitAccountIdentityProofs's own changed-leaf loop AND at the validateCommitLegality/validateLegalityWithoutProposals orchestration level, an undecidable identity outcome does not short-circuit — later checks (disband-legality, admin-leaf-coupling) still run, and a definite violation from any of them outranks the remembered undecidable, which is returned only if nothing else finds a violation"
    - "Test migration pattern: expectLegal(outcome) for legal cases, violationOf(outcome) (throws on undecidable) for violation-shape assertions — no migrated test can silently read undecidable as legal"

key-files:
  created: []
  modified:
    - src/core/components/integrity.ts
    - src/engine/fork-recovery.ts
    - src/engine/group-engine.ts
    - src/engine/ingest.ts
    - src/core/components/__tests__/integrity.test.ts

key-decisions:
  - "validateCommitLegality and validateLegalityWithoutProposals do NOT short-circuit on an undecidable identity outcome — they remember it and keep running the later disband/admin-leaf-coupling checks, returning undecidable only if those clear. Without this, the pre-existing known-state-fallback-legality.test.ts regression (a de-leafed admin behind a committer self-update) would incorrectly defer instead of reject, since a Remove/committer-self-update commit always produces at least one changed leaf that's undecidable without a rebuildable proposal list"
  - "#assertStagedCommitLegal (send path) maps undecidable to the same fail-closed CommitLegalityError as a violation, documented unreachable in practice (both callers always pass a defined committerLeafIndex) — there is no deferral disposition on a synchronous send"
  - "Three pre-existing validateCommitAccountIdentityProofs direct-call tests (honest Add, honest self-update, removal-only commit) needed an explicit classification added during Task 2 migration, beyond the single test the plan named — their commits all produce a committer self-update-path leaf (Add-only commits skip the path, but Remove and no-proposal self-update commits always trigger one per ts-mls's needsUpdatePath logic), so without classification they now correctly report undecidable instead of legal"

requirements-completed: [UPD-01]

coverage:
  - id: D1
    description: "A replacement leaf at an existing member's index whose BasicCredential identity differs from the prior leaf's identity is rejected with reason account-identity-proof and proofReason member-identity-changed, via both the committer-update-path and update-proposal classification buckets"
    requirement: "UPD-01"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 1 (UPD-01, committer bucket)"
        status: pass
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 2 (UPD-01, update-proposal bucket)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The identity-change rejection is distinct from an invalid proof or a legacy identity-mismatch reason, and the spliced leaf's own proof validates cleanly on its own"
    requirement: "UPD-01"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 3 (Pitfall 12 distinctness)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A Remove+Add commit that reuses a freed leaf slot is legal, not a false-positive identity change (D-01 regression), confirmed to fail when classifyChangedLeaf is stubbed to always report committer-update-path"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 4 (D-01 regression, freed-slot case)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A changed leaf attributable to no Add, no Update sender, and not the committer is rejected as unattributable-leaf (D-02), fail closed"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 5 (D-02)"
        status: pass
    human_judgment: false
  - id: D5
    description: "When classification is structurally impossible, validateCommitAccountIdentityProofs returns undecidable and this is distinct from both legal and a terminal violation (D-03)"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 6 (D-03)"
        status: pass
    human_judgment: false
  - id: D6
    description: "A definite violation always outranks an undecidable outcome elsewhere in the same commit, so a provably illegal commit is rejected rather than pooled"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 7 (precedence)"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/known-state-fallback-legality.test.ts#still rejects a recorded child that leaves an admin without a member leaf"
        status: pass
    human_judgment: false
  - id: D7
    description: "The violation shape is unchanged (reason, detail, proofReason, leafIndex) and detail contains no account identity pubkey hex"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 8 (D-06 privacy)"
        status: pass
    human_judgment: false
  - id: D8
    description: "An honest self-update (no identity change) still returns legal on the validator seam"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#Test 9 (positive control)"
        status: pass
    human_judgment: false
  - id: D9
    description: "All six src/ call sites of validateCommitLegality/validateCommitAccountIdentityProofs are updated to the tri-state and map undecidable into each seam's own existing deferral idiom; the four pre-existing engine legality suites pass unchanged"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/account-identity-proof-seams.test.ts, commit-legality-seams.test.ts, send-commit-legality.test.ts, known-state-fallback-legality.test.ts (48 tests total)"
        status: pass
      - kind: other
        ref: "pnpm compile (tsc -b tsconfig.build.json) and tsc -p tsconfig.json --noEmit both exit 0; full pnpm vitest run: 110 files / 1230 tests pass"
        status: pass
    human_judgment: false

# Metrics
duration: 22min
completed: 2026-09-24
status: complete
---

# Phase 9 Plan 2: CommitLegalityOutcome Tri-State and UPD-01 Replacement-Leaf Identity Binding Summary

**A tri-state `CommitLegalityOutcome` (legal/violation/undecidable) replaces the two-state `CommitIntegrityViolation | undefined` return across all six commit-legality call sites, enforcing that a replacement leaf's account identity must match the prior occupant's — terminally, distinctly from an invalid proof — while a structurally unjudgeable commit defers into each seam's own idiom instead of being silently accepted or wrongly rejected**

## Performance

- **Duration:** 22 min
- **Started:** 2026-09-24T17:00:48Z
- **Completed:** 2026-09-24T17:22:36Z
- **Tasks:** 3 completed
- **Files modified:** 5 (4 production, 1 test — 09-02-PLAN.md's own file list)

## Accomplishments

- `CommitLegalityOutcome` is a new exported discriminated union (`{kind:"legal"}` / `{kind:"violation", violation}` / `{kind:"undecidable", detail}`) on `src/core/components/integrity.ts`, replacing `CommitIntegrityViolation | undefined` as the return type of both `validateCommitAccountIdentityProofs` and `validateCommitLegality`
- `validateCommitAccountIdentityProofs` now classifies every changed leaf via plan 09-01's `classifyChangedLeaf` and, for the `update-proposal`/`committer-update-path` buckets, compares the replacement leaf's account identity (`getCredentialPubkey`) against `ChangedLeaf.parentLeaf`'s — a mismatch is a terminal `account-identity-proof`/`member-identity-changed` violation (UPD-01), distinct from `invalid-proof` (Pitfall 12). An `unattributable` leaf fails closed (D-02); an `undecidable` leaf is remembered but does not short-circuit the loop, so a violation on a later leaf still outranks it (D-03)
- `validateCommitLegality` and the fork-recovery WR-03 helper `validateLegalityWithoutProposals` apply the same non-short-circuiting precedence at the orchestration level: an undecidable identity outcome is remembered, disband-legality and admin-leaf-coupling still run, and a violation from either outranks it — required to keep the pre-existing `known-state-fallback-legality.test.ts` regression passing (a committer self-update always produces an undecidable-without-classification changed leaf, but the admin-leaf-coupling violation underneath it must still fire)
- All six `src/` call sites are updated to switch on the tri-state: `fork-recovery.ts`'s two `resolveCandidateParent` sites and `validateLegalityWithoutProposals` map `undecidable` to `{kind:"deferred", reason:"temporary_refusal"}`; `group-engine.ts`'s `#assertStagedCommitLegal` (send path) maps it to the same fail-closed `CommitLegalityError` as a violation (documented unreachable — both callers always pass a defined `committerLeafIndex`); the tree-sweep call site keeps the candidate pooled (`return undefined`); `ingest.ts` yields a `DeferredIngestResult` carrying `deferredReasons.unjudgeableIdentity`, without calling `dedup.remember` or `ctx.setState`
- `src/core/components/__tests__/integrity.test.ts` gained `expectLegal`/`violationOf` migration helpers (the latter throws on `undecidable` so no migrated assertion can silently read it as legal) and a new 9-test `describe` block pinning UPD-01 at the pure-validator level, plus a file-level comment documenting why full four-seam parity is deferred (D-11): ts-mls exports no leaf-signing helpers to construct a wire-valid identity-changing replacement leaf, and a forged unsigned one would be refused by `processMessage`'s own signature check before reaching this validator

## Task Commits

Each task was committed atomically:

1. **Task 1: CommitLegalityOutcome tri-state, identity enforcement, and all six seam mappings** - `cd3092e` (feat)
2. **Task 2: Migrate integrity.test.ts to the outcome shape and correct the D-12 rationale** - `8bd18bc` (test)
3. **Task 3: UPD-01 pure-validator tests and the documented seam-parity gap** - `cc68131` (test)

**Plan metadata:** commit pending (this SUMMARY, applied by the orchestrator after wave completion — this is a worktree-isolated executor run; STATE.md/ROADMAP.md are NOT updated here per orchestrator ownership)

## Files Created/Modified

- `src/core/components/integrity.ts` — `CommitLegalityOutcome` type; `validateCommitAccountIdentityProofs` and `validateCommitLegality` return the tri-state and enforce UPD-01 identity equality
- `src/engine/fork-recovery.ts` — `validateLegalityWithoutProposals` returns the tri-state; both `resolveCandidateParent` call sites switch on it
- `src/engine/group-engine.ts` — `#assertStagedCommitLegal` and the tree-sweep call site switch on the tri-state
- `src/engine/ingest.ts` — the commit-legality call site yields a deferred result on `undecidable`
- `src/core/components/__tests__/integrity.test.ts` — migration helpers, 3 tests updated with explicit classification, D-12 rename, and the new 9-test UPD-01 describe block

## Decisions Made

- Non-short-circuiting precedence at both the per-leaf loop level (inside `validateCommitAccountIdentityProofs`) and the orchestration level (inside `validateCommitLegality`/`validateLegalityWithoutProposals`): an `undecidable` identity outcome is remembered, not returned immediately, so later checks still get a chance to find a definite violation that outranks it. This was discovered necessary (not merely a nice-to-have) via the pre-existing `known-state-fallback-legality.test.ts` suite, which broke under a naive short-circuiting implementation
- `#assertStagedCommitLegal` treats `undecidable` identically to a violation (fail-closed `CommitLegalityError`) since the local send path has no deferral disposition — documented as unreachable in practice, not exercised by a dedicated test, since both callers always pass a defined `committerLeafIndex`
- Three existing `validateCommitAccountIdentityProofs` direct-call tests beyond the one the plan named (honest Add, honest self-update, removal-only commit) needed an explicit `classification` added during the Task 2 migration to keep their legal outcome legal — their commits each produce a changed leaf via ts-mls's `needsUpdatePath` logic (an Add proposal alone skips the path, but a Remove proposal or an empty-proposal self-update always triggers one), which is undecidable without classification under the new default

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Non-short-circuiting undecidable propagation at the orchestration level**
- **Found during:** Task 1, post-implementation verification (`known-state-fallback-legality.test.ts` regression)
- **Issue:** The plan's literal instruction for `validateCommitLegality` ("Propagate a non-legal outcome from the proof check unchanged") and for `validateLegalityWithoutProposals` implied returning immediately on `undecidable` from the account-identity-proof step, mirroring the old `if (violation) return violation;` pattern. This broke `known-state-fallback-legality.test.ts`'s existing assertion that a recorded child de-leafing an admin behind an unclassifiable committer self-update is `rejected`/`admin-leaf-coupling` — with immediate short-circuiting it became `deferred` instead, since the self-update's own changed leaf is undecidable without a rebuildable proposal list
- **Fix:** Both functions now remember the `undecidable` detail from the account-identity-proof step but continue running disband-legality/admin-leaf-coupling; a violation from either still returns immediately (outranking the remembered undecidable), and the undecidable is returned only if the whole pipeline clears with no violation. This is the SAME "definite violation outranks undecidable" precedence the plan already specifies for the per-leaf loop inside `validateCommitAccountIdentityProofs` — applied one level up
- **Files modified:** `src/core/components/integrity.ts`, `src/engine/fork-recovery.ts`
- **Verification:** `known-state-fallback-legality.test.ts` and the other three named legality seam suites (48 tests) all pass; full `pnpm vitest run` green (110 files / 1230 tests)
- **Committed in:** `cd3092e` (Task 1 commit — found and fixed before the task commit, not a separate follow-up)

**2. [Rule 1 - Bug] Explicit classification added to three pre-existing direct-call tests beyond the plan-named one**
- **Found during:** Task 2, migration of `integrity.test.ts`
- **Issue:** The plan's Task 2 action explicitly calls out adding a `classification` argument only to the "honest self-update" test (per D-12). Empirically running the unmigrated suite against the Task 1 code showed two additional pre-existing tests — "honest Add of a core-generated KeyPackage" and "removal-only commit" — also flip from legal to `undecidable` without classification, because their commits (an Add-only commit still changes the Added leaf itself; a Remove-only commit forces an update path on the committer) each produce a changed leaf that's unclassifiable without proposal/committer information
- **Fix:** Added an explicit `classification` to both tests (an Add-proposal list for the Add test; `committerLeafIndex` for the removal test), matching the plan's own migration pattern used for the self-update test, so their previously-legal outcome stays legal instead of becoming undecidable
- **Files modified:** `src/core/components/__tests__/integrity.test.ts`
- **Verification:** All 39 pre-existing tests in the file pass (no fewer than before migration), confirmed via `pnpm vitest run`
- **Committed in:** `8bd18bc` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs in the literal plan instructions, both caught by empirical test verification before committing)
**Impact on plan:** Both fixes are necessary corrections to keep the plan's own stated goal — "no pre-existing assertion was weakened during the tri-state migration" and "the four pre-existing engine legality suites pass unchanged" — actually true. No scope creep; no production behavior beyond the plan's PLAN.md `<action>` intent was added.

## Issues Encountered

None beyond the two deviations above, both resolved during their originating task before commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `CommitLegalityOutcome`, the identity-equality enforcement, and all six seam mappings are in place, tested, and committed — plans 09-03 and 09-04 (per 09-02-PLAN.md's interface contract) can now build on the tri-state without any further signature churn in this plan's deliverables
- `pnpm compile` (library build) and `tsc -p tsconfig.json --noEmit` (full typecheck including tests) both exit 0; full `pnpm vitest run` is green at 110 files / 1230 tests
- The D-11 seam-parity gap (no send/inbound-ingest/fork-recovery/tree-fed test for UPD-01, only pure-validator) is documented in the test file itself and cross-referenced to Phase 11's QA gate — this is a known, deliberate limitation, not an oversight, and should be re-surfaced if plan 09-03 or 09-04 touch seam-level UPD-01 behavior
- No blockers.

---

*Phase: 09-self-update-replacement-leaf-identity-binding*
*Completed: 2026-09-24*

## Self-Check: PASSED

All 4 modified files verified present on disk with expected content; all 3 task commit hashes (`cd3092e`, `8bd18bc`, `cc68131`) verified present in `git log --oneline`.
