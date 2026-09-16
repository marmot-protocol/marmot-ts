---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
reviewed: 2026-09-16T00:00:00Z
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
  warning: 5
  info: 5
  total: 13
status: issues_found
---

# Phase 8: Code Review Report (round 4)

**Reviewed:** 2026-09-16T00:00:00Z
**Depth:** standard
**Files Reviewed:** 30 (plus `refs/mdk/crates/cgka-engine/src/app_components.rs` for protocol parity, and the supporting modules the reviewed files call into: `core/client-state.ts`, `core/components/dictionary.ts`, `core/components/disband-validation.ts`, `core/convergence.ts`, `core/group-lifecycle.ts`, `engine/tree-convergence.ts`, `engine/history-tree.ts`, `client/runtime/group-runtime.ts`, `src/index.ts`, `src/engine/index.ts`)
**Status:** issues_found

## Narrative Findings (AI reviewer)

## Summary

**No round-3 fixes were applied.** The task framing said commits `3d7428b` / `7b521bc` / `b21a84a` were round-3 fixes; they are not. `git log` shows they are the **round-2** fix commits (WR-02/WR-03/WR-04 of the round-2 report, recorded in `08-REVIEW-FIX.md` as `iteration: 1`), and the round-3 report `b2290f0` was committed **after** them. `git diff --stat b2290f0 -- src/` is empty and `git status` shows no source changes. So every round-3 finding was re-verified against unchanged code.

Because there were no new fixes to regress, this round's value is (a) confirming which round-3 findings are genuine at the code level, and (b) hunting what round 3 missed. Two new defects surfaced, one of them a BLOCKER that **invalidates round-3's own reasoning** for IN-02.

### Verification of the round-3 findings

