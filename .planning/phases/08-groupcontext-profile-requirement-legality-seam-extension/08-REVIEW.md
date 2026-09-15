---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
reviewed: 2026-09-15T00:00:00Z
depth: standard
files_reviewed: 30
files_reviewed_list:
  - .changeset/account-identity-proof-v2.md
  - docs/client/best-practices.md
  - src/client/group/marmot-group.ts
  - src/client/group-registry.ts
  - src/client/group/__tests__/invite.test.ts
  - src/client/group/__tests__/marmot-group.test.ts
  - src/client/session/group-session.ts
  - src/client/__tests__/join-account-identity-proof.test.ts
  - src/client/__tests__/unsupported-profile-groups.test.ts
  - src/core/components/account-identity-proof.ts
  - src/core/components/index.ts
  - src/core/components/integrity.ts
  - src/core/components/__tests__/account-identity-proof.test.ts
  - src/core/components/__tests__/integrity.test.ts
  - src/core/components/__tests__/tree-diff.test.ts
  - src/core/components/tree-diff.ts
  - src/core/__tests__/group.test.ts
  - src/engine/admin-policy.ts
  - src/engine/fork-recovery.ts
  - src/engine/group-engine.ts
  - src/engine/ingest-disposition.ts
  - src/engine/ingest.ts
  - src/engine/__tests__/account-identity-proof-seams.test.ts
  - src/engine/__tests__/group-engine.test.ts
  - src/engine/__tests__/standalone-add-admission.test.ts
  - src/engine/__tests__/unsupported-profile.test.ts
  - src/engine/types.ts
  - src/__tests__/exports.test.ts
  - src/__tests__/helpers/account-identity-proof-fixtures.ts
  - src/__tests__/helpers/engine-seam-fixtures.ts
findings:
  critical: 1
  warning: 6
  info: 4
  total: 11
status: issues_found
---

# Phase 8: Code Review Report

**Reviewed:** 2026-09-15T00:00:00Z
**Depth:** standard
**Files Reviewed:** 30
**Status:** issues_found

## Summary

This review covers the Phase 8 diff (`092fec7..HEAD`). The phase adds four things:
- the `0x8009` profile-drift and changed-leaf proof check in `validateCommitLegality`
- pre-apply Add-proof admission in the admin callback, the send path and `#sweepResult`
- the `unsupported-profile` gates at send, ingest and session
- a new `profileSupport` getter on the engine, session and group

The core pieces are sound:
- `diffChangedLeaves` and `validateCommitAccountIdentityProofs` are pure, never throw, and correctly check both the parent and resulting profiles.
- The direct inbound commit seam (`ingest.ts`) and the send seams (`#assertStagedCommitLegal`, `#prepareOutboundCommitProposals`) now agree.

Seam parity is still incomplete, which is the defect class this phase was meant to close:
- **Pool sweep (`#sweepResult`) skips commit legality.** It was edited in this phase to add Add-proof admission, but it still never runs `validateCommitLegality` on commits. It grows illegal commits into the persisted history tree and reports them as `processed` (accepted). That edge then wins tree-fed branch selection and blocks adoption of legal branches (CR-01).
- **Replay and tree-fed seams mislabel rejections.** A commit dropped there reaches consumers as `skipped/past-epoch`, or produces no result at all. The structured `violation` added to `ParentResolution` is read only by tests, yet the changeset claims the rejection is "identical" on those seams (WR-01).
- **Some paths skip the check or break under it:**
  - own-commit stamps bypass legality on replay and tree-fed convergence (WR-03)
  - the `acceptAll` fallback skips Add admission entirely (WR-04)
  - a staged invalid Add proposal permanently blocks every local commit (WR-05)
  - direct engine `ingest()` on an unsupported group still decrypts witness envelopes, and can throw out of the generator (WR-06)

## Critical Issues

### CR-01: Pool sweep (`#sweepResult`) applies commits with no commit-legality check — illegal `0x8009` commits are persisted into the fork tree and yielded as `processed`

**File:** `src/engine/group-engine.ts:1835-1904` (commit branch at 1892-1903)

**Issue:** Every other commit seam runs `validateCommitLegality` after `processMessage` and before an edge is created:
- inbound: `ingest.ts:806`
- replay: `fork-recovery.ts:139`
- tree-fed: `group-engine.ts:2983` via `resolveCandidateParent`
- send: `group-engine.ts:1041/1124`

