---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
reviewed: 2026-09-15T23:52:00Z
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
  critical: 2
  warning: 4
  info: 6
  total: 12
status: issues_found
---

# Phase 8: Code Review Report (round 3)

**Reviewed:** 2026-09-15T23:52:00Z
**Depth:** standard
**Files Reviewed:** 30 (plus the four round-2 regression test files and `refs/mdk` for protocol parity)
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

This round verifies the seven round-2 fixes at the code level and hunts for defects the fixes themselves introduced. `npx vitest run src/engine/__tests__ src/client/__tests__ src/core/components/__tests__` passes (45 files / 492 tests).

**Verification of the seven claimed fixes**

| Round-2 finding | Verdict | Evidence |
| --- | --- | --- |
| CR-01 per-batch admin callback | **Closed** | `ingest.ts:596-599` and `:771-774` rebuild `withCapturedProposals(ctx.createAdminCallback(ctx.getState()))` per message; `group-engine.ts:2488` threads the state through. Every remaining seam (`:1903` sweep, `:2613`/`:2652` replay factory, `:3168` tree-fed, `:3257` witnesses) passes an explicit parent — no call site relies on the tip. |
| CR-02 pool replay vs. canonical tip | **Closed** | `fork-recovery.ts:431`, `:457-464`, `:542-548`, `:688` take `adminCallbackFor(parent)` and invoke it per explored node. |
| CR-03 malformed component disables the admin gate | **Closed for the admin gate, two residuals** | `group-engine.ts:3274-3305` decodes only `admin_policy` and fails closed; `acceptAll` is gone. But the same `getMarmotGroupView`-returns-null hazard survives in the auto-committer (WR-01), and the new payload gate is inbound-only (CR-02 below). |
| WR-01 rewind with all candidates refused | **Partially closed** | `ingest.ts:1005-1021` yields envelope-free `appliedNotifications`; `group-session.ts:841-842` and `marmot-group.ts:1299` re-assert disband. The rewind's `selectedTerminal` and its `removed` classification are still dropped for direct `./engine` consumers (WR-04), and the new trailing persist adds a throw site (WR-02). |
| WR-02 legal prefix of an invalid tree branch | **Closed, with a new hole** | `group-engine.ts:2967-2975` + `#treePrefixCandidate` (`:3062-3085`) + `#treeResolution`'s `lastValidTag` (`:3143-3150`) implement the truncation. Nothing stops the truncated prefix from being an ancestor of the current tip (WR-03). |
| WR-03 known-state fallback legality | **Closed** | `fork-recovery.ts:163-213` runs component rules 1-2, the leaf-only `0x8009` guard, the profile/changed-leaf proof check and admin-leaf coupling; rule-3 neutralization via synthesized `backedOps` is correct (removals map to `data: undefined`, `0x8009` is never synthesized). Its regression test still drives `resolveCandidateParent` directly — IN-04 stands. |
| WR-04 changeset unions | **Closed** | `.changeset/account-identity-proof-v2.md:49-56` lists all three widened unions and the "rejected can be a proposal" note. |

**What is newly wrong.** Both criticals are in the CR-03 fix's newest code, `validatePreApplyProposals`:

1. It ports only the *update-decodes* half of MDK's `validate_app_data_update_batch`. The duplicate-operation rule and every removal rule are missing, so an ordinary member can craft one commit that marmot-ts applies and the Rust reference rejects — a deterministic partition, on the one property this milestone exists to guarantee.
2. It runs on inbound seams only. The local send path still builds, publishes, applies and records a commit that its own `ingest()` would reject.

## Critical Issues

### CR-01: AppDataUpdate batch validation diverges from MDK — a member can split TS clients from the Rust reference with one commit

**File:** `src/engine/admin-policy.ts:83-113` (`validatePreApplyProposals`), `:49-62` (decoder table); `src/core/components/integrity.ts:196-238` (rules 2 and 3)
**Reference:** `refs/mdk/crates/cgka-engine/src/app_components.rs:1698-1775` (`validate_app_data_update_batch_against`, `validate_app_component_remove_against`), called from `:519` `authorize_staged_commit_proposals` and `openmls_projection.rs:4240`

