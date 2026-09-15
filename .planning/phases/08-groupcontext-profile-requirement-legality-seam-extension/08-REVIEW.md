---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
reviewed: 2026-09-15T19:32:06Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - .changeset/account-identity-proof-v2.md
  - docs/client/best-practices.md
  - src/__tests__/exports.test.ts
  - src/__tests__/helpers/account-identity-proof-fixtures.ts
  - src/__tests__/helpers/engine-seam-fixtures.ts
  - src/client/__tests__/join-account-identity-proof.test.ts
  - src/client/__tests__/unsupported-profile-groups.test.ts
  - src/client/group-registry.ts
  - src/client/group/__tests__/invite.test.ts
  - src/client/group/__tests__/marmot-group.test.ts
  - src/client/group/marmot-group.ts
  - src/client/session/group-session.ts
  - src/core/__tests__/group.test.ts
  - src/core/components/__tests__/account-identity-proof.test.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/components/__tests__/tree-diff.test.ts
  - src/core/components/account-identity-proof.ts
  - src/core/components/index.ts
  - src/core/components/integrity.ts
  - src/core/components/tree-diff.ts
  - src/engine/__tests__/account-identity-proof-seams.test.ts
  - src/engine/__tests__/group-engine.test.ts
  - src/engine/__tests__/standalone-add-admission.test.ts
  - src/engine/__tests__/unsupported-profile.test.ts
  - src/engine/admin-policy.ts
  - src/engine/fork-recovery.ts
  - src/engine/group-engine.ts
  - src/engine/ingest-disposition.ts
  - src/engine/ingest.ts
  - src/engine/types.ts
findings:
  critical: 3
  warning: 4
  info: 4
  total: 11
status: issues_found
---

# Phase 8: Code Review Report (iteration 2)

**Reviewed:** 2026-09-15T19:32:06Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

This round re-reviews the phase 8 legality-seam extension after the iteration-1 fixes (CR-01, WR-01..WR-06).

**Iteration-1 fixes that hold up:**
- **CR-01:** the pool sweep now runs `validateCommitLegality` before `recordCommit`.
- **WR-02:** the pool sweep's admin-callback rejection is labeled `admin-policy`, no longer `undefined`.
- **WR-06:** there is an engine-level gate for unsupported profiles.
- **WR-05:** staged invalid Adds are pruned before `createCommit`.

**What is still wrong.** The remaining problems are about *which state* the admin-authorization callback is evaluated against, and what the new fixes do with the verdicts it produces:

1. **Stale callback in inbound ingest.** `ingestEnvelopes` builds one admin callback from the pre-batch canonical state and reuses it for every commit in the batch. A commit from an admin demoted by an earlier commit in the same batch is accepted.
   - The pattern predates this phase, but this phase moved that callback earlier so both loops share it.
2. **Wrong state in pool replay.** Fork-recovery pool replay authorizes candidates against the canonical tip, not their own parent. Tree-fed resolution uses the parent, so the two seams disagree.
   - WR-01 now turns those wrong refusals into permanent `rejected` + dedup-remembered verdicts.
3. **Unreadable group view disables admin enforcement.** WR-04 kept the `acceptAll` admin fallback when the group view is unreadable. The new WR-04 test proves that state is reachable by writing malformed bytes to one optional component, and nothing validates AppDataUpdate payloads.

**Smaller issues:**
- A rewind can silently lose its notifications and disband evidence.
- Tree-fed exclusion drops the legal prefix of an invalid branch, which MDK would keep.
- The known-state (own-commit) fallback check is weaker than full legality.

## Critical Issues

### CR-01: One admin callback serves every commit in a batch, so a same-batch demoted admin's commit is accepted

**File:** `src/engine/ingest.ts:569` (callback built), `:766-775` (reused per commit); `src/engine/group-engine.ts:2487`, `:3217-3249`

**Issue:**
- **How the callback is built.** `const capture = withCapturedProposals(ctx.createAdminCallback())` is created once per `ingestEnvelopes` call. `createAdminCallback` is `() => this.#createAdminVerificationCallback()`, whose `state = this.state` default is evaluated at that moment. `createAdminCommitPolicyCallback` then captures `state.ratchetTree` and `groupData.adminPubkeys` by value.
- **Why that is wrong.** The commit loop applies commits in order: N→N+1, then N+1→N+2 in the same batch (`ctx.setState(result.newState)` at 856). Every later commit is still authorized against the epoch-N admin set and tree.

**Concrete bypass:** a batch contains commit 1 and commit 2.
1. In commit 1, admin A removes B from `admin_policy` (an AppDataUpdate).
2. In commit 2, built by B at epoch N+1, B Removes member C.
3. The stale callback still lists B as an admin, so it returns `"accept"`.
4. `validateCommitLegality` does not re-check committer authorization; admin-leaf coupling only checks that admins still have leaves. Commit 2 is applied.

