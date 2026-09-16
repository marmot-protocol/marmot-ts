---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
fixed_at: 2026-09-15T19:40:00Z
review_path: .planning/phases/08-groupcontext-profile-requirement-legality-seam-extension/08-REVIEW.md
review_round: 4
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report (round 4)

**Fixed at:** 2026-09-15T19:40:00Z
**Source review:** `08-REVIEW.md` (round 4)
**Supersedes:** the round-2 fix report previously at this path

**Summary:**
- Findings in scope: 8 — CR-01, CR-02, CR-04 (blockers) and WR-01, WR-02, WR-03, WR-04, WR-07 (warnings)
- Fixed: 8
- Skipped: 0
- **3 of the 8 ship without a discriminating regression test and are flagged below for human verification** (WR-01, WR-02, WR-03)
- Out of scope, untouched: IN-01, IN-03, IN-04, IN-05, IN-06

**Verification (whole-suite, after every commit):**
- `tsc --noEmit -p tsconfig.json` exited 0.
- `vitest run`: **109 files / 1209 tests passing** (up from 105/1178; 3 new test files, 29 net new rows).
- `prettier --check` clean on all 17 changed files.
- MDK (`refs/mdk/crates/cgka-engine/src/app_components.rs`) was read directly as the source of truth for CR-01, rather than trusting the review's paraphrase.

## Fixed Issues

### CR-01: AppDataUpdate batch validation diverged from MDK

**Commit:** `b1439ef`
**Files:** `src/engine/admin-policy.ts`, `src/engine/group-engine.ts`, `src/engine/ingest.ts`, `src/engine/fork-recovery.ts`, `src/core/components/integrity.ts`, `src/engine/__tests__/pre-apply-batch-validation.test.ts` (new, 18 rows)

Ported the three missing halves of `validate_app_data_update_batch_against`: the duplicate-component-id rule (MDK's `seen` set), full Remove validation measured against the **resulting** required list (so the spec's atomic "un-require and remove in one commit" stays legal), and outright refusal of any update to `0x2` (safe_aad) or `0x8009` (leaf-only proof) — neither of which has a decoder, so the old `if (!decode) continue;` accepted both unvalidated.

The parent's required list reaches the validator via a new optional `requiredIds` argument (`requiredComponentIdsOf`), wired at the four commit seams that hold a parent state. Omitting it reproduces MDK's standalone-proposal semantics, which is what the lone-proposal seams want.

> **Residual gap (deliberate, not fixed):** MDK also *validates payload bytes* for `GROUP_BLOSSOM_IMAGE` (`0x8002`) and encrypted-media v1/v2 (`0x8008`/`0x800b`). marmot-ts has no wire codec for `0x8002` or for a v2 media id at all, so those payloads are still accepted as opaque. Writing two new codecs is feature work, not a review fix. marmot-ts remains *more permissive* than MDK for exactly those two ids.

### CR-02: the pre-apply payload gate was inbound-only

**Commit:** `f7c8099`
**Files:** `src/engine/group-engine.ts`, `src/engine/__tests__/outbound-payload-gate.test.ts` (new, 8 rows), `src/engine/__tests__/send-commit-legality.test.ts`

Hoisted onto the shared outbound paths rather than duplicated: `#prepareOutboundCommitProposals` (used by both `case "commit"` and `case "selfUpdate"`) validates the exact union `createCommit` bundles, and `case "proposal"` validates the proposal it is about to create. `withoutInvalidStagedAdds` became `withoutInadmissibleStagedProposals`, pruning any staged proposal that fails admission — pruning, not refusing, preserves WR-05's property that a stale staged proposal cannot block every local commit for the epoch.

One pre-existing row in `send-commit-legality.test.ts` staged an admin-policy proposal with placeholder bytes `[0, 1]`. That payload was incidental (the row asserts "Not a group admin"), and its two sibling rows already used `encodeAdminPolicyV1`; it now does too.

### CR-04: `requestDisband` / `enableGroupDisbanding` bypassed `send()`

**Commit:** `0b1ce2a`
**Files:** `src/engine/group-engine.ts`, `src/client/group/marmot-group.ts`, `docs/client/best-practices.md`, `src/engine/__tests__/unsupported-profile.test.ts` (+2 rows), `src/client/__tests__/unsupported-profile-groups.test.ts` (+1 row)

`#assertOutboundIntentAllowed()` (membership + profile) now runs at the top of `#sendInner` — the path every outbound intent genuinely funnels through — making `send()`'s "single choke point" comment true instead of aspirational.

One subtlety worth recording: the guard is **split**. `requestDisband` calls only the profile half (`#assertOutboundProfileSupported`), because it answers a removed-from-group state by durably failing the request (`NoLongerMember`) and returning `undefined` — a deliberate disposition that `disband-request.test.ts` asserts. A single combined guard silently converted that to a throw and broke the row; the split preserves it while still refusing before any durable side effect. `enableGroupDisbanding` takes the full guard, since it previously had neither refusal.