`#sweepResult` does not. It calls `this.#tree.recordCommit(tag, message, result.newState)` and returns `{ kind: "processed" }` as soon as the admin callback accepts. Phase 8 touched this function (it swapped `acceptAll` for the admin callback for D-09 symmetry) but left out the commit-legality step. The admin callback only checks Add KeyPackage proofs and admin authorization. So each of these passes the sweep:
- a commit that drops the `0x8009` requirement (`dropAccountIdentityProofRequirement`)
- a commit whose update-path leaf carries a forged proof
- any component-integrity, disband-legality or admin-leaf-coupling violation

Concrete path: a sibling branch's second commit is encrypted under the first sibling's exporter secret. It fails to peel against canonical and retained states (`ingest.ts:447-463`), so it is pooled as `decryptFailure`. `#sweepTree` (`group-engine.ts:1771`) then peels it against the fork node and hands it to `#sweepResult`. That function records the illegal edge into the persisted `GroupHistoryTree`, and the consumer sees disposition `accepted`. Direct ingest of the same commit yields `rejected` / `account-identity-proof`.

The damage is not only a wrong label:
- `#reconvergeFromTree` (`group-engine.ts:2840-2848`) scores tree tips *before* validating them. The illegal branch is usually deeper, so it wins `selectCanonicalBranch`. `#treeResolution` then refuses it and returns `undefined`, and the pass ends.
- There is no fallback to the runner-up. A legal competing branch that should beat the current tip is never adopted, on this pass or any later one, because the illegal edge stays in the persisted tree.
- This client ends up on a different branch from spec-conformant peers (MDK) that dropped the illegal commit.

The seam-parity tests (`account-identity-proof-seams.test.ts`) never reach this path. The "replay" rows deliver a commit that decrypts against retained state, so it goes through `forkPool`/`resolveFork`. The "tree-fed" rows inject edges with `history.recordEdge`, never through `#sweepTree`.

**Fix:** Run the same shared adapter in the sweep before the edge is recorded, using the captured proposals:
```ts
const captured = capture.take();
if (result.kind === "newState") {
  if (result.actionTaken === "reject") { /* existing */ }
  if (isCommit) {
    let violation: CommitIntegrityViolation | undefined;
    try {
      violation = validateCommitLegality({
        parentState: state,
        resultingState: result.newState,
        proposals: captured.proposals,
        committerLeafIndex: captured.committerLeafIndex,
      });
    } catch {
      return undefined; // keep pooled, mirror resolveCandidateParent's deferred
    }
    if (violation)
      return {
        kind: "rejected", result, envelope, message,
        reason: violation.reason,
        proofReason: violation.proofReason,
        leafIndex: violation.leafIndex,
      };
  }
  // ...recordCommit / updateSnapshot
}
```
Better still, route the sweep's commit branch through `resolveCandidateParent` so there is one implementation. Also make `#reconvergeFromTree` validate candidates before scoring, or retry with the next-best candidate when `#treeResolution` returns `undefined`, so an invalid edge already persisted by an older build cannot pin selection. Add a seam-matrix row that delivers the second sibling commit live, so it reaches `#sweepTree`.

## Warnings

### WR-01: Replay and tree-fed seams drop illegal commits without the `account-identity-proof` label; `ParentResolution.violation` is test-only, and the changeset overclaims

**File:** `src/engine/fork-recovery.ts:129-150, 378`; `src/engine/ingest.ts:1017-1025`; `src/engine/group-engine.ts:2995-3002`; `.changeset/account-identity-proof-v2.md:23-27`

**Issue:** `resolveCandidateParent` now computes a structured `violation`, and even re-runs `validateAddProposalAccountIdentityProofs` to produce one. No production caller reads it:
- `#buildBranches` does `if (resolution.kind !== "resolved") continue;` (fork-recovery.ts:378).
- `#treeResolution` logs only `parentResolution.kind` (group-engine.ts:2996-2999).

What consumers actually see:
- **Replay:** an illegal past-epoch commit comes out of `ingest.ts:1018-1024` as `skipped` / `past-epoch`, which `ingest-disposition.ts:43-44` maps to `stale(alreadyApplied)`.
- **Tree-fed:** no result is emitted at all.
- **Inbound:** the same commit is `rejected` / `account-identity-proof`, mapped to `stale(authorizationFailed)`.

That is a differently-labeled seam. The changeset nonetheless says such commits "are rejected identically on send …, inbound ingest …, pool replay, and tree-fed convergence". The only place labels match is a return value that exists for tests (`account-identity-proof-seams.test.ts:216-227`).

**Fix:** Either surface the violation, or correct the changeset. To surface it, propagate rejected resolutions out of `ForkRecovery.resolveFork`, e.g. `rejected: { message, violation }[]`. Then have `ingest.ts` yield `{ kind: "rejected", reason: violation.reason, proofReason, leafIndex }` for those pool entries instead of `past-epoch`, and log or audit the violation in `#treeResolution`. Otherwise, reword the changeset to "dropped (not adopted)" for replay and tree-fed, and delete the dead `violation` field.

