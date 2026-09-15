---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
fixed_at: 2026-09-15T19:13:13Z
review_path: .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report

**Fixed at:** 2026-09-15T19:13:13Z
**Source review:** .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, WR-01..WR-06; IN-01..IN-04 out of scope)
- Fixed: 7
- Skipped: 0

**Verification:**
- `pnpm compile` clean after every fix.
- The test files typecheck (`tsc --noEmit -p tsconfig.json`) with no errors.
- Full `pnpm vitest run` after the last commit: **103 files / 1170 tests passing**. The baseline was 103 / 1164; the 6 extra tests are the regression tests added below.
- The new tests for CR-01, WR-04, WR-05 and WR-06 were each run against the unfixed code first and failed with the reported bug. The WR-03 test was not.

**Process note:** per the orchestrator override, all commits went directly on `master`. No worktree, temp branch or recovery sentinel was created, so there was no cleanup to do.

## Fixed Issues

### CR-01: Pool sweep (`#sweepResult`) applies commits with no commit-legality check

**Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/account-identity-proof-seams.test.ts`
**Commit:** 30986e0
**Status:** fixed: requires human verification (convergence selection logic)

**Applied fix:**
- **Pool sweep.** For commits, `#sweepResult` now runs the shared `validateCommitLegality` adapter before `#tree.recordCommit`, using the parent node state, the resulting state and the captured proposals. On a violation it returns `rejected` with the same `reason` / `proofReason` / `leafIndex` projection as `ingest.ts`, and no edge is recorded. If the validator throws, the entry stays pooled, mirroring `resolveCandidateParent`'s `deferred`.
- **Tree-fed fallback.** `#reconvergeFromTree` now selects only among branches that can actually be adopted.
  - `#treeResolution` returns one of `resolved`, `invalid` or `deferred`.
  - `invalid` covers an illegal or unauthenticated link, a non-framed stored message, or a replay that produces a different confirmation tag. That candidate is excluded and `selectCanonicalBranch` re-runs over the remaining branches.
  - `deferred` covers a missing snapshot or commit, or a temporary refusal. It still ends the pass without adopting anything.
  - This matches refs/mdk. `openmls_projection.rs` drops a commit that is invalid against its candidate state (`InvalidAgainstCandidateState`) before branches are scored, so an invalid branch can never win.
- **Tests.** Two regression rows:
  - A live second sibling commit, encrypted under the sibling branch's exporter secret, that only `#sweepTree` can reach. It is now `rejected` / `account-identity-proof` / `missing-requirement` with no edge recorded; before the fix it was `processed`.
  - A tree-fed set where the deepest candidate is illegal and a shallower legal branch still beats the current tip. The engine now switches to the legal branch; before the fix it stayed on the current tip.
- **Please check:** whether falling back to the runner-up on `invalid` but not on `deferred` is the policy you want.

### WR-01: Replay and tree-fed seams drop illegal commits without the `account-identity-proof` label

**Files modified:** `src/engine/fork-recovery.ts`, `src/engine/ingest.ts`, `src/engine/group-engine.ts`, `src/engine/__tests__/account-identity-proof-seams.test.ts`, `src/engine/__tests__/commit-legality-seams.test.ts`, `.changeset/account-identity-proof-v2.md`
**Commit:** 5cb98b5
**Status:** fixed: requires human verification (ingest result reporting changed)

**Applied fix:** I surfaced the violation rather than only rewording the changeset.
- **Fork recovery.** The `rejected` variant of `ParentResolution` now carries the `processMessage` `result`. `#buildBranches` collects candidates that were refused at their parent and never resolved on any explored node. `ForkRecovery.resolveFork` returns them as `rejected: RejectedForkCandidate[]` on every outcome.
- **Ingest.** `ingest.ts` yields those pool entries as `rejected` with `reason ?? "admin-policy"`, `proofReason` and `leafIndex`, instead of `skipped` / `past-epoch`, and records them in dedup. The `processed` / `removed` representative is chosen from the entries that were not rejected.
- **Tree-fed.** There is no envelope to attach a result to, so `#treeResolution` logs the structured violation.
- **Changeset.** Now states each seam's actual disposition: send throws; inbound, replay and pool sweep yield `rejected`; tree-fed never adopts the branch and falls back to the best remaining legal branch.
- **Tests.**
  - The three GRP-02 replay rows now also assert the `rejected` ingest result and its projection.
  - The existing `commit-legality-seams` replay row used to assert the old `skipped` label. It now asserts `rejected` / `component-integrity`.

### WR-02: Pool sweep labels an admin-policy rejection with `reason: undefined`

**Files modified:** `src/engine/group-engine.ts`
**Commit:** bc67ddb
**Applied fix:**
- In the admin-callback reject branch, `#sweepResult` now returns `reason: violation?.reason ?? "admin-policy"`, matching both rejection sites in `ingest.ts`.
- One-line change; no new test added. It was verified by compile and the engine suite.
- The shared rejection-label helper the review suggested is IN-03, which was out of scope.

