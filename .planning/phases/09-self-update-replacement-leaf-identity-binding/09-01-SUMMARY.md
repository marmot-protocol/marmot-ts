---
phase: 09-self-update-replacement-leaf-identity-binding
plan: 01
subsystem: mls-protocol
tags: [mls, account-identity-proof, commit-legality, self-update, app-components, ts-mls]

# Dependency graph
requires:
  - phase: 08-groupcontext-profile-requirement-legality-seam-extension
    provides: "diffChangedLeaves changed-leaf enumeration, validateCommitAccountIdentityProofs proof-validity chokepoint, AccountIdentityProofRejectReason union, deferredReasons vocabulary"
provides:
  - "ChangedLeaf.parentLeaf — the prior occupant of a changed leaf's MLS index, for identity-equality comparison"
  - "classifyChangedLeaf — pure D-01 three-bucket classifier (add / update-proposal / committer-update-path / unattributable / undecidable)"
  - "deferredReasons.unjudgeableIdentity (unjudgeable_identity) — D-04 deferral literal"
  - "AccountIdentityProofRejectReason literals member-identity-changed (D-05) and unattributable-leaf (D-02)"
  - "spliceLeafAtIndex / stripLeafAccountIdentityProof / forgeKeyPackage({ proof: \"stale\" }) test fixtures for 09-02/09-04"
