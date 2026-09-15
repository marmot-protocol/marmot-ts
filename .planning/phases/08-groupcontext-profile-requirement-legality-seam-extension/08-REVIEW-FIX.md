---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
fixed_at: 2026-09-15T20:04:49Z
review_path: .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 7
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report

**Fixed at:** 2026-09-15T20:04:49Z
**Source review:** .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-REVIEW.md (round 2)
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01..CR-03, WR-01..WR-04; IN-01..IN-04 out of scope)
- Fixed: 7
- Skipped: 0

**Verification:**
- Every regression test was run against the unfixed code first and failed as the finding describes. That covers CR-01, CR-02, the three CR-03 rows, WR-01, WR-02 and WR-03. WR-04 is changeset text only, so it has no test.
- `tsc -b tsconfig.build.json` (what `pnpm compile` runs) and `tsc --noEmit -p tsconfig.json` both exited 0 after every fix.
- The full `vitest run` after the last code fix (WR-03) passed **107 files / 1178 tests**. The 4 extra files are this round's new regression test files.
- The WR-02 tie-break rows, whose tip digests are random, passed 5 of 5 repeated runs.
- Prettier was run on every touched file.

**Process notes:**
- All work ran in an isolated worktree on a temp branch, with a recovery sentinel. Cleanup fast-forwarded `master` from `a980064` to `3d7428b`, removed the worktree, deleted the temp branch, and then removed the sentinel.
- **pnpm.** Inside the worktree, `pnpm` scripts tried to run `pnpm install` and aborted, so the same binaries were called directly (`tsc`, `vitest`, `prettier`).
- **Symlinks.** `node_modules` was symlinked from the main checkout. `refs/mdk/crates` was also symlinked, because 6 test files import MDK conformance vectors and the worktree has no submodule checkout. Both symlinks were removed before teardown.
- **MDK check.** `refs/mdk` was checked before each convergence and authorization fix, as CLAUDE.md requires. Where a fix departs from the review's suggestion, the reason is given below.

## Fixed Issues

### CR-01: One admin callback serves every commit in a batch

**Files modified:** `src/engine/ingest.ts`, `src/engine/group-engine.ts`, `src/engine/__tests__/admin-authorization-parent.test.ts` (new)
**Commit:** e8394c2
**Status:** fixed: requires human verification (authorization logic)

**Applied fix:**
- **Signature.** `IngestContext.createAdminCallback` now takes a `state` argument.
- **Per-message callback.** `ingestEnvelopes` no longer builds one shared capture per batch. For every non-commit message and every commit, it builds `withCapturedProposals(ctx.createAdminCallback(ctx.getState()))`. So each message is authorized against the exact state it is processed on.
- **Engine.** The engine passes the state through to `#createAdminVerificationCallback(state)`.
- **MDK reference.** This matches `refs/mdk/crates/cgka-engine/src/app_components.rs` `require_admin_for_staged_commit`, which authorizes against the `MlsGroup` each commit is staged on.
- **Test.** Admin2 demotes itself, then commits an admin-only profile change, and both commits arrive in one batch. The second commit is now `rejected` / `admin-policy` and the epoch stays at 2. Before the fix, both commits were `processed`.

### CR-02: Pool replay authorizes candidates against the canonical tip

**Files modified:** `src/engine/fork-recovery.ts`, `src/engine/group-engine.ts`, `src/engine/__tests__/admin-authorization-parent.test.ts`, `src/engine/__tests__/convergence-parity.test.ts`, `src/engine/__tests__/send-commit-legality.test.ts`, `.changeset/account-identity-proof-v2.md`
**Commit:** da3aa89
**Status:** fixed: requires human verification (fork-candidate authorization)

**Applied fix:**
- **Factory.** `ForkRecovery.resolveFork` takes `adminCallbackFor: (parent) => IncomingMessageCallback` instead of a single `adminCallback`. `#buildBranches` calls it for every explored node, both for `resolveCandidateParent` and for witness collection.
- **Engine callers.** `#resolveFork` and `#settleDisbandCandidates` pass the factory. `#gatherTreeWitnesses` also builds its callback per node state now.
- **Consistency.** Every seam now authorizes against the candidate's own parent: inbound ingest, pool replay, pool sweep and tree-fed convergence.
- **API break.** This renames a public `./engine` option, so the change is recorded in the changeset.
- **Existing tests.** Three test call sites were updated to the new option.
- **New test.** The engine's own confirmed commit demotes admin2 at epoch 1 to 2. Admin2's competing epoch-1 commit then makes an admin-only change. It is now a scored candidate: no `rejected` result, and its edge is recorded in the history tree. Before the fix it came back `rejected` / `admin-policy`.