**Issue:** the fix report cites `validate_app_data_update_batch` as the model, but only one of its four rules was ported. MDK rejects the whole commit in each of the cases below; marmot-ts accepts it. Every one is a fork: MDK peers refuse the commit and stay on the parent epoch while marmot-ts peers advance.

- **Duplicate operations for one component id.** MDK: `if (!seen.insert(update.component_id())) return Err(...)` (`:1705-1710`). marmot-ts: `validatePreApplyProposals` iterates each op independently, and `validateAppComponentIntegrity` rule 3 (`integrity.ts:225-238`) only asks whether *some* op's bytes equal the resulting value — the last write matches, so the commit is "backed" and accepted. A commit with two `0x8001` updates is legal here and illegal in MDK.
- **Every `Remove` operation.** `validatePreApplyProposals:100` skips non-`update` operations outright (`if (appDataUpdate.operation !== "update") continue;`). MDK's `validate_app_component_remove_against` (`:1748-1775`) rejects removal of `app_components` (0x0001), `safe_aad` (0x0002), `group.lifecycle` (0x800c) **unconditionally**, and of anything in the *resulting* required set. marmot-ts only protects `requiredIds ∪ {0x0001}` via `integrity.ts:196-210`, and it derives `requiredIds` from the **parent** epoch, so MDK's "unrequire and remove in the same commit is legal, but removing a still-required component is not" rule is evaluated against a different list. A `Remove` of `0x800c` (lifecycle) or `0x0002` (safe_aad) in a group that does not require them is accepted here and refused by MDK. `classifyDisbandCommit` does not cover it either — `disband-validation.ts:70` inspects only `operation === "update"`.
- **Component ids MDK validates that the decoder table omits.** `COMPONENT_PAYLOAD_DECODERS` has no entry for `SAFE_AAD_COMPONENT_ID` (0x0002 — MDK errors on any update), `GROUP_BLOSSOM_IMAGE_COMPONENT_ID` (0x8002 — `validate_group_image`), or MDK's second encrypted-media id. `decode` is `undefined` for those ids, so line 102 `continue`s and the payload is accepted unvalidated.

An adversarial member needs no special privilege for the duplicate-op variant: any commit it is otherwise authorized to send carries it. The repo already ships an adversarial forker example that exercises exactly this shape of attack.

**Fix:** port the rest of the batch validator next to the existing one, and run it from the same call sites:

```ts
// src/engine/admin-policy.ts
const UNREMOVABLE_COMPONENT_IDS = new Set<number>([
  APP_COMPONENTS_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
]);

export function validateAppDataUpdateBatch(
  proposals: readonly (Proposal | ProposalWithSender)[],
  resultingRequiredIds: readonly AppComponentId[], // decoded from the batch's own 0x0001 update when present
): CommitIntegrityViolation | undefined {
  const seen = new Set<number>();
  for (const { appDataUpdate } of appDataUpdatesOf(proposals)) {
    if (!seen.add(appDataUpdate.componentId))
      return { reason: "component-integrity", detail: `multiple AppDataUpdate ops for 0x${...}` };
    if (appDataUpdate.operation === "remove") {
      if (UNREMOVABLE_COMPONENT_IDS.has(appDataUpdate.componentId) ||
          resultingRequiredIds.includes(appDataUpdate.componentId))
        return { reason: "component-integrity", detail: "component cannot be removed" };
    }
  }
  return undefined;
}
```
Reject an `update` for `SAFE_AAD_COMPONENT_ID` and `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` in the decoder switch rather than falling through to `continue`. Add MDK-vector rows for: two ops on one id; `Remove` of `0x800c`; `Remove` of `0x0002`; `update` of `0x0002`.

### CR-02: the new pre-apply payload gate is inbound-only — the send path publishes and locally applies commits its own ingest rejects

**File:** `src/engine/group-engine.ts:1187-1278` (`#prepareOutboundCommitProposals`), `:1387-1400` (`#assertStagedCommitLegal`), `:932-969` (`case "proposal"`); `src/engine/admin-policy.ts:83-113`