| Round-3 finding | Verdict | Evidence |
| --- | --- | --- |
| CR-01 AppDataUpdate batch validation diverges from MDK | **Still open — confirmed, and understated** | `admin-policy.ts:92-111` has no `seen` set (no duplicate-op rule) and `:100` `if (appDataUpdate.operation !== "update") continue;` skips every Remove. MDK `app_components.rs:1698-1746` does both. Decoder-table gap confirmed against MDK `validate_app_component_bytes`: MDK **errors** on any update to `0x0002` and `0x8009`, and validates `0x8002`, `0x8006`, `0x8008` **and a second encrypted-media id** — `COMPONENT_PAYLOAD_DECODERS` (`:49-62`) has no entry for `0x0002`, `0x8002`, `0x8009`, or the v2 media id, so `:102` `continue`s and accepts them unvalidated. Zero test coverage: `grep` finds no duplicate-op row and no `operation: "remove"` row for `0x800c`/`0x0002`. |
| CR-02 pre-apply payload gate is inbound-only | **Still open — confirmed** | `validatePreApplyProposals` call sites are exactly `ingest.ts:621`, `ingest.ts:795`, `group-engine.ts:1925` (sweep), `group-engine.ts:3294` (fail-closed closure), `fork-recovery.ts:293`, and `admin-policy.ts:150`/`:155` — all inbound. `#prepareOutboundCommitProposals:1215-1233` prunes/checks only **Adds**; `referenced` (`:1216-1218`) carries staged `AppDataUpdate`s through untouched. `#assertStagedCommitLegal:1393` runs `validateCommitLegality`, which has no payload-decodability check. `case "proposal":937-945` validates only Adds. `grep` confirms **no test anywhere references `validatePreApplyProposals`**. |
| WR-01 auto-committer reads admins via `getMarmotGroupView`; `send()` throw escapes `ingest()` | **Still open — confirmed, plus a second reachable throw path** | `group-engine.ts:2144-2145` still `getMarmotGroupView(state)` → `?? []`; `client-state.ts:288-290` returns `null` on any decode failure. `ingest():1651` calls `#maybeAutoCommitSelfRemoves()` unguarded. **New:** `send():853` throws `DisbandingError` for a pending disband request, which the auto-committer never checks — reachable after `publishFailed` restores `Stable` with the request still `pending`. |
| WR-02 trailing `persistSelectedDisband` unconditional | **Still open — confirmed** | `group-session.ts:841-843` unguarded; `persistSelectedDisband:479-481` throws without a `lifecycleStore`, which is optional in **both** `GroupSessionOptions:130` and `MarmotGroupOptions:211`. `driveConvergence:418-419` has the identical shape, and `:796` is a third instance. |
| WR-03 legal prefix can be an ancestor of the current tip | **Still open — confirmed structurally** | `buildTreeBranchSet` enumerates only childless tips (`tree-convergence.ts`, `if (children.length === 0)`), and picks `rootTag` as the **shallowest** LCA across competing tips — so for a second competing tip `T`, the segment `rootTag → T` shares nodes with the current tip's path up to `LCA(T, currentTip)`. `#treeResolution:3149` sets `lastValidTag = segment[index]`, which can be one of those shared nodes; the only guard is `winner.id === currentTipTag` (`:2962`). No test covers it (`grep ancestor` in `src/engine/__tests__/` returns only an unrelated ts-mls error string). |
| WR-04 envelope-free rewind drops `selectedTerminal` / `removed` | **Still open — confirmed** | `ingest.ts:1005-1021` yields only `appliedNotifications`; the sibling branches at `:1022-1054` carry the `removed` classification and `selectedTerminal`. `./engine` is a declared public subpath (`package.json` exports, `src/engine/index.ts`). |
| IN-01 `withCapturedProposals` docstring | **Still open** | `admin-policy.ts:249-251` unchanged; `inner` runs `validatePreApplyProposals` at `:150`/`:155`. |
| IN-02 `#settleAndDrive` auto-disband not profile-gated | **Superseded by CR-04 — and its stated rationale was wrong** | The gap is real (`marmot-group.ts:1078-1082` vs `:1091`), but round 3's mitigation claim ("only surfaces a `rejected` DisbandResult because `send` throws") is **false**: `engine.requestDisband()` calls `#sendInner` directly (`group-engine.ts:784`), bypassing `send()`'s profile gate entirely. Re-filed with correct severity as CR-04. |
| IN-03 by-value Add proof check precedes authorization | **Still open** | `group-engine.ts:1229-1233` before `:1252-1262`. |
| IN-04 WR-03 regression test does not drive the real seam | **Still open (out of this review's file scope)** | `known-state-fallback-legality.test.ts` is not in the reviewed file list; carried forward unverified this round. |
| IN-05 `#createAdminVerificationCallback(state = this.state)` default | **Still open** | `group-engine.ts:3274-3275` unchanged; all six call sites (`:1903`, `:2488`, `:2612`, `:2651`, `:3168`, `:3257`) pass an explicit parent. |
| IN-06 exports snapshot pins only the root barrel | **Still open — confirmed, and sharper than reported** | `exports.test.ts:40` snapshots `../index.js` only. `src/index.ts:8` re-exports **`createAdminCommitPolicyCallback`** from `engine/admin-policy.js` but **not** its new sibling `validatePreApplyProposals` — so one of that module's public functions is root-exported and pinned, the other is `./engine`-only and pinned nowhere. |

### What is newly wrong

**CR-04** — two public commit-producing methods (`requestDisband`, `enableGroupDisbanding`) call `#sendInner` directly and skip every gate `send()` owns, including the D-11 profile refusal this entire phase exists to add. The engine's own comment at `group-engine.ts:869` asserts "`send()` is the single choke point for every intent kind"; it is not.

**WR-07** — the four regression rows the round-2 WR-02 fix rewrote assert a digest-ordering property computed from random per-run key material, so on roughly half of runs they pass whether or not the fix is present.

## Critical Issues

### CR-01: AppDataUpdate batch validation diverges from MDK — a member can split TS clients from the Rust reference with one commit

**File:** `src/engine/admin-policy.ts:83-113` (`validatePreApplyProposals`), `:49-62` (decoder table); `src/core/components/integrity.ts:196-238` (rules 2 and 3)
**Reference:** `refs/mdk/crates/cgka-engine/src/app_components.rs` `validate_app_data_update_batch_against` (:1698-1746), `validate_app_component_remove_against` (:1748-1775), `validate_app_component_bytes`

**Issue:** only the *update-decodes* half of MDK's batch validator was ported. Each case below is accepted here and rejected by MDK — a deterministic partition on the one property this milestone exists to guarantee (byte-for-byte interop with the Rust reference).

- **Duplicate operations for one component id.** MDK: `if (!seen.insert(update.component_id())) return Err(...)`. `validatePreApplyProposals` iterates each op independently with no `seen` set, and `validateAppComponentIntegrity` rule 3 (`integrity.ts:225-238`) only asks whether *some* op's bytes equal the resulting value — `allowed?.some((candidate) => bytesEqual(candidate, after))` — so the last write matches and the commit is "backed". A commit with two `0x8001` updates is legal here, illegal in MDK. `collectAppDataUpdateOps` even documents "a component id may legally carry more than one `AppDataUpdate` op in a single commit" (`integrity.ts:96-97`), which is the opposite of MDK's rule.
- **Every `Remove` operation.** `:100` `if (appDataUpdate.operation !== "update") continue;` skips them outright. MDK's `validate_app_component_remove_against` rejects removal of `app_components` (`0x0001`), `safe_aad` (`0x0002`) and `group.lifecycle` (`0x800c`) **unconditionally**, plus anything in the *resulting* required set. marmot-ts protects only `requiredIds ∪ {0x0001}` via `integrity.ts:196-210`, and derives `requiredIds` from the **parent** epoch (`integrity.ts:519-520`), so MDK's "un-require and remove in the same commit is legal, but removing a still-required component is not" is evaluated against a different list. A `Remove` of `0x800c` or `0x0002` in a group that does not require them is accepted here. `classifyDisbandCommit` does not cover it either — `disband-validation.ts` `updateBytes` inspects only `operation === "update"`.
- **Component ids the decoder table omits.** Verified against MDK `validate_app_component_bytes`: MDK returns `Err` for **any** update to `SAFE_AAD_COMPONENT_ID` (`0x0002`) and `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` (`0x8009`), and validates `GROUP_BLOSSOM_IMAGE_COMPONENT_ID` (`0x8002`) plus **two** encrypted-media ids (`GROUP_ENCRYPTED_MEDIA_V1/V2`). `COMPONENT_PAYLOAD_DECODERS` has entries for neither `0x0002`, `0x8002`, `0x8009`, nor a v2 media id, so `:102` `if (!decode) continue;` accepts those payloads unvalidated.

An adversarial member needs no special privilege for the duplicate-op variant: any commit it is otherwise authorized to send carries it. The repo ships an adversarial forker example that exercises exactly this shape.

**Fix:** port the rest of the batch validator and run it from the same call sites. Note the `resultingRequiredIds` must be decoded from the batch's **own** `0x0001` update when present, exactly as MDK does in its first loop:

```ts
// src/engine/admin-policy.ts
const UNREMOVABLE_COMPONENT_IDS = new Set<number>([
  APP_COMPONENTS_COMPONENT_ID,
  SAFE_AAD_COMPONENT_ID,
  GROUP_LIFECYCLE_COMPONENT_ID,
]);

// inside validatePreApplyProposals, before the per-op decode loop:
const seen = new Set<number>();
let resultingRequired = parentRequiredIds; // caller-supplied
for (const { appDataUpdate } of appDataUpdatesOf(proposals)) {
  if (seen.has(appDataUpdate.componentId))
    return {
      reason: "component-integrity",
      detail: `multiple AppDataUpdate operations for component 0x${appDataUpdate.componentId.toString(16)}`,
    };
  seen.add(appDataUpdate.componentId);
  if (appDataUpdate.componentId === APP_COMPONENTS_COMPONENT_ID) {
    if (appDataUpdate.operation !== "update")
      return { reason: "component-integrity", detail: "app_components cannot be removed" };
    resultingRequired = decodeComponentsList(appDataUpdate.update);
  }
}
for (const { appDataUpdate } of appDataUpdatesOf(proposals)) {
  if (appDataUpdate.operation !== "remove") continue;
  if (UNREMOVABLE_COMPONENT_IDS.has(appDataUpdate.componentId) ||
      resultingRequired.includes(appDataUpdate.componentId))
    return { reason: "component-integrity", detail: "component cannot be removed" };
}
```

Add explicit `return` violations (not `continue`) for `update`s to `SAFE_AAD_COMPONENT_ID` and `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` in the decoder switch, and add `0x8002` + the v2 media codec. Add MDK-vector rows for: two ops on one id; `Remove` of `0x800c`; `Remove` of `0x0002`; `update` of `0x0002`. Also correct the now-wrong `collectAppDataUpdateOps` docstring.

### CR-02: the pre-apply payload gate is inbound-only — the send path publishes and locally applies commits its own ingest rejects

**File:** `src/engine/group-engine.ts:1187-1278` (`#prepareOutboundCommitProposals`), `:1387-1400` (`#assertStagedCommitLegal`), `:932-969` (`case "proposal"`); `src/engine/admin-policy.ts:83-113`

**Issue:** `validatePreApplyProposals` runs on five inbound seams and **no** outbound seam (call sites enumerated in the verification table above).

- `case "proposal"` (`:937-945`) validates only an Add's `0x8009` proof; an `AppDataUpdate` proposal whose payload does not decode is created, wrapped and published.
- `#prepareOutboundCommitProposals` prunes staged invalid **Adds** (`:1215` `withoutInvalidStagedAdds`) and checks by-value **Adds** (`:1229-1233`), but never inspects `AppDataUpdate` payloads — neither the by-reference ones it bundles via `referenced` (`:1216-1218`) nor the by-value ones the caller supplied.
- `#assertStagedCommitLegal` runs `validateCommitLegality`, whose rule 3 only asks whether the change is *backed* by an op, never whether the bytes decode.

Consequences, in increasing order of reachability:

1. A caller-supplied payload (`send({ kind: "proposal" })` and `extraProposals` are public, documented extension points) produces a commit every conformant peer rejects with `component-integrity`. The sender applies it via `confirmPublished`, recording it into retained history and the fork tree — permanent divergence with no error surfaced.
2. It is reachable without a misbehaving app: `withoutInvalidStagedAdds` exists precisely because a pre-upgrade snapshot or a rewind can leave an inadmissible proposal staged (`:1209-1214`). An `AppDataUpdate` in that position is **not** pruned, so `createCommit` bundles it by reference into the next local commit — including a `selfUpdate` or the `self_remove` auto-commit — and every peer refuses all of them.

This is the same "a guard that exists on one seam only is a documented bug" class (mdk#707) the phase claims to have closed inbound. `grep` confirms no test exercises `validatePreApplyProposals` at all.

**Fix:** run the same validator on the exact proposal union `createCommit` bundles, and prune (not refuse) the staged case, mirroring the WR-05 Add treatment:

```ts
// #prepareOutboundCommitProposals, after committedWithSenders is assembled
const payloadViolation = validatePreApplyProposals(
  committedWithSenders,
  this.ciphersuite.id,
);
if (payloadViolation) throw new CommitLegalityError(payloadViolation);
```

plus a `validatePreApplyProposals([intent.proposal], this.ciphersuite.id)` throw in `case "proposal"`, and extend `withoutInvalidStagedAdds` (rename it — it no longer only handles Adds) to drop staged `AppDataUpdate`s whose payload does not decode. Add a send-seam row to `account-identity-proof-seams.test.ts` so the matrix covers outbound payload validation.

### CR-04: `requestDisband` and `enableGroupDisbanding` bypass `send()` — every gate it owns, including the phase's own D-11 profile refusal, is skipped

**File:** `src/engine/group-engine.ts:784` and `:843` (both call `#sendInner` directly), `:851-899` (`send()`, which holds the gates), `:869` (the comment this contradicts); `src/client/group/marmot-group.ts:989-1022` (`disband()`), `:956-986` (`enableDisbanding()`), `:1078-1082` (`#settleAndDrive`)

**Issue:** `send()` is where phase 8 put the D-11 refusal:

```ts
// group-engine.ts:866-872
// D-11: every outbound intent kind is refused ... `send()` is the single
// choke point for every intent kind; no per-case checks are added in `#sendInner`.
const profileSupport = this.profileSupport;
if (profileSupport.kind === "unsupported")
  throw new UnsupportedGroupProfileError(profileSupport.proofReason);
```

Two public commit-producing methods never reach it. `requestDisband()` ends at `:784` with `await this.#sendInner({ kind: "commit", ... })`, and `enableGroupDisbanding()` at `:843` with `return this.#sendInner({ kind: "commit", ... })`. What each therefore skips:

| Gate (in `send()`) | `requestDisband` | `enableGroupDisbanding` |
| --- | --- | --- |
| D-11 `UnsupportedGroupProfileError` (`:870-872`) | **skipped** | **skipped** |
| D-14 `removedFromGroup` refusal (`:860-864`) | re-implemented locally at `:715` | **skipped** |
| `DisbandingError` for a pending request (`:853`) | n/a | **skipped** |
| `send_entry` / `send_outcome` / `send_error` audit (`:874-898`) | **skipped** | **skipped** |

Reachability is entirely ordinary API use — neither method is internal:

- `MarmotGroup.disband()` (`marmot-group.ts:989`) guards only `#assertNotDisbanded()`, then calls `session.requestDisband()`. On a legacy/mixed group it builds, wraps and publishes a disband commit — the exact traffic D-11 says must be refused.
- `MarmotGroup.enableDisbanding()` (`:956`) has no profile guard either, and additionally no removed-from-group guard.
- `#settleAndDrive` (`:1078-1082`) calls `this.disband()` whenever a pending request exists, with no profile check — this is round-3's IN-02, but its severity was misjudged because round 3 assumed `send()` would throw. It will not.

`resumePendingDisband()` (`:1087-1098`) *is* profile-gated, and its comment states the assumption that makes the rest wrong: "`disband()` would call `session`/`engine.send`, which throws `UnsupportedGroupProfileError`." It does not call `send`.

This also makes a shipped documentation claim false — `docs/client/best-practices.md` tells users "Every send on such a group throws `UnsupportedGroupProfileError`" and "Nothing is deleted or published automatically".

Test coverage confirms the gap: `unsupported-profile-groups.test.ts:249` covers only the **load** path (`resumePendingDisband`, which is guarded) and asserts `mockNetwork.events.length === 0`. No row calls `group.disband()` or `group.enableDisbanding()` on an unsupported group, and `engine/__tests__/unsupported-profile.test.ts` covers only the four `send()` intent kinds.

**Fix:** move the gates into the single path both seams share rather than duplicating them. Either route both through `send()`, or hoist the checks into `#sendInner`'s `case "commit"`:

```ts
// group-engine.ts — at the top of both requestDisband() and enableGroupDisbanding(),
// after `await this.#disbandHydrated;`
const profileSupport = this.profileSupport;
if (profileSupport.kind === "unsupported")
  throw new UnsupportedGroupProfileError(profileSupport.proofReason);
```

and add to `enableGroupDisbanding` the `removedFromGroup` refusal it currently lacks. Preferably delete the local re-implementation at `:715` in favour of one shared private guard, so a future gate cannot be added to `send()` alone again. Gate `#settleAndDrive`'s `await this.disband()` on `profileSupport.kind === "supported"` (or route it through `resumePendingDisband()`). Add rows asserting `disband()` and `enableDisbanding()` reject with `UnsupportedGroupProfileError` and publish nothing.

## Warnings

### WR-01: the self_remove auto-committer reads admins through `getMarmotGroupView`, and its `send()` throws escape the public `ingest()` generator

**File:** `src/engine/group-engine.ts:2144-2163` (`#maybeAutoCommitSelfRemoves`), `:2189` (`this.send(...)`), `:1651-1659` (unguarded call from `ingest()`), `:972-975` (`case "commit"` throw), `:853` (`DisbandingError`)

**Issue:** the round-2 CR-03 fix removed `getMarmotGroupView` from the admin *gate* but left it in the auto-committer:

```ts
const groupData = getMarmotGroupView(state);
const adminPubkeys = groupData?.adminPubkeys ?? [];
```

`getMarmotGroupView` (`core/client-state.ts:262-291`) returns `null` on **any** component decode failure — the exact state `admin-policy-fail-closed.test.ts:172` asserts — and also when profile, admin policy and routing are all absent (`:275`). In that state `anyLeaverIsActiveAdmin` is computed against an empty admin set, so an **admin's** `self_remove` is treated as a non-admin's and `decideAutoCommit` can elect this client to commit it, which `member-departure.md` forbids and the inbound gate at `admin-policy.ts:162-176` refuses on every peer.

`ingest()` then calls `#maybeAutoCommitSelfRemoves()` **unguarded** at `:1651`, after results have already been yielded, so any throw propagates out of the public async generator — `GroupSession.ingest`'s trailing `save()` (`group-session.ts:843`) never runs and the rest of the batch is lost. Two reachable throws:

1. `case "commit"` (`:972-975`) throws `MarmotGroupData not found in ClientState.` for exactly the `null`-view state above.
2. **Newly identified:** `send()` (`:853`) throws `DisbandingError` whenever `#disbandRequest?.status === "pending"`. The auto-committer checks `mayPrepareLocalCommit` and `profileSupport` but never the disband request, and `publishFailed()` (`:1519-1537`) restores `Stable` while leaving the request `pending` — so a failed disband publish followed by any inbound `self_remove` throws out of `ingest()`.

**Fix:** derive the admin set the way the gate now does, and make the call site non-fatal:

```ts
let adminPubkeys: string[];
try {
  adminPubkeys = getAdminPolicy(state.groupContext.extensions) ?? [];
} catch {
  return undefined; // cannot authorize a departure without a readable policy
}
```

Add `if (this.#disbandRequest?.status === "pending") return undefined;` alongside the existing `profileSupport` early-return, and wrap `:1651` so an auto-commit failure is logged rather than thrown — the client layer already treats auto-commit publish failure as retry-on-next-ingest (`marmot-group.ts:1238-1240`).

### WR-02: the trailing `persistSelectedDisband` is unconditional — it throws for store-less sessions and costs the batch its state save

**File:** `src/client/session/group-session.ts:841-843`; `:474-481` (`persistSelectedDisband`); `:418-419` and `:795-796` (same shape)

**Issue:** the round-2 WR-01 fix appends

```ts
if (this.#engine.selectedDisbandEvidence)
  await this.persistSelectedDisband(this.#engine.selectedDisbandEvidence);
await this.save();
```

`#selectedDisbandEvidence` is set by `#applyForkResolution` (`group-engine.ts:2793-2794`) for any inbound disband commit that wins selection — no store required, since `admitDisbandCandidate` has none. But `persistSelectedDisband` throws `"Selected disband requires a lifecycle store"` (`:479-481`) when `lifecycleStore` is undefined, and it is optional in **both** `GroupSessionOptions` (`:130`) and `MarmotGroupOptions` (`:211`); `GroupSession` derives it as `options.lifecycleStore ?? options.ingestStateStore` (`:249`), both optional. The throw fires at the end of **every** `GroupSession.ingest` for such a session — after results were yielded and **before** `save()` — so nothing is persisted and the next ingest repeats it.

The engine getter is never cleared, so even in the healthy case this re-enters `persistSelectedDisband` on every subsequent ingest for the life of the group. It is idempotent only because of the `#terminalTombstone` early return at `:478`, a dependency that is undocumented at the call site. `driveConvergence` (`:418-419`) and the per-result call at `:795-796` have the identical unguarded shape.

**Fix:** guard the call and make it non-fatal, and order it before the state save:

```ts
const evidence = this.#engine.selectedDisbandEvidence;
if (evidence && this.lifecycleStore && !this.#terminalTombstone) {
  try {
    await this.persistSelectedDisband(evidence);
  } catch (error) {
    this.#onHistoryError?.(error as Error);
  }
}
await this.save();
```

Apply the same guard at `:418-419` and `:795-796`. Add a row that ingests a winning disband commit on a session constructed without `lifecycleStore` and asserts the batch still saves.

### WR-03: a legal prefix can be an ancestor of the current tip, so the engine can rewind onto its own canonical path

**File:** `src/engine/group-engine.ts:2956-2976` (selection loop), `:3062-3085` (`#treePrefixCandidate`), `:3143-3150` (`lastValidTag`); `src/engine/tree-convergence.ts` (`buildTreeBranchSet`)

**Issue:** `buildTreeBranchSet` enumerates only childless tips (`if (children.length === 0)`), and selects `rootTag` as the LCA at the **minimum** fork epoch across all eligible competing tips. With two or more competing tips, a tip `T` whose own `LCA(T, currentTip)` is deeper than `rootTag` has a `rootTag → T` segment that passes through nodes on the **current tip's own path**. When `T`'s last link is invalid, `#treeResolution` returns `lastValidTag = segment[index]` (`:3149`) — potentially one of those shared nodes — and `#treePrefixCandidate` turns that ancestor into a scored candidate with `id: tag`.

The only guard in the loop is `if (!winner || winner.id === currentTipTag) return;` (`:2962`). An ancestor is not the tip, so it can be selected; `#applyForkResolution` then `#setState`s canonical state **backwards** to it (`:2778`), records the prefix chain into retained history, and resets the pool memo. The abandoned tip remains in the tree as a competing branch — a rewind this client performs alone, with no peer making the same move.

Scoring makes this uncommon, not unreachable: the ancestor is always shallower, so it needs a tie on `effectiveCommitDepth` and a win on `witnessQuorumMet` / `appWitnessScore`. Because `#gatherTreeWitnesses` walks the whole path, the deeper tip normally inherits the ancestor's witnesses — unless they fall outside `appPayloadPastEpochLimit` for the deeper tip, which `isWitnessEligible` (`core/convergence.ts:124-138`) enforces and which any policy pairing a small payload window with a large `maxRewindCommits` produces.

**Fix:** never admit a prefix that lies on the current tip's path:

```ts
const onCurrentPath = new Set(this.#tree.path(currentTipTag) ?? []);
const prefix =
  outcome.lastValidTag === undefined ||
  onCurrentPath.has(outcome.lastValidTag)
    ? undefined
    : this.#treePrefixCandidate(winner, outcome.lastValidTag);
```

Add a row with **two** competing tips where the invalid branch's legal prefix is an ancestor of the current tip, and assert the tip is unchanged.

### WR-04: the envelope-free rewind drops `selectedTerminal` and the `removed` classification for direct engine consumers

**File:** `src/engine/ingest.ts:1005-1021` vs. `:1022-1054`

**Issue:** the `!rep` branch yields only `appliedNotifications`. The two sibling branches additionally (a) classify the rewind as `removed` when the adopted tip is the `removedFromGroup` tombstone (`:1022-1044`) and (b) carry `resolution.selectedTerminal` on the `processed` result (`:1052`). Both are recovered by the client layer from engine state (`marmot-group.ts:1295-1299`, `group-session.ts:841-842`), but `./engine` is a declared public subpath and `MarmotGroupEngine.ingest` is its ingest API: a consumer building its own transport sees a rewind onto a removal or a disband as nothing but a notification stream. `RemovedIngestResult` and `ProcessedIngestResult.selectedTerminal` are the documented signals for exactly those two events.

**Fix:** either emit the terminal facts on envelope-free results — a `selectedTerminal` field on `AppliedNotificationsIngestResult`, or a dedicated result kind as `StateInvalidatedIngestResult` already is for the envelope-free case — or document on `MarmotGroupEngine.ingest` that `selectedDisbandEvidence` and `state.groupActiveState` must be re-read after every drain. The inline comment at `:1005-1013` explains the omission, but no public type in `types.ts` says it.

### WR-07: the rewritten WR-02 tie-break rows pass about half the time regardless of the fix

**File:** `src/engine/__tests__/account-identity-proof-seams.test.ts:79-95` (`lowerTipDigestTag`), `:307-316`, `:526-540`, `:803-812`; and the `send-commit-legality.test.ts` tree-fed row

**Issue:** the round-2 WR-02 fix rewrote four existing rows that previously asserted the engine stays on its own tip. They now assert:

```ts
expect(bytesToHex(engine.state.confirmationTag)).toBe(
  lowerTipDigestTag(engine, ownTag, sib1Tag),
);
```

`lowerTipDigestTag` recomputes the winner by reading the same tree edges the implementation scores and sorting by digest. The fixture's commit digests derive from freshly generated key material, so which of `ownTag` / `sib1Tag` is "lower" varies per run. On every run where `ownTag` happens to sort lower, the expected value equals the **pre-fix** behaviour (engine stays on its own tip), so the assertion passes whether or not `#treePrefixCandidate` is wired up at all. The row detects a WR-02 regression only on the ~50% of runs where `sib1Tag` sorts lower. The fix report's own note — "passed 5 of 5 repeated runs" — is evidence the authors observed the run-dependence and validated it statistically rather than removing it.

The `not.toBe(sib2State)` assertion on the preceding line is genuinely load-bearing and should stay; it is the digest-ordering one that is weak.

**Fix:** make the fixture's ordering deterministic instead of asserting a property over random input — either seed/choose key material so `sib1Tag` deterministically sorts lower, or assert the structural fact directly rather than the tie-break outcome:

```ts
// the legal prefix must be a scored candidate at all — independent of who wins the tiebreak
expect(engine.history.node(sib1Tag)?.edge).toBeDefined();
expect([ownTag, sib1Tag]).toContain(
  bytesToHex(engine.state.confirmationTag),
);
// and, deterministically, the illegal link is never adopted
expect(bytesToHex(engine.state.confirmationTag)).not.toBe(
  bytesToHex(sib2State!.confirmationTag),
);
```

Better still, add one row with a hand-pinned digest ordering that fails deterministically if the prefix candidate is dropped.

## Info

### IN-01 (carried forward, still open): `withCapturedProposals` docstring contradicts its inner callback

**File:** `src/engine/admin-policy.ts:249-251`
**Issue:** "No validation logic may be added inside this wrapper or inside `inner`" is doubly false — `inner` runs `validatePreApplyProposals` for both callback kinds (`:150`, `:155`) and inside the fail-closed fallback closure (`group-engine.ts:3292-3296`). Deliberately unaddressed in round 2.
**Fix:** restrict the prohibition to *post-apply* (resulting-`GroupContext`) validation, which is the actual Pitfall-1 hazard.

### IN-03 (carried forward, still open): by-value Add proof check precedes commit authorization

**File:** `src/engine/group-engine.ts:1229-1233` (check) vs. `:1252-1262` (`decideCommitAuthorization`)
**Issue:** a non-admin passing an Add by value gets `CommitLegalityError(account-identity-proof)` rather than "Not a group admin". Message-only; no protocol effect.
**Fix:** authorize first, or document the precedence.

### IN-04 (carried forward, unverified this round): the WR-03 regression test does not drive the real seam

**File:** `src/engine/__tests__/known-state-fallback-legality.test.ts:65-78`
**Issue:** round 3 confirmed the test calls `resolveCandidateParent` directly with a synthetic `known`, so it does not prove `#buildBranches` or `#treeResolution` reach the fallback with a persisted own-commit stamp. This file is **outside** the current review's file list, so it was not re-verified this round.
**Fix:** add a row that drives it through `#treeResolution` with a real `ownCommitStampOf` stamp.

### IN-05 (carried forward, still open): `#createAdminVerificationCallback(state = this.state)` keeps a tip-defaulting parameter

**File:** `src/engine/group-engine.ts:3274-3276`
**Issue:** after the round-2 CR-01/CR-02 fixes, all six call sites (`:1903`, `:2488`, `:2612`, `:2651`, `:3168`, `:3257`) pass an explicit parent. The surviving default silently reinstates exactly the defect both findings closed, for any future caller that omits the argument, and no test would catch it.
**Fix:** make `state` required.

### IN-06 (carried forward, still open — and sharper than reported): public engine exports are pinned inconsistently

**File:** `src/__tests__/exports.test.ts:17, 40`; `src/index.ts:8`; `.changeset/account-identity-proof-v2.md:47-48`
**Issue:** the test snapshots `Object.keys(exports)` of `../index.js` only. `src/index.ts:8` re-exports `createAdminCommitPolicyCallback` from `engine/admin-policy.js` — so it appears in the snapshot at `exports.test.ts:153` — but its new sibling `validatePreApplyProposals` is not re-exported at root and is reachable only via `./engine` (through `src/engine/index.ts`'s `export * from "./admin-policy.js"`), where nothing pins it. The changeset advertises it as public API. `ForkRecovery` and `UnsupportedGroupProfileError`, also advertised in the changeset, are likewise unpinned.
**Fix:** add a second inline snapshot over `import * as engine from "../engine/index.js"` (and the other declared subpaths: `./client`, `./core`, `./utils`, `./audit`, `./extra`), so an accidental removal or rename of any advertised subpath export fails the suite.

---

_Reviewed: 2026-09-16T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

_ID note: new findings use the next free numbers across the whole phase (`CR-04`, `WR-07`) so they can never be confused with a closed finding from rounds 1-2 that reused `CR-03` / `WR-05` / `WR-06`._