### CR-03: A malformed optional component turned admin-only-commit enforcement off

**Files modified:** `src/engine/admin-policy.ts`, `src/engine/group-engine.ts`, `src/engine/ingest.ts`, `src/engine/fork-recovery.ts`, `src/engine/__tests__/admin-policy-fail-closed.test.ts` (new), `.changeset/account-identity-proof-v2.md`
**Commit:** 34da2a4
**Status:** fixed: requires human verification (authorization and admission semantics changed)

**Applied fix:**
- **Admin gate.** `#createAdminVerificationCallback` no longer uses `getMarmotGroupView`, which returns `null` if *any* component fails to decode. It decodes only `admin_policy`:
  - **Absent policy:** an empty admin set, not accept-all.
  - **Undecodable policy:** every commit is rejected, and proposals still get pre-apply admission.
  - The engine's `acceptAll` fallback is removed.
- **MDK reference.** This matches `admins_of_group`: a missing policy gives an empty set, and a decode error propagates as a refusal.
- **Payload validation.**
  - The new exported `validatePreApplyProposals` (in `src/engine/admin-policy.ts`) runs the Add-proof check, then checks that each AppDataUpdate `update` for a known component id decodes with that component's codec. A payload that doesn't decode is reported as `component-integrity`.
  - It is used by `createAdminCommitPolicyCallback` for both proposals and commits. All four rejection-label sites use it too, so an admin-callback refusal gets the same reason on every seam: both ingest loops, `resolveCandidateParent`, and `#sweepResult`.
  - This matches MDK `validate_app_data_update_batch` / `validate_app_component_update`.
- **Tests.** There are three rows, and all of them were `processed` before the fix:
  - A non-admin's admin-only commit, at an epoch whose avatar bytes are malformed, is `rejected` / `admin-policy`.
  - A standalone proposal with an undecodable avatar payload is `rejected` / `component-integrity` and is not staged.
  - An admin commit carrying that payload is `rejected` / `component-integrity`.
- **Where this differs from the review, and other notes:**
  - A malformed `admin_policy` by itself was already refused after apply by admin-leaf coupling ("carried-forward admin-policy component did not decode"). The bypass that could actually be reached was a malformed *optional* component, and the first test row targets exactly that.
  - Behaviour change: a group with no `admin_policy` used to accept every commit when its profile and routing were also absent. It now allows only self-update or self-remove commits from non-admins, as MDK does. The full suite passed with this change.
- **Please check:**
  - Payload validation covers **inbound** seams only, and only whether the payload decodes. MDK's removal rules for batches (`validate_app_component_remove_against`, one operation per component) were not ported. The local `send` path does not run the payload check.
  - Local `commit` / `selfUpdate` on a group whose view is `null` still throws "MarmotGroupData not found". The review mentioned this but did not ask for a fix; it is unchanged.

### WR-01: A rewind with every triggering candidate refused lost its notifications and disband evidence

**Files modified:** `src/engine/ingest.ts`, `src/client/session/group-session.ts`, `src/client/group/marmot-group.ts`, `src/engine/__tests__/ingest-rewind-without-envelope.test.ts` (new)
**Commit:** 1e8797c
**Status:** fixed: requires human verification (the client-side terminal path has no dedicated regression test)

**Applied fix:**
- **Notifications.** When `recovered` leaves no live pool envelope, `ingestEnvelopes` now yields the applied chain's notifications as `appliedNotifications` results that carry no envelope. That is how `#reconvergeFromTree` already reports tree-fed rewinds.
- **Disband evidence.** No existing result type can carry it without an envelope, so it is realized from engine state instead:
  - `GroupSession.ingest` persists `engine.selectedDisbandEvidence` after draining, exactly as `driveConvergence` does.
  - `MarmotGroup.ingest` adds a trailing `realizeDisbandIfNeeded()` next to the existing trailing removal re-check.
  - Both calls are idempotent.
- **Test.** A stub-context `ingestEnvelopes` run where `resolveFork` returns `recovered` with every pool entry refused. The notifications now come back as `appliedNotifications`; before the fix only the `rejected` result was yielded.
- **Please check:**
  - Building this scenario through the full engine was not practical: a rewind has to win while every triggering pool entry is refused. So the test drives the stub directly.
  - The client-layer disband persistence and realization is covered only by the full suite plus review of the code; there is no dedicated test.

### WR-02: Tree-fed fallback dropped the legal prefix of an invalid branch