**Issue:** `validatePreApplyProposals` is called from four inbound seams (`ingest.ts:621`, `:795`, `group-engine.ts:1925`, `fork-recovery.ts:293`) and from `createAdminCommitPolicyCallback`. It is called from **no** outbound seam:

- `case "proposal"` (`:937-945`) validates only an Add's `0x8009` proof; an `AppDataUpdate` proposal with a payload that does not decode is created, wrapped and published.
- `#prepareOutboundCommitProposals` prunes invalid staged **Adds** (`:1215` `withoutInvalidStagedAdds`) and checks by-value **Adds** (`:1229-1233`), but never looks at `AppDataUpdate` payloads — neither the by-reference ones it bundles nor the by-value ones the caller supplied.
- `#assertStagedCommitLegal` runs `validateCommitLegality`, which has no payload-decodability check at all (rule 3 only asks whether the change is *backed* by an op).

Consequences, in increasing order of reachability:

1. A caller-supplied payload (`send({ kind: "proposal", proposal })` / `extraProposals` are public, documented extension points) produces a commit every conformant peer rejects with `component-integrity`. The sender applies it via `confirmPublished` and records it into retained history and the fork tree — permanent divergence, with no error surfaced to the caller.
2. Worse, it is reachable without a misbehaving app: `withoutInvalidStagedAdds` exists precisely because a pre-upgrade snapshot or a rewind can leave an inadmissible proposal staged. An `AppDataUpdate` in that position is **not** pruned, so `createCommit` bundles it by reference into the next local commit — including a `selfUpdate` or the `self_remove` auto-commit — and every one of those commits is refused by every peer.

