---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
reviewed: 2026-09-15T20:00:00Z
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
  critical: 1
  warning: 4
  info: 6
  total: 11
status: issues_found
---

# Phase 8: Code Review Report (re-review, iteration 2)

**Reviewed:** 2026-09-15T20:00:00Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

This is a re-review of the Phase 8 diff after the fix commits `30986e0..bcd2c19` (CR-01, WR-01..WR-06). I checked each fix against the prior finding, the code around it, and `refs/mdk`.

**Correctly closed** — none of these is re-raised:
- **CR-01 (sweep path):** `#sweepResult` now runs `validateCommitLegality` before `recordCommit`.
- **WR-02:** the `"admin-policy"` fallback label in the sweep.
- **WR-06:** the up-front `profileSupport` gate in `MarmotGroupEngine.ingest()`, and the auto-commit guard.
- **WR-05 core:** pruning staged invalid Adds from `createCommit` input. Own-commit stamps and explicit `proposalRefs` stay consistent with it.
- **WR-01 (replay seam):** the `rejected` projection on the replay seam is correct for the envelopes it covers.

**Partially closed, or regressions introduced:**
- **WR-04 (BLOCKER, CR-01 below).** The fix kept the "permissive admin-policy fallback" when `getMarmotGroupView` is `null`. In that state every inbound commit from any member is authorized. The state is reachable through a legal admin commit, and the fix's own regression test builds exactly that state. MDK decodes admin policy independently and rejects the malformed bytes that cause it. This is new evidence for the half of WR-04 the fixer deliberately declined.
- **CR-01 fallback (WR-01).** Tree-fed fallback drops a whole leaf-tip candidate. A legal interior prefix of an illegal tip is never considered, although MDK would score it as a tip. The changeset's "falls back to the best remaining legal branch" is therefore not accurate.
- **CR-01 fallback (WR-02).** `authentication_mismatch` is mapped to `invalid`, so a local-only replay failure excludes the top branch and adopts the runner-up. The fix's own rationale says this must not happen.
- **WR-01 fix (WR-03).** A new `!rep` branch applies a rewind but drops its state notifications and `selectedTerminal` on the floor.
- **WR-03 fix (WR-04).** When proposals cannot be rebuilt, the fix quietly falls back to a partial gate and still returns `resolved`.

## Critical Issues

### CR-01: Admin authorization is bypassed for every inbound commit whenever the group-data view fails to decode (WR-04 fix kept `acceptAll` for commits); the state is reachable via a legal admin commit that MDK rejects

**Files:**
- `src/engine/group-engine.ts:3217-3241`
- `src/core/client-state.ts:262-290`
- `src/core/components/integrity.ts:212-238`
- `src/engine/__tests__/standalone-add-admission.test.ts:457-485`

**Issue:** When `getMarmotGroupView(state)` is `null`, `#createAdminVerificationCallback` returns a callback that only checks Add proofs and otherwise returns `acceptAll(incoming)`, for `commit` kinds too. Inbound commit authorization lives only in this callback: `validateCommitLegality` checks integrity, the proof check, disband legality and admin-leaf coupling, but never who the committer is.

In that state, every seam accepts any member's commit: inbound `ingest.ts:569`, the sweep, replay and tree-fed. For example:
- a non-admin's `AppDataUpdate` rewriting `0x8002` admin-policy to name itself admin,
- a non-admin's `Remove` of other members.

Rule 3 passes the first because it is backed by the commit's own op. Admin-leaf coupling only checks for orphaned admins.

**How the state is reached:**
- `getMarmotGroupView` wraps *every* optional component decode (avatar, encrypted-media, retention, lifecycle) in one `try`/`catch → null` (`client-state.ts:265-290`). One malformed optional component therefore disables the admin gate.
- `validateAppComponentIntegrity` never validates component bytes, so an admin's `AppDataUpdate` writing `0xff` to `0x8007` is legal on every marmot-ts seam.
- The WR-04 regression test builds exactly this: `expect(getMarmotGroupView(adminEpoch2!)).toBeNull()` right after a malformed-avatar commit. That test then only checks the Add-proof path.