### WR-02: Pool sweep labels an admin-policy rejection with `reason: undefined`, while direct ingest labels it `"admin-policy"`

**File:** `src/engine/group-engine.ts:1878-1890`

**Issue:** Direct ingest uses `reason: violation?.reason ?? "admin-policy"` (`ingest.ts:624, 794`). The sweep returns `reason: violation?.reason`. So a non-admin commit that the sweep rejects reaches consumers with no `reason`, while the same commit through direct ingest gets `"admin-policy"`. The audit path (`group-engine.ts:2334`) hides the gap with its own `??` fallback, but `RejectedIngestResult.reason` consumers see the difference.

**Fix:** `reason: violation?.reason ?? "admin-policy"` in `#sweepResult`. Ideally put the "callback rejected, derive label" logic in one helper shared by `ingest.ts` (two sites), `#sweepResult` and `resolveCandidateParent`.

### WR-03: Own-commit stamps skip the new `0x8009` legality check on replay and tree-fed convergence, contradicting the CR-04 and `#treeResolution` contracts

**File:** `src/engine/fork-recovery.ts:99-109, 352-373`; `src/engine/group-engine.ts:2982-2994`

**Issue:** When `known` matches the parent tag, `resolveCandidateParent` returns `resolved` immediately, before `validateCommitLegality`. The CR-04 comment (fork-recovery.ts:352-363) says reusing a recorded state "must NOT also skip the legality gate" and that proposals are "read off the wire instead". No such reconstruction exists. `#treeResolution` also passes `known` whenever `ownCommitStampOf(childTag)` is set, while its docstring (2933-2941) promises that persisted edges written by pre-upgrade builds are re-validated.

The consequence: an own commit persisted by a Phase 7 build carries a stamp but was never checked for changed-leaf proofs or profile drift. It is adopted on fork recovery and tree-fed convergence without the Phase 8 check. Inbound peers would reject the same commit.

**Fix:** Keep `known` for the state shortcut, but still run the non-replay part of the gate. `validateCommitAccountIdentityProofs({ parentState: parent, resultingState: known.state })` needs no proposals. Run it, and run the full `validateCommitLegality` when proposals can be rebuilt from a `PublicMessage` commit, before returning `resolved`. Otherwise, fix the comments so they no longer claim a check that does not exist.

### WR-04: `acceptAll` fallback in `#createAdminVerificationCallback` bypasses all pre-apply Add admission on inbound, sweep, replay and tree-fed

**File:** `src/engine/group-engine.ts:3079-3091`; affects `src/engine/ingest.ts:563`, `group-engine.ts:1856, 2987`, and `fork-recovery.ts` via `adminCallback`

**Issue:** Phase 8 moved Add-proof admission for standalone proposals *into* the admin callback (`admin-policy.ts:49-59`). `#createAdminVerificationCallback` returns `acceptAll` whenever `getMarmotGroupView(state)` is `null`. That happens when any optional group component fails to decode (`client-state.ts:262-274` swallows the error), which does not affect the `0x8009` profile classification. In that state:
- an inbound standalone Add with no proof is staged and yielded as `processed`, while send throws `AccountIdentityProofError` (`group-engine.ts:936-944`)
- an inbound commit-embedded bad Add is caught only after apply by the tree diff, labeled with a `leafIndex` that pre-apply rejections omit

This is the "check on one seam only" class again.

**Fix:** Do not tie proof admission to group-data availability. When `groupData` is null, return a callback that still enforces `validateAddProposalAccountIdentityProofs` for both `proposal` and `commit` kinds, and rejects commits for lack of admin data. Alternatively, run the Add check in `withCapturedProposals`'s caller independently of the admin policy.

### WR-05: A staged invalid Add proposal permanently blocks every local commit, including `selfUpdate` and the self_remove auto-commit

**File:** `src/engine/group-engine.ts:1193-1212`

**Issue:** `#prepareOutboundCommitProposals` validates the whole `state.unappliedProposals` set and throws `CommitLegalityError` on the first bad Add. `createCommit` always bundles every unapplied proposal by reference, and nothing prunes `unappliedProposals`. So once an invalid Add is staged, every `commit`, `selfUpdate` and `#maybeAutoCommitSelfRemoves` throws for the rest of the epoch.

A remote commit that references the proposal is also rejected by every marmot-ts peer. In an all-marmot-ts group the epoch can therefore never advance. Ways such a proposal reaches canonical state:
- persisted state from the Phase 7 build, whose inbound proposal path used `acceptAll`
- a rewind onto a tree snapshot staged before the upgrade
- the WR-04 fallback