### WR-03: Own-commit stamps skip the new `0x8009` legality check on replay and tree-fed convergence

**Files modified:** `src/engine/fork-recovery.ts`, `src/engine/__tests__/account-identity-proof-seams.test.ts`
**Commit:** b5e0111
**Status:** fixed: requires human verification (legality gate now runs on own-commit and disband known states)

**Applied fix:**
- **What changed.** In `resolveCandidateParent`, the `known` shortcut still reuses the recorded child instead of replaying it, but it no longer returns `resolved` unchecked.
- **The check.** The new `proposalsFromPublicCommit` helper rebuilds the PublicMessage commit's proposals from inline entries and `ProposalRef`s resolved via `parent.unappliedProposals[bytesToBase64(ref)]`, the same lookup ts-mls `applyProposals` uses. The full `validateCommitLegality` then runs on the recorded child.
  - If the proposals cannot be rebuilt (a PrivateMessage commit, a non-member sender, or a reference the parent no longer stages), the proposal-free `validateCommitAccountIdentityProofs` runs instead.
  - A throw maps to `deferred`.
- **Comment.** The CR-04 comment in `#buildBranches` now describes what the code actually does.
- **Test.** A new seam row calls `resolveCandidateParent` with a `known` recorded child that drops the requirement and asserts `rejected` with the expected projection.
- **Why verification is needed.** The disband `knownCandidates` path now goes through the same gate too. Existing disband and convergence tests pass.

### WR-04: `acceptAll` fallback in `#createAdminVerificationCallback` bypasses pre-apply Add admission

**Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/standalone-add-admission.test.ts`
**Commit:** d7870e5
**Applied fix:**
- When `getMarmotGroupView(state)` is `null`, the callback no longer returns `acceptAll`. It returns a callback that runs `validateAddProposalAccountIdentityProofs` for both the `proposal` and `commit` kinds and rejects an Add with a missing or invalid proof.
- Otherwise it defers to `acceptAll`, which keeps the previous permissive admin-policy fallback for groups without admin data.
- I deliberately did not take the review's other suggestion, "reject commits for lack of admin data". That would change how groups without readable admin data behave, which goes beyond this finding.
- **Test.** A raw AppDataUpdate writes malformed bytes to the optional avatar component (`0x8007`), so `getMarmotGroupView` returns `null` while the profile stays supported. An inbound forged standalone Add is then `rejected` / `account-identity-proof` and is not staged; before the fix it was `processed`.

### WR-05: A staged invalid Add proposal permanently blocks every local commit

**Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/standalone-add-admission.test.ts`
**Commit:** f2c571b
**Status:** fixed: requires human verification (outbound commit composition changed)

**Applied fix:**
- **Pruning.** `#prepareOutboundCommitProposals` now computes `commitState` using the new module helper `withoutInvalidStagedAdds`. It strips staged Add proposals with an invalid `0x8009` proof from `unappliedProposals`. The `commit` and `selfUpdate` paths build `createCommit` from that state, so such a proposal is never bundled by reference.
- **Still refused.** An invalid by-value Add still throws `CommitLegalityError`, and so does an explicitly selected `proposalRefs` entry pointing at an invalid Add.
- **Auto-commit.** `#maybeAutoCommitSelfRemoves` ignores invalid staged Adds when deciding whether the pending set contains only self_removes.
- **Test.** A proof-less Add is staged with raw `processMessage`. Both `selfUpdate()` and `send({kind:"commit"})` then succeed with zero consumed proposal refs; before the fix they threw `CommitLegalityError`.
- **Not done.** The review's secondary suggestion, purging invalid proposals from canonical state at hydration or load, was not implemented. They are pruned at commit time only, so they remain in `unappliedProposals` until the epoch advances.

### WR-06: Direct engine `ingest()` on an unsupported-profile group still decrypts refused envelopes and can throw

**Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/unsupported-profile.test.ts`
**Commit:** bcd2c19
**Applied fix:**
- **Gate.** `MarmotGroupEngine.ingest()` checks `profileSupport` right after `#disbandHydrated`. For an unsupported group it yields `skipped` / `unsupported-profile` for every envelope, with the same ingest entry and outcome audit events. It returns before the pool re-feed, `#sweepTree`, `#reconvergeFromTree` (and its witness peeling) and the auto-commit.
- **Also covered.** `driveConvergence` goes through `ingest()`, so it is gated too.
- **Defense in depth.** `#maybeAutoCommitSelfRemoves` also returns `undefined` for an unsupported group.
- **Backstop kept.** The gate inside `ingestEnvelopes` stays in place.
- **Test.** An unsupported group whose persisted state has a pending self_remove that this client is elected to commit. Ingest now yields exactly one `skipped` result, never calls the peeler, and does not throw. Before the fix, `UnsupportedGroupProfileError` escaped the generator.

---

_Fixed: 2026-09-15T19:13:13Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