affects: [09-02-groupcontext-profile-requirement-legality-seam-extension, 09-03, 09-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bucket classification (D-01): a pure src/core function sorts a ChangedLeaf into add/update-proposal/committer-update-path/unattributable/undecidable, matching signature bytes for Add rather than leaf index, so a Remove+Add into a freed slot is never mistaken for an identity change"
    - "Two-casing reason-union convention: deferredReasons stays snake_case, AccountIdentityProofRejectReason stays kebab-case — never crossed"

key-files:
  created:
    - src/core/components/leaf-replacement.ts
    - src/core/components/__tests__/leaf-replacement.test.ts
  modified:
    - src/core/components/tree-diff.ts
    - src/core/components/__tests__/tree-diff.test.ts
    - src/core/inbound.ts
    - src/core/components/account-identity-proof.ts
    - src/core/components/index.ts
    - src/__tests__/helpers/account-identity-proof-fixtures.ts
    - src/__tests__/exports.test.ts

key-decisions:
  - "classifyChangedLeaf checks the Add bucket first (signature-byte match), before the committer-update-path bucket, so an Add proposal is never shadowed by an incidental index match against committerLeafIndex (D-01 ordering)"
  - "undecidable is returned only when input is undefined, or when committerLeafIndex is undefined with no proposal match — never inferred from an empty proposals array, keeping a legitimate proposal-less self-update decidable (D-03)"
  - "forgeKeyPackage's new stale mode produces a validly signed proof bound to a different MLS signature key, not a byte-flipped one, to prove D-08's cryptographic indistinguishability from a corrupt proof"

patterns-established:
  - "Pattern: new AccountIdentityProofRejectReason/DeferredReason literals are additive-only in this plan — no new throw site changes behavior; they exist so plan 09-02's bucket classifier and legality adapter can emit them"

requirements-completed: []  # UPD-01 is not marked complete: this plan is additive foundations only; the tri-state validateCommitLegality wiring that makes UPD-01 observable is plan 09-02's scope.

coverage:
  - id: D1
    description: "ChangedLeaf.parentLeaf surfaces the prior occupant of a changed leaf's MLS index, undefined for a brand-new/freed slot"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/tree-diff.test.ts#a proposal-less self-update by leaf 0 carries a defined parentLeaf whose signature matches the parent leaf-0 signature and differs from the resulting leaf's signature"
        status: pass
      - kind: unit
        ref: "src/core/components/__tests__/tree-diff.test.ts#a commit adding a brand-new member into a brand-new slot yields parentLeaf undefined"
        status: pass
    human_judgment: false
  - id: D2
    description: "classifyChangedLeaf sorts a changed leaf into add / update-proposal / committer-update-path / unattributable / undecidable, with Add matched by signature bytes (freed-slot regression) and both distinct undecidable paths covered"
    requirement: "UPD-01"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/leaf-replacement.test.ts#classifyChangedLeaf (Tests 1-7)"
        status: pass
    human_judgment: false
  - id: D3
    description: "deferredReasons.unjudgeableIdentity and AccountIdentityProofRejectReason's member-identity-changed / unattributable-leaf literals exist in their union's own casing convention"
    verification:
      - kind: unit
        ref: "grep acceptance criteria in 09-01-PLAN.md Task 1 (parentLeaf, unjudgeable_identity, member-identity-changed, unattributable-leaf counts)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Fixtures for a stale proof, a substituted-identity replacement leaf, and a stripped leaf exist and are sanity-tested"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/leaf-replacement.test.ts#replacement-leaf fixtures (sanity) (3 tests)"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-09-24
status: complete
---

# Phase 9 Plan 1: Self-Update / Replacement-Leaf Identity Binding — Additive Foundations Summary

**Pure D-01 three-bucket changed-leaf classifier plus the prior-leaf field and three new reason literals UPD-01 needs, with zero changes to any existing validator's signature or behavior**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-24T11:44:00Z (approx.)
- **Completed:** 2026-09-24T11:55:47Z
- **Tasks:** 3 completed
- **Files modified:** 8 (2 created, 6 modified, including a required exports-snapshot fix)

## Accomplishments

- `diffChangedLeaves` now surfaces `ChangedLeaf.parentLeaf`, the prior occupant of the same MLS leaf index, sourced from the `beforeLeaf` local the function already computed — no re-read of the tree, no change to the skip/signature-inequality logic
- New pure `src/core/components/leaf-replacement.ts` exports `classifyChangedLeaf`: a total, non-throwing classifier that sorts any `ChangedLeaf` into `add` / `update-proposal` / `committer-update-path` / `unattributable` / `undecidable`, mirroring MDK's `validate_staged_commit_account_identity_proofs` bucket structure. The Add bucket matches by leaf signature bytes (never by index), so a Remove+Add commit reusing a freed slot is correctly attributed as an Add and never flagged as an identity change
- Three new reason literals landed, each in its own union's casing convention: `deferredReasons.unjudgeableIdentity` (`"unjudgeable_identity"`, snake_case) and `AccountIdentityProofRejectReason`'s `"member-identity-changed"` / `"unattributable-leaf"` (kebab-case) — all additive, with no new throw site in this plan
- `forgeKeyPackage` gained a `"stale"` proof mode (a genuinely, validly signed `0x8009` proof bound to a *different* MLS signature key), and two new fixtures — `spliceLeafAtIndex` and `stripLeafAccountIdentityProof` — landed for plans 09-02/09-04, each with a sanity test proving it fails for its intended reason

## Task Commits

Each task was committed atomically:

1. **Task 1: Prior leaf on ChangedLeaf, plus the three new reason literals** - `b4f0db9` (feat)
2. **Task 2: The pure D-01 three-bucket changed-leaf classifier** - `a897e48` (feat)
3. **Task 3: Replacement-leaf test fixtures and their sanity assertions** - `9778ded` (test)

**Deviation fix:** `2cafd5b` (chore — exports snapshot update, see Deviations below)

**Plan metadata:** commit pending (this SUMMARY + STATE/ROADMAP update, applied by the orchestrator after wave completion — this is a worktree-isolated executor run)

## Files Created/Modified

- `src/core/components/leaf-replacement.ts` — new: `ChangedLeafClassification`, `ChangedLeafClassificationInput`, `classifyChangedLeaf`
- `src/core/components/__tests__/leaf-replacement.test.ts` — new: 7 classifier unit tests + 3 fixture-sanity tests (10 total)
- `src/core/components/tree-diff.ts` — `ChangedLeaf.parentLeaf` field, populated at the existing push site
- `src/core/components/__tests__/tree-diff.test.ts` — 2 new `parentLeaf` assertions alongside the 4 pre-existing ones (6 total)
- `src/core/inbound.ts` — `deferredReasons.unjudgeableIdentity`
- `src/core/components/account-identity-proof.ts` — `AccountIdentityProofRejectReason` gains `member-identity-changed`, `unattributable-leaf`
- `src/core/components/index.ts` — barrel re-export of `./leaf-replacement.js`
- `src/__tests__/helpers/account-identity-proof-fixtures.ts` — `forgeKeyPackage`'s `proof` param widened to include `"stale"`; new `spliceLeafAtIndex`, `stripLeafAccountIdentityProof`
- `src/__tests__/exports.test.ts` — inline snapshot updated for the new `classifyChangedLeaf` public export (deviation, see below)

## Decisions Made

- Add-bucket match ordering: Add is checked before the committer bucket, so an Add proposal is never shadowed by an incidental leaf-index match against `committerLeafIndex` (pinned by Test 7)
- `undecidable` is never inferred from an empty `proposals` array — only from `input === undefined` or `committerLeafIndex === undefined` with no proposal match — so a legitimate proposal-less self-update commit stays decidable (D-03)
- `forgeKeyPackage`'s `"stale"` mode produces a proof validly signed over a *second* generated MLS signature key, distinct from the leaf's actual key, rather than a tampered envelope — this is the fixture D-08 requires to prove a stale proof is cryptographically indistinguishable from a corrupt one (both surface as `invalid-proof`)
- The sanity test for `"stale"` asserts the throw and its `invalid-proof` reason, but does not compare the leaf's `signaturePublicKey` against the internal second key `forgeKeyPackage` generates — that key is intentionally not exposed by the fixture's pinned return shape (`{ publicPackage, privatePackage }`), and D-08 itself establishes it is unrecoverable from the 104-byte envelope by design. The comment on the test documents this reasoning explicitly rather than silently doing a weaker check

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated the stale `exports.test.ts` inline snapshot**
- **Found during:** Post-Task-3 full-suite verification (`pnpm vitest run`)
- **Issue:** `classifyChangedLeaf`, the new public export from Task 2 (re-exported `leaf-replacement.js` → `components/index.js` → `core/index.js` → `src/index.js`), was not yet present in `exports.test.ts`'s `toMatchInlineSnapshot` pinning the library's full public surface, so the snapshot test failed
- **Fix:** Ran `pnpm vitest run src/__tests__/exports.test.ts -u` to regenerate the inline snapshot; diff is a single line adding `"classifyChangedLeaf"` in its correct alphabetical position
- **Files modified:** `src/__tests__/exports.test.ts`
- **Verification:** Full `pnpm vitest run` is green — 110 files, 1221 tests
- **Committed in:** `2cafd5b`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the full suite green after adding a new intentional public export; no scope creep. No production validator behavior changed by this plan — `validateCommitLegality`, `validateCommitAccountIdentityProofs`, and `diffChangedLeaves`'s existing signature all kept their current parameter lists and return types, per the plan's explicit verification section.

## Issues Encountered

- This worktree had `ts-mls` and `refs/mdk` git submodules uninitialized (both showed `-` in `git submodule status`, meaning never cloned in this worktree checkout). `pnpm vitest run` initially failed at the pnpm-workspace resolution step (`ts-mls@workspace:*` not found), and later a subset of tests (`group-runtime.test.ts`, `nostr-routing.test.ts`, `smoke.test.ts` conformance corpus) failed on missing `refs/mdk/crates/cgka-conformance-simulator/vectors/*.json` fixture files. Both were resolved with `git submodule update --init ts-mls` and `git submodule update --init refs/mdk` — infrastructure setup, not a code change, and not committed (submodule checkouts are gitlinks already tracked by the parent commit `ff33a7e`, not new content).
- No other issues.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `classifyChangedLeaf`, `ChangedLeaf.parentLeaf`, `deferredReasons.unjudgeableIdentity`, and the two new `AccountIdentityProofRejectReason` literals are all in place, tested, and re-exported — plan 09-02 can now forward `proposals`/`committerLeafIndex` into `validateCommitAccountIdentityProofs` and grow `validateCommitLegality`'s tri-state return without any interface churn in this plan's deliverables
- `spliceLeafAtIndex` and `stripLeafAccountIdentityProof` are ready for 09-02 (UPD-01 pure-validator tests) and 09-04 (UPD-03) respectively; `forgeKeyPackage({ proof: "stale" })` is ready for 09-02's UPD-02 regression test
- No blockers. `pnpm vitest run` (110 files / 1221 tests) and `pnpm compile` are both green at HEAD; `pnpm compile` covers only `tsconfig.build.json` (tests excluded), so a full `tsc -p tsconfig.json --noEmit` was also run and confirmed clean as an extra check beyond the plan's stated acceptance criteria
- UPD-01 is intentionally left `requirements-completed: []` in this SUMMARY — it becomes observable only once plan 09-02 wires the tri-state `validateCommitLegality` return through its five call sites

---

*Phase: 09-self-update-replacement-leaf-identity-binding*
*Completed: 2026-09-24*

## Self-Check: PASSED

All 9 created/modified files verified present on disk; all 4 task/deviation commit hashes (`b4f0db9`, `a897e48`, `9778ded`, `2cafd5b`) verified present in `git log --oneline --all`.
