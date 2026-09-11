---
phase: 03-commit-integrity-convergence-parity
reviewed: 2026-09-01T21:52:30Z
depth: deep
files_reviewed: 15
files_reviewed_list:
  - src/client/group/marmot-group.ts
  - src/client/group-registry.ts
  - src/client/groups-manager.ts
  - src/client/runtime/group-runtime.ts
  - src/client/session/group-effects.ts
  - src/client/session/group-session.ts
  - src/engine/group-engine.ts
  - src/engine/fork-recovery.ts
  - src/engine/retained-store.ts
  - src/__tests__/groups-manager.test.ts
  - src/__tests__/integration/removed.test.ts
  - src/client/runtime/__tests__/group-runtime.test.ts
  - src/engine/__tests__/state-notification-withdrawal.test.ts
  - src/engine/__tests__/convergence-parity.test.ts
  - src/engine/__tests__/send-commit-legality.test.ts
findings:
  critical: 3
  warning: 1
  info: 0
  total: 4
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-09-01T21:52:30Z
**Depth:** deep
**Files Reviewed:** 15
**Status:** issues_found

## Summary

Plans 03-09, 03-10, and 03-11 plus post-merge test fix `22428e0` were reviewed from their plans, summaries, commit diffs, current call chains, and focused tests. The exact-union authorization and parent-bound retained-link changes are internally coherent, but the notification/removal work still has three ship-blocking delivery gaps. The focused suites pass (6 files, 67 tests), but none covers the failing call paths below.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01 [BLOCKER]: Load-time reconvergence can consume the removal marker before registry listeners attach

**File:** `src/client/group-registry.ts:186-192` (also `src/client/group/marmot-group.ts:547-555`)

**Issue:** `GroupRegistry.load()` constructs the group and calls `group.reconverge()` before `get()` calls `track()`. `reconverge()` always ends by calling `#realizeRemovalIfNeeded()`. Therefore, whenever a loaded history tree has multiple tips and canonical state is (or reconverges to) `removedFromGroup`, the group writes the durable marker and emits `removed` before the registry installs its forwarding listener at `track()`. The later post-track realization is a no-op because the marker is already set. This is the same permanently lost public notification that 03-09 intended to close, and it affects both an already-removed persisted tip and a load-time branch switch that lands on removal. The added GroupsManager regression uses no competing history tree, so it cannot catch this path.

**Fix:** Move load-time reconvergence behind registry tracking, or split reconvergence into a state-only phase and a post-listener realization phase. A minimal ordering is: build/load group, install all registry forwarders, run `reconverge()`, then emit `loaded`. Add a real persisted multi-tip regression that observes one `GroupsManager.removed` event and the marker.

### CR-02 [BLOCKER]: Successful auto-commits record state notifications but discard them from the consumer result stream

**File:** `src/client/group/marmot-group.ts:760-775` (also `src/client/runtime/group-runtime.ts:201-234`)

**Issue:** An elected self-remove auto-commit calls `runtime.publishCommit()`. That method confirms the pending commit, derives and ledger-records notifications, but returns only the relay response; `MarmotGroup.ingest()` discards even that response and yields the original `autoCommit` result, which has no notification field. Consumers therefore never receive the locally confirmed membership/epoch/component notifications, while a later rewind can emit `stateInvalidated` withdrawals for those unseen notifications. The new notification-aware `GroupPublishResult` path is used only by `publishEffects()`, not this second local-confirmation call site.

**Fix:** Make the auto-commit path use the notification-bearing commit result (or return notifications from `publishCommit`) and attach/surface them in the yielded result through a documented consumer-facing shape. Add a successful auto-commit regression asserting exact digest attribution and a later rewind asserting that every withdrawal had first been delivered.

### CR-03 [BLOCKER]: Post-confirm save or welcome failure hides notifications after canonical state and ledger already advance

**File:** `src/client/runtime/group-runtime.ts:196-198` and `src/client/runtime/group-runtime.ts:222-234`

**Issue:** Both commit-producing result paths call `#confirmPublished()` before awaiting persistence; group-evolution commits also await welcome delivery before returning the notification-bearing result. If `#save()` or `#deliverWelcomes()` rejects, relay publication has succeeded and the engine has already advanced canonical state, recorded the retained link, and ledger-recorded notifications, but the public operation rejects and never returns those notifications. A future rewind may consequently withdraw state changes the application was never told were applied. This violates the delivery/withdrawal accounting invariant introduced by 03-09 and makes retry behavior ambiguous because retrying the already-published intent is unsafe.

**Fix:** Separate publish-confirmation results from ancillary persistence/welcome outcomes. Once confirmation mutates canonical state, deliver/return its notifications exactly once even if a later side effect fails, and report persistence/welcome failure through a distinct status/event. Alternatively, persist the pending/new state atomically before making confirmation observable, but do not reject after confirmation as though nothing applied. Add save-rejection and welcome-rejection tests that assert consumer notification delivery and retry semantics.

## Warnings

### WR-01 [WARNING]: Public removal realization is not idempotent under concurrent calls

**File:** `src/client/group/marmot-group.ts:700-718`

**Issue:** `realizeRemovalIfNeeded()` is public and documented as idempotent across concurrency, but its durable branch performs an asynchronous `getItem` followed by `setItem` without an instance-level mutex or in-flight promise. Two callers can both read an unset marker, both set it, reject the queue twice harmlessly, and emit `removed` twice. Registry `get()` deduplicates concurrent loads, but concurrent explicit realization/reconvergence or another same-instance caller is not serialized.

**Fix:** Cache an in-flight realization promise (and clear it only on failure), or serialize the check/set/emit sequence with a per-instance mutex. Add `Promise.all([group.realizeRemovalIfNeeded(), group.realizeRemovalIfNeeded()])` coverage using an async store that forces both reads to overlap.

---

_Reviewed: 2026-09-01T21:52:30Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_