MDK is safe in both respects:
- It rejects that commit. `validate_app_component_update` decodes `GROUP_AVATAR_URL_COMPONENT_ID` and the other known ids (`refs/mdk/crates/cgka-engine/src/app_components.rs:1630-1660`). It is reached from `validate_current_profile_group_context(..., "resulting group state")` (`:825`) and from standalone `AppDataUpdate` admission (`:1687`).
- Its admin set comes from `admins_of_group`, which decodes only the admin-policy bytes (`:188-193`). An undecodable avatar can never widen commit authorization.

**Result:** after one buggy or malicious admin write, marmot-ts peers accept privilege escalation by any member. MDK peers reject those commits, and the group forks.

The WR-04 fixer declined "reject commits for lack of admin data" as out of scope. The reachability path and the MDK divergence above are the new evidence.

**Fix:** Derive admin authorization from the admin-policy component alone, independent of the aggregate view, and fail closed when it is present but undecodable:
```ts
#createAdminVerificationCallback(state: ClientState = this.state): IncomingMessageCallback {
  let adminPubkeys: string[] | undefined;
  try {
    adminPubkeys = getAdminPolicy(state.groupContext.extensions);
  } catch {
    // Undecodable admin policy: keep Add-proof admission, refuse every commit.
    return (incoming) =>
      incoming.kind === "proposal"
        ? validateAddProposalAccountIdentityProofs([incoming.proposal], this.ciphersuite.id) ? "reject" : "accept"
        : "reject";
  }
  return createAdminCommitPolicyCallback({
    ratchetTree: state.ratchetTree,
    adminPubkeys: adminPubkeys ?? [],
    ciphersuiteId: this.ciphersuite.id,
    onUnverifiableCommit: "retry",
  });
}
```
Also port MDK's `validate_app_component_update` into `validateAppComponentIntegrity` Rule 3: decode every *known* component id's resulting bytes, and reject `component-integrity` on failure. That removes the reachable corrupt state on all seams. Add a test where a non-admin commits an admin-policy `AppDataUpdate` after a malformed-avatar epoch.

## Warnings

### WR-01: Tree-fed fallback excludes whole leaf tips, so a legal prefix of an illegal branch is never a candidate (MDK would score it)

**Files:** `src/engine/group-engine.ts:2948-2960`, `src/engine/tree-convergence.ts:87-108`, `.changeset/account-identity-proof-v2.md:23-29`

**Issue:** `buildTreeBranchSet` enumerates only nodes with no children. When `#treeResolution` returns `invalid` for tip `T`, the loop removes `T` entirely. Say `T`'s chain is `root → A (legal) → B (illegal) = T`. Node `A` is a legal depth-1 branch that MDK would keep as a tip, because it drops only `B` (`InvalidAgainstCandidateState`). It never enters `remaining`, so selection may:
- adopt a runner-up that `A` should beat, or
- return because the current tip now wins.

The CR-01 regression test (`account-identity-proof-seams.test.ts:417-480`) hides this:
- The illegal branch is `sib1 → alt2 → illegal3`. `alt2` is a legal depth-2 interior node, tied on depth with the winning `legal2`.
- MDK would break that tie between `alt2` and `legal2` on committer or digest. marmot-ts never considers `alt2`, so the test passes only when `legal2` happens to win that tie.

The changeset's "falls back to the best remaining legal branch" is not what the code does.

**Fix:** Have `#treeResolution` report the index of the first invalid link, e.g. `{ kind: "invalid", validPrefixTag }`, where `validPrefixTag` is that link's parent tag. On `invalid`, replace the candidate with one whose `id`/`tipEpoch`/`tipDigest` describe `validPrefixTag`, rather than filtering it out. Skip the replacement if that prefix is the root or already a candidate. Add a test where the hidden interior node wins the tiebreak.

### WR-02: A local-only replay failure (`authentication_mismatch`) is treated as permanently `invalid`, excluding the top branch and adopting a runner-up

**Files:** `src/engine/group-engine.ts:3119-3137`, `src/engine/fork-recovery.ts:207-209`, `src/engine/admin-policy.ts:123-127`, `src/engine/history-tree.ts:349-362, 432-440`