The changeset has no recovery story for this.

**Fix:** Filter bad Add proposals out of the state passed to `createCommit` rather than refusing the commit, e.g. `{ ...state, unappliedProposals: Object.fromEntries(entries.filter(valid)) }`. Also purge them from canonical state at hydration or load, mirroring MDK's discard of invalid standalone proposals. Add a test with a pre-staged proof-less Add followed by `selfUpdate()`.

### WR-06: Direct engine `ingest()` on an unsupported-profile group still decrypts refused envelopes and can throw out of the generator

**File:** `src/engine/group-engine.ts:1550-1613, 1720-1742, 2098`

**Issue:** The D-11 gate in `ingestEnvelopes` returns early, but `#ingestWithPool` and `ingest()` continue:
- `#sweepTree()` runs over any pooled entries.
- `#reconvergeFromTree([...envelopes, ...pool])` calls `#gatherTreeWitnesses`, which peels the *refused* envelopes and runs `processMessage` on them against tree snapshots (`collectWitnessesAt`). The docs state "nothing is decrypted or applied".
- `#maybeAutoCommitSelfRemoves()` calls `this.send(...)`, which throws `UnsupportedGroupProfileError`. For a stored unsupported group whose persisted `unappliedProposals` are all self_removes with this client elected, the exception escapes the generator after the skipped results were yielded.

`GroupSession.ingest` hides this for client callers, but the engine gate is documented as "authoritative for direct engine callers" (`group-session.ts:747-749`). `MarmotGroup.#settleAndDrive` also reaches `engine.driveConvergence()` → `ingest()` without passing through the session ingest gate.

**Fix:** In `MarmotGroupEngine.ingest()`, check `this.profileSupport` up front, next to `#disbandHydrated`. Yield `skipped` / `unsupported-profile` for every envelope and return before `#ingestWithPool`, the sweep, reconvergence and auto-commit. At minimum, make `#maybeAutoCommitSelfRemoves` return `undefined` when the profile is unsupported.

## Info

### IN-01: `withCapturedProposals` docstring now contradicts the code it wraps

**File:** `src/engine/admin-policy.ts:149-162`

**Issue:** The docstring says "No validation logic may be added inside this wrapper or inside `inner`". `inner` is now `createAdminCommitPolicyCallback`, which in Phase 8 performs Add-proof validation for both callback kinds (lines 49-67). The docstring and D-08/D-09 disagree, which will mislead the next maintainer.

**Fix:** Reword it: pre-apply checks that need no resulting `GroupContext` (e.g. KeyPackage proofs) are allowed in `inner`; resulting-state checks are not.

### IN-02: The send path reports the same bad Add with two different error types

**File:** `src/engine/group-engine.ts:936-944` vs `1208-1212`

**Issue:** `send({kind:"proposal"})` throws `AccountIdentityProofError` (no `violation`), while `send({kind:"commit"})` with the same Add throws `CommitLegalityError` with `violation.reason === "account-identity-proof"`. This is documented in the changeset, but it is a label mismatch within the send seam itself, so callers need two `instanceof` branches.

**Fix:** Consider using `validateAddProposalAccountIdentityProofs` in the proposal case too, and throwing a single error type that carries the structured violation.

### IN-03: The rejection label is re-derived after the fact in four places instead of carried from the callback's decision

**File:** `src/engine/ingest.ts:608-611, 779-782`; `src/engine/group-engine.ts:1879-1882`; `src/engine/fork-recovery.ts:133-136`

**Issue:** Each site re-runs `validateAddProposalAccountIdentityProofs` on the captured proposals to guess why the callback rejected. The labels are right only as long as the callback's check order (Add proof first) matches this re-derivation. The copies have already drifted once (WR-02).

**Fix:** Have the admin callback factory record its rejection reason in a side channel, e.g. `withCapturedProposals` returning `lastRejection`, and share one `rejectedFromCallback(...)` helper.

### IN-04: Unsupported-group guards are inconsistent across the disband paths

**File:** `src/client/group/marmot-group.ts:1078-1082` vs `1087-1098`; `src/engine/group-engine.ts:852, 869-871`

**Issue:** `resumePendingDisband` skips unsupported groups, but `#settleAndDrive` calls `disband()` under the same condition with no profile guard. Separately, engine `send()` checks `#disbandRequest?.status === "pending"` (throws `DisbandingError`) before the profile gate. An unsupported group with a pending disband therefore throws `DisbandingError`, not the documented `UnsupportedGroupProfileError`.

**Fix:** Add the `profileSupport` guard in `#settleAndDrive`, and either move the profile gate ahead of the disband gate in `send()` or document the precedence.

---

_Reviewed: 2026-09-15T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