A peer that receives the two commits in separate batches rejects commit 2. The result is a permanent authorization bypass plus a deterministic fork between members.
- **The reverse case.** A newly promoted admin's first commit in the same batch is rejected and `dedup.remember`ed, so it is never retried.
- **Tree lookups.** Stale-tree sender lookups throw `"unverifiable commit sender"` and recover via retry. Stale admin sets do not recover.

The loop pattern predates phase 8, but this phase hoisted the shared capture above the non-commit loop (the comment at 564-568 argues it is safe) without addressing the per-commit parent. Every other seam now authorizes against the exact parent: `#treeResolution` uses `this.#createAdminVerificationCallback(link.parent)` and `#sweepResult` uses `(state)`.

**Fix:** build the admin callback from the commit's actual parent for every commit. Keep one shared `take()` discipline if desired, but rebuild the inner callback each time:
```ts
// ingest.ts, IngestContext
createAdminCallback(state: ClientState): IncomingMessageCallback;

// commit loop
capture.take();
const parentForAuth = ctx.getState();
const perCommit = withCapturedProposals(ctx.createAdminCallback(parentForAuth));
const result = await processMessage({ ..., state: parentForAuth, message, callback: perCommit.callback });
const capturedCommit = perCommit.take();
```
The non-commit loop should do the same, because the WR-04 fallback and the Add check also depend on the state's group view. Add a regression row with a demotion commit and a demoted-admin commit in the same batch, and assert that the second is `rejected` / `admin-policy`.

### CR-02: Pool replay authorizes candidates against the canonical tip, and WR-01 makes those wrong refusals permanent

**File:** `src/engine/group-engine.ts:2648`, `:2610`; `src/engine/fork-recovery.ts:460-480`; `src/engine/ingest.ts:950-983`

**Issue:**
- **Wrong state.** `#resolveFork` and `#settleDisbandCandidates` pass `adminCallback: this.#createAdminVerificationCallback()`, which is built from the current canonical `this.state`. `ForkRecovery.#buildBranches` passes that single callback to `resolveCandidateParent` for every explored node at every depth. A candidate commit at fork epoch N is therefore authorized against the admin set and ratchet tree of the canonical tip, possibly several epochs later on another branch.
- **Consequences:**
  - An admin legitimately authorized at N but demoted on the canonical branch gets their fork commit refused.
  - A leaf index reassigned on the canonical branch (removed, then re-filled by an Add) resolves to the wrong credential, so the admin decision is made on the wrong identity.
  - A member promoted only on the canonical branch has a fork commit accepted that its real parent would refuse.
- **Seams disagree.** `#treeResolution` (3111) correctly uses `this.#createAdminVerificationCallback(link.parent)`, so the same edge can be refused by pool replay and adopted by tree-fed convergence. That is the mdk#707 class ("a guard that differs per seam").
- **What WR-01 changed.** Previously such a candidate was silently skipped as `past-epoch` and could be retried. Now:
  - `resolution.kind === "rejected"` feeds `rejectedByDigest`;
  - `ingest.ts` yields `rejected` with `reason: "admin-policy"` and calls `ctx.dedup.remember(p.message)`, so a legitimately authorized fork commit is permanently discarded and mislabeled;
  - the branch it would have built is never scored, so this client can select a different canonical branch than peers that validate against the candidate parent, as MDK does.

**Fix:** build the callback from the parent being explored, not once per resolution. Make `resolveFork` accept a factory:
```ts
// fork-recovery.ts
adminCallbackFor: (parent: ClientState) => IncomingMessageCallback;
// #buildBranches / explore
const resolution = await resolveCandidateParent({
  ciphersuite: this.#ciphersuite, parent: state, message,
  callback: adminCallbackFor(state), known: ...,
});
// witnessesAt likewise uses adminCallbackFor(state)
// group-engine.ts
adminCallbackFor: (s) => this.#createAdminVerificationCallback(s),
```
Add a regression test: fork at N; the canonical branch demotes admin B at N+1; B's competing commit at N must resolve, not be `rejected`.

### CR-03: A malformed optional component turns admin-only-commit enforcement off for the whole group, and WR-04 kept that fallback

**File:** `src/engine/group-engine.ts:3217-3241`; `src/core/client-state.ts` `getMarmotGroupView` (returns `null` from its `catch`); `src/engine/admin-policy.ts:49-59`