**Issue:** `#treeResolution` maps every non-`resolved`, non-`deferred` `ParentResolution` to `invalid`. `resolveCandidateParent` returns `authentication_mismatch` for *any* throw out of `processMessage`, which includes failures that say nothing about the commit's validity:
- **Unstamped own commits.** `ownCommitStampOf` returns `undefined` for a `legacy` bare-bytes record (older builds; `recordCommit` only upgrades a record when it is re-confirmed). `processMessage` cannot replay one's own UpdatePath commit (see the RFC 9420 note at `fork-recovery.ts:153-158`).
- **The "retry" throw.** `createAdminCommitPolicyCallback` throws `"unverifiable commit sender"` when `onUnverifiableCommit === "retry"`, and that surfaces as `authentication_mismatch`.

Before the fix these ended the pass. Now the branch is excluded and the loop adopts a runner-up. The fix's own comment (`group-engine.ts:2938-2940`) says a non-permanent refusal must not do this, because "adopting a runner-up now would be a switch spec-conformant peers do not make". The result is local divergence from peers that can validate the excluded branch.

**Fix:** Map `authentication_mismatch` to `deferred` in `#treeResolution`. Reserve `invalid` for `rejected` (a real legality or admin verdict) and for a confirmation-tag mismatch. If a stored edge must be classified as unauthenticatable, compare the tree edge's `senderLeafIndex` to our own leaf, so an unstamped own commit is treated as `deferred`, not `invalid`.

### WR-03: WR-01 fix's `!rep` branch applies a recovered rewind but surfaces none of its state notifications or its selected terminal

**Files:** `src/engine/ingest.ts:985-1030`; consumers `src/engine/group-engine.ts:1610-1629`, `src/client/group/marmot-group.ts:1280-1281`

**Issue:** When every `retainedPool` entry is refused, `livePool` is empty. The rewind still happens (`ctx.resolveFork` already applied it via `#applyForkResolution`), carried by `encrypted` or `ours` material. However, the `!rep` branch yields nothing for it. Two things depend on that yield:
- **Notifications.** `MarmotGroupEngine.ingest()` emits `appliedNotifications` only from a `processed`/`removed` result's `notifications` (`group-engine.ts:1610-1629`). The winner chain's notifications (member added/removed, epoch advanced, `selfRemoved`) are recorded in the ledger but never delivered.
- **Disband realization.** It runs only on `result.kind === "processed" && result.selectedTerminal` (`marmot-group.ts:1280`). A rewind onto a selected terminal is not realized in this ingest call.

Removal is still caught by the trailing `#realizeRemovalIfNeeded()`, but nothing else is. Before the fix `retainedPool[0]` always existed, so this is a regression.

**Fix:** In the `!rep` case, mirror `#reconvergeFromTree`, which also has no envelope:
```ts
if (!rep) {
  for (const group of groupWithdrawnNotificationsByCommit(resolution.notifications ?? []))
    yield { kind: "appliedNotifications", commitDigest: group.commitDigest, notifications: group.withdrawn };
}
```
Handle `selectedTerminal` too, e.g. by having the client run `realizeDisbandIfNeeded()` after the loop the same way it re-asserts removal. Add a test where the only pooled candidate is refused but `encrypted` material carries the winning branch.

### WR-04: WR-03 fix silently downgrades the own-commit shortcut to a partial gate and still returns `resolved`

**File:** `src/engine/fork-recovery.ts:166-190`

**Issue:** When `proposalsFromPublicCommit` returns `undefined`, only `validateCommitAccountIdentityProofs` runs. That happens for a PrivateMessage commit, a non-member sender, or a `ProposalRef` missing from `parent.unappliedProposals`, for example a snapshot taken before a proposal was staged onto it. In that case these checks are all skipped:
- component-integrity,
- disband-legality,
- admin-leaf coupling,

yet the result is `resolved` and the edge is adopted. The CR-04/WR-03 comment at `:446-456` and the fix report both describe this as "the legality gate", and the persisted pre-upgrade edge it exists to catch is exactly the one this downgrade lets through. A recorded child with an illegal dictionary rewrite whose ref cannot be resolved is still grandfathered in.