`#settleAndDrive` now routes through `resumePendingDisband()` instead of repeating its predicate (round 3's IN-02). The shipped `best-practices.md` claim, false as written, is corrected.

> **Behavior change for a human to confirm:** `enableGroupDisbanding()` now throws for an unsupported-profile or removed-from-group engine where it previously proceeded. At the client layer `MarmotGroup.enableDisbanding()` maps that to `{ kind: "rejected", reason: "legality" }`.

### WR-01: self_remove auto-committer — *fixed, requires human verification*

**Commit:** `56c5972`
**Files:** `src/engine/group-engine.ts`

Three defects: the admin set was read through `getMarmotGroupView` (null on *any* cosmetic component decode failure, so an admin's self_remove could be auto-committed); the pending-disband state was never checked though `send()` throws `DisbandingError` for it and `publishFailed()` restores Stable while leaving it pending; and `ingest()` called it unguarded *after* yielding results, so a throw escaped the public generator and cost `GroupSession.ingest` its trailing `save()`.

> **No regression row.** Reproducing it needs a malformed-component state plus a staged self_remove plus a failed disband publish. Please confirm by inspection.

### WR-02: unconditional trailing `persistSelectedDisband` — *fixed, requires human verification*

**Commit:** `d269628`
**Files:** `src/client/session/group-session.ts`

All three call sites route through one `#persistSelectedDisbandIfPossible` helper that returns early without a `lifecycleStore` (optional in both option types) or with a tombstone already present, and treats failure as non-fatal via `#onHistoryError`. The public `persistSelectedDisband` throw-on-missing-store contract is unchanged for direct callers.

> **No regression row.** Driving a winning disband selection through a store-less session needs a full fork-convergence fixture, and `selectedDisbandEvidence` cannot be set without one — the existing disband-convergence rows build theirs inline and are not reusable.

### WR-03: rewind onto an ancestor of the current tip — *fixed, requires human verification*

**Commit:** `c9c2e7a`
**Files:** `src/engine/group-engine.ts`

The legal prefix is now dropped when it lies on the current tip's own path (`this.#tree.path(currentTipTag)`), so selection cannot walk canonical state backwards along a path this client already holds.

> **No regression row, deliberately.** The ancestor is always shallower than the tip it would displace, so it only wins under a witness/`appWitnessScore` and policy configuration (small `appPayloadPastEpochLimit` against large `maxRewindCommits`) that needs dedicated fixturing. A row that did not reproduce that configuration would pass with or without the fix — precisely the defect WR-07 flags. I chose no test over a test that proves nothing.

### WR-04: envelope-free rewind dropped terminal facts

**Commit:** `dc03782`
**Files:** `src/engine/types.ts`, `src/engine/ingest.ts`, `src/engine/group-engine.ts`, `.changeset/account-identity-proof-v2.md`, `src/engine/__tests__/ingest-rewind-without-envelope.test.ts` (rewritten, 3 rows)

`AppliedNotificationsIngestResult` gains optional `selectedTerminal` and `removedFromGroup`, populated at both envelope-free sites. Additive, so no consumer breaks.

Because no optional field helps a rewind that yielded nothing at all, `MarmotGroupEngine.ingest` now documents that a consumer which must not *miss* these facts has to re-read `selectedDisbandEvidence` and `state.groupActiveState` after draining — which is exactly what the client layer already does, and why the gap was invisible in-tree.

Writing the test surfaced a real constraint: `ingest.ts`'s D-13 guard yields every envelope as `self-evicted` when canonical state is *already* the tombstone on entry, so a tombstone is only reachable here **by** the rewind. The mock context is now stateful and mutates state inside `resolveFork`, mirroring production's `#setState`.

### WR-07: tie-break rows passed ~half the time regardless of the fix

**Commit:** `1545608`
**Files:** `src/engine/__tests__/account-identity-proof-seams.test.ts`

Fixtures are now rebuilt (bounded at 32 attempts) until the digest ordering is the *discriminating* one, and each row asserts the concrete post-fix winner — a value the pre-fix engine never adopts. The duplicated per-row fixture preamble is gone.

**Verified by mutation, not repetition:** forcing the legal-prefix candidate to `undefined` made **4 rows fail** (these 3 plus the already-deterministic "keeps the legal prefix" row) with the other 14 still green; restoring the fix returned 18/18. That is the direct evidence the old rows could not provide.

## Out of Scope

`IN-01`, `IN-03`, `IN-04`, `IN-05`, `IN-06` were not addressed — `fix_scope` was `critical_warning`.

Note that **IN-06 is now larger** than when it was filed: this round adds `requiredComponentIdsOf` to the `./engine` subpath, and `exports.test.ts` still snapshots only the root barrel, so it remains unpinned alongside `validatePreApplyProposals`, `ForkRecovery`, and `UnsupportedGroupProfileError`.

## Process Notes

- All work ran in an isolated git worktree on temp branch `gsd-reviewfix/08-3230973`, with a recovery sentinel; cleanup fast-forwarded `master` from `8639ffe` to `1545608`, removed the worktree and temp branch, then dropped the sentinel.
- `node_modules`, `ts-mls` and `refs` were symlinked into the worktree (no submodule checkout there); all three were removed before teardown and never staged. `git diff --name-only 8639ffe..HEAD` lists only the 17 intended files.
- `pnpm` scripts try to re-install inside a worktree, so binaries were invoked directly (`npx tsc`, `npx vitest`, `npx prettier`) — the same ones `pnpm compile` / `pnpm lint` wrap.

---

_Fixed: 2026-09-15T19:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1 (round-4 review)_