**Issue:**
- **Why the view goes null.** `getMarmotGroupView` wraps *all* component decodes (profile, admin policy, routing, avatar, media, retention, lifecycle) in one `try` and returns `null` on any throw.
- **What null does.** When the view is `null`, `#createAdminVerificationCallback` now returns a closure that rejects only invalid Adds and otherwise calls `acceptAll(incoming)`. That is, **every commit from every member is accepted**: non-admins can Remove admins, rewrite `admin_policy`, change routing, and so on. `validateCommitLegality` does not check committer authorization.
- **Reachable from a non-admin.** The new WR-04 test (`standalone-add-admission.test.ts:457-485`) reaches this state with one AppDataUpdate that writes malformed bytes to the optional avatar component `0x8007`. Nothing validates AppDataUpdate payloads:
  - `validateAppComponentIntegrity` only checks that a change is backed by an op;
  - the admin callback accepts any non-Add standalone proposal (`admin-policy.ts:49-59`);
  - `createCommit` bundles every unapplied proposal by reference (the CR-03 note at `group-engine.ts:1095-1104`).

  So a **non-admin** can propose a malformed avatar update. The next admin `commit` or `selfUpdate` bundles it, and from then on every receiver's admin gate is open.
- **Local side.** `case "commit"` / `"selfUpdate"` throw `"MarmotGroupData not found"`, so honest admins cannot even commit a repair locally.

The fix report states that rejecting commits "for lack of admin data" was deliberately not done. That leaves a reachable authorization bypass that phase 8's own test fixture demonstrates.

**Fix:** decode admin policy independently of the cosmetic components, and fail closed only when the admin policy itself cannot be read:
```ts
#createAdminVerificationCallback(state = this.state): IncomingMessageCallback {
  let adminPubkeys: string[] | undefined;
  try {
    adminPubkeys = getAdminPolicy(state.groupContext.extensions);
  } catch {
    // Undecodable admin policy: refuse every commit rather than accept all.
    return (incoming) =>
      incoming.kind === "commit" ||
      validateAddProposalAccountIdentityProofs([incoming.proposal], this.ciphersuite.id)
        ? "reject" : "accept";
  }
  return createAdminCommitPolicyCallback({
    ratchetTree: state.ratchetTree,
    adminPubkeys: adminPubkeys ?? [],
    ciphersuiteId: this.ciphersuite.id,
    onUnverifiableCommit: "retry",
  });
}
```
Also reject a standalone AppDataUpdate proposal or commit op whose payload does not decode for a known component id. This is MDK's `validate_membership_proposal` / component-payload validation; without it the dictionary can still be poisoned.

## Warnings

### WR-01: A pool rewind where every triggering candidate was refused loses its notifications and disband evidence

**File:** `src/engine/ingest.ts:990-1030`; `src/engine/group-engine.ts:1610-1628`; `src/client/group/marmot-group.ts:1280-1281`

**Issue:**
- **The new branch.** When `resolution.outcome === "recovered"` but every retained-pool entry was moved to `rejected`, `rep` is `undefined`. The new empty `if (!rep) {}` branch then yields nothing for the rewind itself.
- **Notifications lost.** `resolution.notifications` are recorded in the ledger by `#applyForkResolution`, but they never reach the consumer. `appliedNotifications` is only emitted from a `processed` / `removed` result that carries `notifications`.
- **Disband evidence lost.** `resolution.selectedTerminal` is dropped, so `MarmotGroup.ingest` never calls `realizeDisbandIfNeeded()` for a rewind onto a disband branch. That runs only on `processed && selectedTerminal`, until some later unrelated trigger.

This is reachable because the winning branch can be carried by `ours`, retained own commits, while every pool entry is refused.

**Fix:** when `rep` is undefined, surface the rewind without an envelope, as `#reconvergeFromTree` does:
```ts
if (!rep) {
  for (const group of groupWithdrawnNotificationsByCommit(resolution.notifications ?? []))
    yield { kind: "appliedNotifications", commitDigest: group.commitDigest, notifications: group.withdrawn };
  // and carry selectedTerminal on a dedicated result (or trigger disband realization)
}
```

### WR-02: Tree-fed fallback drops the legal prefix of an invalid branch, diverging from MDK's selection

**File:** `src/engine/group-engine.ts:2941-2961`; `src/engine/tree-convergence.ts` `buildTreeBranchSet`

**Issue:**
- **What the code does.** `buildTreeBranchSet` emits only leaf tips as candidates. When `#treeResolution` returns `invalid` for a tip, the whole candidate is removed (`remaining.filter(c => c.id !== winner.id)`).
- **What MDK does.** The CR-01 fix comment says this mirrors MDK dropping `InvalidAgainstCandidateState`. But MDK drops the *invalid commit*, and the branch's legal prefix, ending at the last valid node, remains a scored candidate.
- **Example.** Branch X is `root → x1 (legal) → x2 (illegal)`; the current tip is on `root → y1`. MDK compares `x1` with `y1`. marmot-ts discards X entirely and stays on `y1`, even when `x1` wins the tiebreak (lower tip digest).
- **Result.** Two conformant clients can settle on different branches.