**Files modified:** `src/engine/group-engine.ts`, `src/engine/__tests__/account-identity-proof-seams.test.ts`, `src/engine/__tests__/send-commit-legality.test.ts`, `.changeset/account-identity-proof-v2.md`
**Commit:** b21a84a
**Status:** fixed: requires human verification (branch selection semantics)

**Applied fix:**
- **Engine change.**
  - When `#treeResolution` finds an invalid link, it now returns `invalid` with `lastValidTag`, the node just before that link. If the first link is invalid there is no such node.
  - `#reconvergeFromTree` then replaces the candidate with a truncated one built by the new `#treePrefixCandidate`. The truncated candidate uses that node's epoch and edge digest, keeps only witnesses eligible for the shorter tip, and selection re-runs.
  - A candidate is dropped outright only when its first link is invalid.
- **Why this is not a guess.** The orchestrator suggested skipping WR-02 if it needed a design decision. It doesn't, for two reasons:
  - **MDK.** The candidate-path BFS in `refs/mdk/crates/cgka-engine/src/openmls_projection.rs` marks a commit invalid against its candidate state and moves on, keeping the path that could not be extended as a completed candidate (`if !path.messages.is_empty() && !extended { completed.push(path) }`).
  - **marmot-ts pool replay.** `ForkRecovery`'s `explore` already keeps a legal prefix. Tree-fed convergence was the only seam that dropped it.
- **New test.** The tree holds branch `sib1 → sib2` (both legal) `→ sib3` (illegal), and the engine's own branch is one commit deep. The engine now switches to `sib2` at epoch 3. Before the fix it stayed on its own tip.
- **Existing tests changed.** Four existing tree-fed rows relied on the whole branch being dropped:
  - the seams "drop requirement" row;
  - the seams "Add without proof" row;
  - the seams CR-01 fallback row;
  - the `send-commit-legality` tree-fed row.

  In each, the legal prefix now ties a rival branch on depth, so the lower tip digest decides. These rows now assert the tip is never the illegal commit and equals the lower-digest candidate, which is deterministic for any given run. They passed 5 of 5 repeated runs. The update-path row, where the first link is invalid, and the legal control row are unchanged.
- **Please check:** that you accept the tie-break assertions in those four rows.

### WR-03: The known-state fallback ran only the 0x8009 check

**Files modified:** `src/engine/fork-recovery.ts`, `src/engine/__tests__/known-state-fallback-legality.test.ts` (new)
**Commit:** 7b521bc
**Status:** fixed: requires human verification (legality gate on the own-commit / disband known-state path)

**Applied fix:**
- **What runs now.** When `proposalsFromPublicCommit` cannot rebuild the proposals, `resolveCandidateParent` calls the new `validateLegalityWithoutProposals`. It runs:
  - component-integrity rules 1 and 2, plus the leaf-only `0x8009` guard;
  - the `0x8009` profile and changed-leaf proof check;
  - admin-leaf coupling.
- **Rule 3.** Rule 3 needs the commit's proposals, so it is neutralized by passing ops that cover every resulting entry and every removal, never `0x8009`, to the unchanged exported `validateAppComponentIntegrity`. Its logic is not duplicated.
- **Not run.** Disband legality needs the proposals, so it cannot run on this path.
- **Docs.** The docstring and the comment in `#buildBranches` now state exactly what runs.
- **Test.** Admin2 sends a PrivateMessage commit that removes admin1's only leaf without dropping admin1 from `admin_policy`, and the recorded child is known. The result is now `rejected` / `admin-leaf-coupling`; before the fix it was `resolved`.
- **Not addressed.** IN-04 (a test that drives this through `#treeResolution` with a real stamp) is out of scope.

### WR-04: Changeset omitted other widened unions

**Files modified:** `.changeset/account-identity-proof-v2.md`
**Commit:** 3d7428b
**Applied fix:**
- **Unions.** The breaking-changes list now covers every widened union: `SkippedIngestResult.reason` (`"unsupported-profile"`), `RejectedIngestResult.reason` and the exported `CommitIntegrityViolationReason` (both `"account-identity-proof"`).
- **Proposals.** It also notes that `ingest()` can now return `rejected` for a standalone proposal, not only for a commit.
- **Verification.** Text only: re-read, and `prettier --check` passed.

## Out of Scope (Info)

- **IN-01:** the `withCapturedProposals` docstring is now contradicted further, because `inner` also runs `validatePreApplyProposals`.
- **IN-02, IN-03, IN-04:** not addressed.

---

_Fixed: 2026-09-15T20:04:49Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