This is the same "a guard that exists on one seam only is a documented bug" class (mdk#707) the phase claims to have closed on the inbound side.

**Fix:** run the same validator on the exact proposal union `createCommit` bundles, and prune (not refuse) the staged case, mirroring the WR-05 Add treatment:

```ts
// #prepareOutboundCommitProposals, after commitState is computed
const payloadViolation = validatePreApplyProposals(committedWithSenders, this.ciphersuite.id);
if (payloadViolation) throw new CommitLegalityError(payloadViolation);
```
plus a `validatePreApplyProposals([intent.proposal], this.ciphersuite.id)` throw in `case "proposal"`, and extend `withoutInvalidStagedAdds` (rename it) to drop staged `AppDataUpdate`s whose payload does not decode. Add a send-seam row to `account-identity-proof-seams.test.ts` so the matrix covers outbound payload validation.

## Warnings

### WR-01: the self_remove auto-committer still reads admins through `getMarmotGroupView`, and its `send()` throw escapes the public `ingest()` generator

**File:** `src/engine/group-engine.ts:2144-2163` (`#maybeAutoCommitSelfRemoves`), `:2189` (`this.send(...)`), `:1651-1659` (unguarded call from `ingest()`), `:972-975` (`case "commit"` throw)

**Issue:** CR-03 removed `getMarmotGroupView` from the admin *gate* but left it in the auto-committer:

```ts
const groupData = getMarmotGroupView(state);
const adminPubkeys = groupData?.adminPubkeys ?? [];
```

`getMarmotGroupView` (`core/client-state.ts:262-291`) returns `null` on **any** component decode failure — the exact state phase 8's own `admin-policy-fail-closed.test.ts:172` asserts (`expect(getMarmotGroupView(adminEpoch2)).toBeNull()`) — and also when profile, admin policy and routing are all absent. In that state:

- `anyLeaverIsActiveAdmin` is computed against an empty admin set, so an **admin's** `self_remove` is treated as a non-admin's and `decideAutoCommit` can elect this client to commit it (`member-departure.md` forbids that; the inbound gate at `admin-policy.ts:162-176` refuses such a commit on every peer).
- Then `this.send({ kind: "commit", ... })` reaches `case "commit"` (`:972`), which throws `MarmotGroupData not found in ClientState.`. `ingest()` calls `#maybeAutoCommitSelfRemoves()` **unguarded** at `:1651`, so the throw propagates out of the public async generator after results have already been yielded — `GroupSession.ingest`'s trailing `save()` (`group-session.ts:843`) never runs, and the rest of the batch is lost.

**Fix:** derive the admin set the same way the gate now does, and fail closed instead of publishing:

```ts
let adminPubkeys: string[];
try {
  adminPubkeys = getAdminPolicy(state.groupContext.extensions) ?? [];
} catch {
  return undefined; // cannot authorize a departure without a readable policy
}
```
and wrap the `ingest()` call site so an auto-commit failure is logged, not thrown (the client layer already treats auto-commit publish failure as retry-on-next-ingest, `marmot-group.ts:1238`).

### WR-02: the WR-01 trailing `persistSelectedDisband` is unconditional — it throws for store-less sessions and re-runs on every later ingest

**File:** `src/client/session/group-session.ts:841-843`; `:474-481` (`persistSelectedDisband`)

**Issue:** the fix appends

```ts
if (this.#engine.selectedDisbandEvidence)
  await this.persistSelectedDisband(this.#engine.selectedDisbandEvidence);
await this.save();
```

`#selectedDisbandEvidence` is set by `#applyForkResolution` for any inbound disband commit that wins selection — no store required (`admitDisbandCandidate` has no store dependency). `persistSelectedDisband` throws `"Selected disband requires a lifecycle store"` when `lifecycleStore` is undefined (`:479-481`), which `MarmotGroupOptions` makes optional. The throw now fires at the end of **every** `GroupSession.ingest` for such a session — after results were yielded, and before `save()`, so nothing is persisted and the next ingest repeats it. The engine getter is never cleared, so even in the healthy case this re-enters `persistSelectedDisband` on every ingest for the life of the group (it early-returns on `#terminalTombstone`, so it is idempotent, but the dependency on that early return is undocumented at the call site).

**Fix:** guard the call and make it non-fatal:

```ts
const evidence = this.#engine.selectedDisbandEvidence;
if (evidence && this.lifecycleStore && !this.#terminalTombstone)
  await this.persistSelectedDisband(evidence);
```
and move it above `await this.save()` inside a `try`/`catch` that logs, so a lifecycle-store failure cannot cost the batch its state save. The same guard belongs on `driveConvergence` (`:418-419`), which has the identical shape.

### WR-03: a WR-02 legal prefix can be an ancestor of the current tip, so the engine can rewind onto its own canonical path

**File:** `src/engine/group-engine.ts:2956-2976` (selection loop), `:3062-3085` (`#treePrefixCandidate`), `:3143-3150` (`lastValidTag`)

**Issue:** `buildTreeBranchSet` enumerates only childless tips, so a branch that diverges from the current tip's path *above* the tip shares nodes with it. When such a branch's last link is invalid, `lastValidTag` is a node on the **current tip's own path**, and `#treePrefixCandidate` turns that ancestor into a scored candidate. The only guard in the loop is `if (!winner || winner.id === currentTipTag) return;` — an ancestor is not the tip, so it can be selected, and `#applyForkResolution` then sets canonical state backwards to it, records the prefix chain into retained history, and resets the pool memo. The abandoned tip is still in the tree as a competing branch, so the next pass can switch back: an oscillation this client performs alone, with no peer making the same move.

Scoring makes this uncommon but not unreachable: the ancestor is always shallower, so it needs a tie on `effectiveCommitDepth` and a win on `witnessQuorumMet`. Because `#gatherTreeWitnesses` walks the whole path, the current tip normally inherits the ancestor's witnesses — unless they fall outside `appPayloadPastEpochLimit` for the deeper tip, which any policy with a small payload window and a large `maxRewindCommits` produces.

**Fix:** never admit a prefix that lies on the current tip's path:

```ts
const onCurrentPath = new Set(this.#tree.path(currentTipTag) ?? []);
const prefix =
  outcome.lastValidTag === undefined || onCurrentPath.has(outcome.lastValidTag)
    ? undefined
    : this.#treePrefixCandidate(winner, outcome.lastValidTag);
```
Add a row where the invalid branch hangs off an ancestor of the current tip and assert the tip is unchanged.

### WR-04: the envelope-free rewind still drops `selectedTerminal` and the `removed` classification for direct engine consumers

**File:** `src/engine/ingest.ts:1005-1021` vs. `:1022-1054`

**Issue:** the `!rep` branch yields only `appliedNotifications`. The two sibling branches additionally (a) classify the rewind as `removed` when the adopted tip is the `removedFromGroup` tombstone and (b) carry `resolution.selectedTerminal` on the `processed` result. Both are recovered by the client layer from engine state (`marmot-group.ts:1295-1299`, `group-session.ts:841`), but `./engine` is a documented public entrypoint and `MarmotGroupEngine.ingest` is its ingest API: a consumer that builds its own transport layer sees a rewind onto a removal or a disband as nothing but a notification stream. `RemovedIngestResult` and `ProcessedIngestResult.selectedTerminal` are the documented signals for exactly those two events.

**Fix:** either emit the terminal facts on envelope-free results (a `selectedTerminal` field on `AppliedNotificationsIngestResult`, or a dedicated result kind, as `StateInvalidatedIngestResult` already does for the envelope-free case), or document on `MarmotGroupEngine.ingest` that `selectedDisbandEvidence` and `state.groupActiveState` must be re-read after every drain. The docstring at `:1009-1013` explains the omission but no public type says it.

## Info

### IN-01 (carried forward, still open): `withCapturedProposals` docstring contradicts its inner callback

**File:** `src/engine/admin-policy.ts:249-251`
**Issue:** "No validation logic may be added inside this wrapper or inside `inner`" is now doubly false — `inner` runs `validatePreApplyProposals` for both callback kinds (`:150`, `:155`) and the fail-closed fallback closure (`group-engine.ts:3292-3296`). Deliberately unaddressed in round 2.
**Fix:** restrict the prohibition to *post-apply* (resulting-GroupContext) validation.

### IN-02 (carried forward, still open): `#settleAndDrive` auto-disband is not profile-gated

**File:** `src/client/group/marmot-group.ts:1078-1082` vs. `:1087-1098`
**Issue:** `resumePendingDisband` returns early for an unsupported profile; the equivalent `await this.disband()` in `#settleAndDrive` does not. Today it only surfaces a `rejected` DisbandResult because `send` throws.
**Fix:** route both through `resumePendingDisband()`.

### IN-03 (carried forward, still open): by-value Add proof check precedes commit authorization

**File:** `src/engine/group-engine.ts:1229-1233` (check) vs. `:1252-1262` (`decideCommitAuthorization`)
**Issue:** a non-admin passing an Add by value gets `CommitLegalityError(account-identity-proof)` rather than "Not a group admin". Message-only.
**Fix:** authorize first, or document the precedence.

### IN-04 (carried forward, still open): the WR-03 regression test does not drive the real seam

**File:** `src/engine/__tests__/known-state-fallback-legality.test.ts:65-78`
**Issue:** confirmed — the test calls `resolveCandidateParent` directly with a synthetic `known`, so it does not prove `#buildBranches` or `#treeResolution` reach the fallback with a persisted own-commit stamp. Explicitly out of scope in round 2.
**Fix:** add a row that drives it through `#treeResolution` with a real `ownCommitStampOf` stamp.

### IN-05 (new): `#createAdminVerificationCallback(state = this.state)` keeps a tip-defaulting parameter

**File:** `src/engine/group-engine.ts:3274-3276`
**Issue:** after CR-01/CR-02 every one of the six call sites passes an explicit parent. The surviving default silently reinstates exactly the defect both findings closed for any future caller that omits the argument, and no test would catch it.
**Fix:** make `state` required.

### IN-06 (new): the exports snapshot pins only the root barrel, not the newly advertised `./engine` export

**File:** `src/__tests__/exports.test.ts:16-17, 38-42`; `.changeset/account-identity-proof-v2.md:47-48`
**Issue:** the test snapshots `Object.keys(exports)` of `../index.js` only. The changeset advertises `validatePreApplyProposals` as exported from `@internet-privacy/marmot-ts/engine` (it is, via `src/engine/index.ts`'s `export * from "./admin-policy.js"`), but nothing pins that subpath, so an accidental removal or rename of a public engine export ships silently.
**Fix:** add a second inline snapshot over `import * as engine from "../engine/index.js"` (and the other declared subpaths).

---

_Reviewed: 2026-09-15T23:52:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