**Fix:** Fail closed when proposals cannot be rebuilt, returning `{ kind: "deferred", reason: "temporary_refusal" }`, or run `validateAppComponentIntegrity` with an empty op list (any dictionary change then fails). At minimum, log or audit the downgrade and correct the comment so it no longer claims the full gate.

## Info

### IN-01: `withCapturedProposals` docstring still forbids validation inside `inner` (carried forward, unfixed)

**File:** `src/engine/admin-policy.ts:160-162`
**Issue:** The docstring still says "No validation logic may be added inside this wrapper or inside `inner`", while `inner` performs Add-proof validation (lines 49-67). WR-04's fallback callback in `group-engine.ts:3229-3240` adds another such `inner`.
**Fix:** Reword it: pre-apply checks that need no resulting `GroupContext` are allowed in `inner`.

### IN-02: Send path reports the same bad Add with two error types (carried forward, unfixed)

**File:** `src/engine/group-engine.ts:936-944` vs `1009-1013, 1228-1232`
**Issue:** `send({kind:"proposal"})` throws `AccountIdentityProofError`. `send({kind:"commit"})` throws `CommitLegalityError` for a by-value Add and, since WR-05, also for an explicit `proposalRefs` Add.
**Fix:** Throw one error type that carries the structured violation.

### IN-03: The rejection-label derivation is now duplicated in six places (carried forward, grown)

**File:**
- `src/engine/ingest.ts:614-631, 785-801, 967-981`
- `src/engine/group-engine.ts:1924-1936, 3126-3131`
- `src/engine/fork-recovery.ts:211-220`

**Issue:** Each site re-runs `validateAddProposalAccountIdentityProofs` and/or applies `?? "admin-policy"` to guess why the callback rejected. The WR-01 and WR-02 fixes added two more copies.
**Fix:** Have the callback factory record its rejection reason through the capture side channel, and share one `rejectedFromCallback()` helper.

### IN-04: `#settleAndDrive` calls `disband()` with no profile guard (carried forward, unfixed)

**File:** `src/client/group/marmot-group.ts:1076-1080`
**Issue:** `resumePendingDisband` skips unsupported groups, but `#settleAndDrive` does not. For an unsupported group with a pending disband request, `disband()` catches the refused `requestDisband` and returns `rejected/legality` rather than a profile-typed refusal. Engine `send()` still checks the disband gate before the profile gate (`group-engine.ts:852` vs `869-871`).
**Fix:** Add the `profileSupport` guard in `#settleAndDrive`, and order the profile gate first in `send()`.

### IN-05: Sweep legality `catch` does not "keep it pooled", and sweep rejections skip content dedup

**File:** `src/engine/group-engine.ts:1953-1956, 1964-1972, 1833-1834`
**Issue:** `entry.triedTags.add(tag)` runs before `#sweepResult`. Returning `undefined` from the `catch` therefore never retries that node, so the entry eventually leaves as `unreadable`. The comment "Mirrors resolveCandidateParent's `deferred`" is inaccurate, although the validator is non-throwing, so the path is nearly dead. Separately, sweep `rejected` results never call dedup `remember`, unlike every rejection in `ingest.ts` (`619, 794, 825, 973`). A re-wrapped copy therefore re-enters the pool and is rejected again.
**Fix:** Delete the `catch` or correct its comment, and remember rejected sweep messages in the engine's content dedup.

### IN-06: Pruned invalid staged Adds are dropped silently

**File:** `src/engine/group-engine.ts:1214, 2131-2133, 3257-3268`
**Issue:** `withoutInvalidStagedAdds` removes proposals from the commit without a log line or audit event. The changeset does not mention that a local commit may now omit a staged Add. The fix report also says the WR-03 regression test was never run against unfixed code.
**Fix:** Log or audit the pruned proposal refs, note the behavior in the changeset, and confirm the WR-03 seam row fails on `b5e0111^`.

---

_Reviewed: 2026-09-15T20:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