**Fix:** have `#treeResolution` return the index of the first invalid link. Replace the candidate with a truncated candidate whose tip is the last valid node (`id` = that node's tag, `tipEpoch` / `tipDigest` from it), then re-select. Only drop the candidate when the first link itself is invalid.

### WR-03: The known-state (own-commit) fallback runs only the 0x8009 check, skipping component-integrity, disband and admin-leaf-coupling

**File:** `src/engine/fork-recovery.ts:152-190`

**Issue:**
- **When the fallback runs.** `proposalsFromPublicCommit` returns `undefined` for a PrivateMessage commit, a non-member sender, or a `ProposalRef` that the parent snapshot no longer stages. `resolveCandidateParent` then falls back to `validateCommitAccountIdentityProofs` alone, and returns `resolved` if that passes.
- **Why it matters.** The WR-03 rationale is that the recorded child "may come from a persisted edge written by a build that never enforced" legality. That is equally true of component-integrity, disband-legality and admin-leaf-coupling, all of which are skipped here. So a pre-upgrade own edge that de-leafs the last admin, or rewrites the dictionary outside AppDataUpdate, is still grandfathered in whenever its refs cannot be rebuilt. The docstring claims "it still passes the legality gate".
- **Parent-only checks skipped too.** `validateCommitLegality` also runs checks that need no proposals: rule 1 and rule 2 of component integrity, and `validateAdminLeafCoupling`.

**Fix:** in the fallback, run at least the proposal-independent checks: rule 1/2 of `validateAppComponentIntegrity` (pass `appDataUpdateOps: []` only for the drop checks) and `validateAdminLeafCoupling`. Alternatively, when proposals cannot be rebuilt, return `deferred` so the edge is never adopted unchecked. Update the docstring to state exactly what runs.

### WR-04: Changeset omits the other widened unions that break exhaustive switches

**File:** `.changeset/account-identity-proof-v2.md:21-22`; `src/engine/types.ts:179-192`; `src/core/components/integrity.ts:47-51`

**Issue:** the changeset calls out only `SkippedIngestResult.reason` gaining `"unsupported-profile"` as breaking for exhaustive switches. `RejectedIngestResult.reason` and the exported `CommitIntegrityViolationReason` also gained `"account-identity-proof"`. Downstream `switch (result.reason)` with a `never` default, the same pattern `ingest-disposition.ts` uses, will fail to compile with no migration note.

Also, standalone *proposals* can now yield `kind: "rejected"` from `ingest()`. Previously a rejected result always meant a commit, and consumers may assume `rejected` implies a commit.

**Fix:** add both union widenings and the "rejected can now be a proposal" note to the breaking-changes list.

## Info

### IN-01: `withCapturedProposals` docstring now contradicts its inner callback

**File:** `src/engine/admin-policy.ts:160-162`
**Issue:** the docstring says "No validation logic may be added inside this wrapper or inside `inner`". But `inner`, which is `createAdminCommitPolicyCallback` and the WR-04 fallback closure, now performs pre-apply Add-proof validation for both commit and proposal kinds.
**Fix:** reword it to forbid only *post-apply* (resulting-GroupContext) validation inside the callback.

### IN-02: `#settleAndDrive` auto-disband is not gated for unsupported profiles

**File:** `src/client/group/marmot-group.ts:1078-1082`
**Issue:** `resumePendingDisband` gained an unsupported-profile guard (D-12), but the equivalent `disband()` call in `#settleAndDrive` did not. It currently only returns a `rejected` DisbandResult, because `send` throws. The two auto-publish sites are inconsistent, and a future change to `disband()` could bypass the engine gate.
**Fix:** route both through `resumePendingDisband()`, or add the same guard.

### IN-03: By-value Add proof check runs before commit authorization

**File:** `src/engine/group-engine.ts:1228-1232`
**Issue:** a non-admin who passes an Add by value gets `CommitLegalityError(account-identity-proof)` instead of the "Not a group admin" error. That misleads callers about the actual reason for refusal. The inbound admin callback has the same ordering, so this is only an error-message issue.
**Fix:** run `decideCommitAuthorization` first, or document the precedence.

### IN-04: WR-03 regression test was not validated against unfixed code

**File:** `src/engine/__tests__/account-identity-proof-seams.test.ts`
**Issue:** the fix report states that the WR-03 known-path row was the one regression test not run against the unfixed code. It calls `resolveCandidateParent` directly with a synthetic `known` state, so it does not prove that `#buildBranches` or `#treeResolution` reach that path with a real stamp.
**Fix:** revert the WR-03 hunk locally, confirm the row fails, and add a row that drives it through `#treeResolution` with a persisted own-commit stamp.

---

_Reviewed: 2026-09-15T19:32:06Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
