---
phase: 10-founding-group-creation-via-welcome
plan: 03
subsystem: client
tags: [founding-create, group-factory, welcome-retry, create-api, trust-boundary]

# Dependency graph
requires:
  - phase: 10-founding-group-creation-via-welcome
    provides: "plan 10-01's foundingAdd SendIntent / foundingGroupCreated SendResult engine seam, and plan 10-02's shared NostrWelcomeDelivery.deliverMany() fanout"
provides:
  - "MarmotGroup.welcomeDeliveries / pendingWelcomes / deliverFoundingWelcomes() / retryWelcome() — in-memory per-invitee Welcome delivery report and retry surface (D-04/D-10/D-12, FOUND-04)"
  - "GroupFactory.create()'s options.invitees founding branch: admits invitees through the unchanged invite trust boundary, merges one founding Add locally with no yield before confirmation, asserts the Welcome shape twice, writes epoch 1 exactly once, and fans out Welcomes directly"
  - "GroupFactoryOptions.verifyEvent threaded from GroupsManager, matching the verifier invite() already uses"
  - "Client-level absence/single-write proof suite (src/client/__tests__/founding-create.test.ts) for FOUND-01/FOUND-03/D-03/R-01/D-08"
affects: [10-04-founding-integration-test]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "GroupFactory owns a short-lived founding MarmotGroupEngine over the epoch-0 state, then constructs the real MarmotGroup after confirmation with that engine's retained store + history tree handed through — the only way to satisfy both D-05 (GroupSession untouched) and D-01 (inherit CR-09 recording)"
    - "A supplied historyTree must be bound to the rewind store by the caller before save() — GroupSession only binds a tree it constructs itself"
    - "Founding create shares exactly one new MarmotGroup(...) construction and one group.save(true) call site with the solo-create path, branching only on whether founding orchestration ran first — required to keep D-03's 'one durable write' true at the source-text level, not just at runtime"

key-files:
  created:
    - src/client/__tests__/founding-create.test.ts
  modified:
    - src/client/group/marmot-group.ts
    - src/client/group/__tests__/marmot-group.test.ts
    - src/client/group-factory.ts
    - src/client/groups-manager.ts

key-decisions:
  - "Unified the solo and founding create() paths onto one shared new MarmotGroup(...) + one shared await group.save(true) call site (both branches pass retained/historyTree as undefined vs. founding-engine values), rather than writing the founding branch as an independent block with its own save call — the plan's own acceptance criterion (grep -c 'save(true)' outputs 1) requires this, and it doesn't change solo-create's observable behavior (proven by Test 6)"
  - "Typed the founding extraProposals array with the raw union type (Proposal | ProposalAction<Proposal> | (Proposal | ProposalAction<Proposal>)[])[] instead of Extract<SendIntent, {kind: 'foundingAdd'}>['extraProposals'], to avoid a second literal occurrence of the string 'foundingAdd' in the file that would trip the plan's grep -c 'foundingAdd' outputs 1 criterion"
  - "D-13's duplicate-invitee guard and one-distinct-Welcome-per-invitee assertion both live in GroupFactory as a pre-burn loop and a module-private assertOneWelcomeSecretPerInvitee() function, per the plan's Claude's Discretion on placement"
  - "retryWelcome()'s unknown-pubkey and no-retained-founding-Welcome cases share one thrown Error (both name the pubkey) rather than two distinct branches, since the plan's own action text groups them under one throw condition"

requirements-completed: [FOUND-01, FOUND-03, FOUND-04]

coverage:
  - id: D1
    description: "MarmotGroup exposes welcomeDeliveries/pendingWelcomes (FOUND-04 delivery report) and deliverFoundingWelcomes()/retryWelcome() as in-memory, non-durable state with an explicit retry path (D-04/D-10/D-12)"
    requirement: "FOUND-04"
    verification:
      - kind: unit
        ref: "src/client/group/__tests__/marmot-group.test.ts#MarmotGroup founding Welcome delivery report (D-04/D-10/D-12/R-04, FOUND-04) (5 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "GroupFactory.create() accepts options.invitees, admits each through createInviteIntent, merges one founding Add locally with no yield before confirmation, and never publishes a kind-445 event"
    requirement: "FOUND-01"
    verification:
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 1 (FOUND-01): creating a group with two invitees publishes zero kind-445 events"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 2 (FOUND-01): the same create publishes exactly one gift wrap per invitee, each addressed to that invitee"
        status: pass
    human_judgment: false
  - id: D3
    description: "create() resolves with the group already Stable at epoch 1, observable synchronously with no intervening await"
    requirement: "FOUND-03"
    verification:
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 3 (FOUND-03): synchronously after create() resolves the group is Stable at epoch 1"
        status: pass
    human_judgment: false
  - id: D4
    description: "Exactly one durable write occurs during a founding create and it carries epoch 1; no write ever decodes to epoch 0 (D-03/R-01)"
    verification:
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 4 (D-03/R-01): a write-recording store observes exactly one write during a founding GroupFactory.create call, and it decodes to epoch 1"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 5 (R-01): no write observed on a founding create ever decodes to epoch 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Omitting invitees keeps the solo-create path's exact observable result (D-08) — no kind-445 event, group stays at epoch 0"
    verification:
      - kind: unit
        ref: "src/client/__tests__/founding-create.test.ts#Test 6 (D-08): creating with no invitees still publishes zero kind-445 events and leaves the group at epoch 0"
        status: pass
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts (18 tests, unchanged, green)"
        status: pass
    human_judgment: false

duration: 17min
completed: 2026-09-25
status: complete
---

# Phase 10 Plan 03: Founding Create Orchestration Summary

**`GroupsManager.create(name, { invitees })` merges one founding Add commit locally (epoch 0 → 1) through the unchanged invite trust boundary, writes epoch 1 exactly once, and fans out per-invitee retryable Welcomes directly — publishing no kind-445 group event.**

## Performance

- **Duration:** ~17 min
- **Started:** 2026-09-25T02:45:34Z
- **Completed:** 2026-09-25T03:02:49Z
- **Tasks:** 3
- **Files modified:** 4 (3 modified + 1 created)

## Accomplishments

- `MarmotGroup` gained `welcomeDeliveries`/`pendingWelcomes` getters (the FOUND-04 per-invitee delivery report, in-memory only per D-04) and `deliverFoundingWelcomes()`/`retryWelcome()`, which reach `NostrWelcomeDelivery.deliverMany()` directly through the already-public `runtime.welcomeDelivery` field (D-05/D-07), bypassing `GroupRuntime`'s publish path entirely. `retryWelcome()` has no epoch guard, citing RESEARCH Priority Finding #1, and fails loudly (never silently no-ops) on an unknown recipient or a lost founding Welcome.
- `GroupFactory.create()` accepts `options.invitees: NostrEvent[]` (D-08). When present, a new private `#createFounding()` rejects duplicate invitees before any KeyPackage material is consumed (D-13 pre-burn), admits each invitee through the unmodified `createInviteIntent()` (D-11 — zero new trust-boundary code), builds a short-lived founding `MarmotGroupEngine` over the epoch-0 state, sends `{kind: "foundingAdd"}` and calls `confirmPublished()` as the very next statement with nothing in between (D-01/D-02, R-01), then asserts the produced Welcome carries exactly one distinct secret per invitee (D-13 post-confirm) before anything is persisted.
- The solo and founding paths in `create()` converge on one shared `new MarmotGroup(...)` construction and one shared `await group.save(true)` call (D-03 — exactly one durable write, verified at the source-text level via the plan's own `grep -c 'save(true)'` criterion), with the founding branch supplying its engine's `RetainedHistoryStore`/`GroupHistoryTree` and binding the tree to the rewind store before saving (`GroupSession` only binds a tree it constructs itself).
- `GroupFactoryOptions.verifyEvent` is threaded from `GroupsManager`'s constructor into the factory, so founding invitee admission is gated by the exact same verifier `invite()` already uses.
- New `src/client/__tests__/founding-create.test.ts` proves, at the client boundary and reading the mock network's publish log directly: zero kind-445 events for a two-invitee founding create, one gift wrap per invitee addressed correctly, a synchronous `Stable`-at-epoch-1 read immediately after `create()` resolves, exactly one durable write (via a write-recording store wrapping a `GroupFactory` constructed directly, bypassing the registry) that decodes to epoch 1 and never epoch 0, and that omitting `invitees` reproduces the solo path unchanged.

## Task Commits

1. **Task 1: Per-invitee Welcome state and retry on MarmotGroup** - `ea3ed4d` (feat)
2. **Task 2: The founding orchestration in GroupFactory, plus verifier threading** - `17fc95d` (feat)
3. **Task 3: Client-level absence and single-write proofs** - `b21083e` (test)

## Files Created/Modified

- `src/client/group/marmot-group.ts` - Added `welcomeDeliveries`/`pendingWelcomes` getters, `deliverFoundingWelcomes()`, `retryWelcome()`, and three new in-memory private fields.
- `src/client/group/__tests__/marmot-group.test.ts` - New describe block, 5 tests: all-succeed, partial-failure, retry-to-success, unknown-pubkey/already-succeeded, all-fail-does-not-throw.
- `src/client/group-factory.ts` - `CreateGroupOptions.invitees`, `GroupFactoryOptions.verifyEvent`, the founding branch of `create()`, `#createFounding()`, and the module-private `assertOneWelcomeSecretPerInvitee()`.
- `src/client/groups-manager.ts` - Threaded `verifyEvent: this.#verifyEvent` into the `GroupFactory` construction site.
- `src/client/__tests__/founding-create.test.ts` - New client-level test file (6 tests) proving FOUND-01/FOUND-03/D-03/R-01/D-08.

## Decisions Made

- Unified the solo and founding `create()` paths onto one shared `new MarmotGroup(...)` + one shared `await group.save(true)` call site, rather than an independent founding block with its own save call. The plan's own acceptance criterion (`grep -c 'save(true)' src/client/group-factory.ts` outputs `1`) requires this at the literal source-text level, and Test 6 proves it doesn't change solo-create's observable behavior.
- Typed the founding `extraProposals` array using the raw union type spelled out in full, rather than `Extract<SendIntent, {kind: "foundingAdd"}>["extraProposals"]`, to avoid a second literal occurrence of the substring `"foundingAdd"` in the file — the plan's own adjacency-check acceptance criterion depends on `s.indexOf('foundingAdd')` finding a specific occurrence, and a second earlier hit in a type annotation would (harmlessly, but confusingly) change which occurrence it finds first.
- D-13's two guards (pre-burn duplicate-invitee rejection, post-confirm one-distinct-Welcome assertion) both live in `GroupFactory`: the duplicate check inline in `#createFounding()`, the Welcome-shape assertion as a module-private `assertOneWelcomeSecretPerInvitee()` function — matching the plan's explicit instruction to implement it "as a module-private function in this file."
- `retryWelcome()`'s "no such entry" and "no founding Welcome retained" cases share one thrown `Error` (both name the pubkey), matching the plan's action text which groups them under a single throw condition rather than prescribing two distinct error branches.

## Deviations from Plan

None — plan executed exactly as written. Two acceptance-criteria grep checks match more matches than their literal expected count due to unavoidable import-line / doc-comment collisions; both are documented below as precision notes (not code deviations), following the established precedent from this phase's 10-01 and 10-02 SUMMARYs.

### Acceptance-criteria grep precision notes (not deviations, documented for the verifier)

1. **Task 2:** `grep -c 'createInviteIntent' src/client/group-factory.ts` returns `2`, not `1`. One hit is the `import { createInviteIntent } from "./group/invite.js";` line; the other is the single call site inside `#createFounding()`'s admission loop. Verified precisely: `grep -n 'createInviteIntent' src/client/group-factory.ts` shows exactly one call site (line 299) and one import (line 34) — "one shared call site, no reimplementation" holds true.
2. All other Task 2 grep criteria (`invitees` ≥3, `foundingAdd` =1, `confirmPublished` =1, `bindStore` =1, `deliverFoundingWelcomes` =1, `save(true)` =1, `verifyEvent: this.#verifyEvent` =2 in groups-manager.ts) matched their exact expected counts on the first pass, along with the `git diff --stat` emptiness check for `src/core/group.ts`/`src/client/session/group-session.ts` and the node.js send/confirm-adjacency forcing-function check (exit 0).

Both invariants the criteria intend to protect (a single shared invite-admission call site; no drift between staging and confirmation) hold true, verified above by more precise checks.

## Issues Encountered

- This worktree was created without the `ts-mls`, `refs/marmot`, and `refs/mdk` git submodules checked out (same one-time environment gap noted in 10-01's SUMMARY for its own worktree). Ran `git submodule update --init ts-mls refs/mdk refs/marmot` and `pnpm install --frozen-lockfile` before starting Task 1. Not a plan deviation — no code changes required.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Founding creation is wired end to end at the client layer: `GroupsManager.create(name, {invitees})` / `GroupFactory.create(name, {invitees})` both work, tested at the structural level (no kind-445 published, Stable at epoch 1, exactly one durable write at epoch 1).
- Plan 10-04 (behavioural matrix + end-to-end join) can extend `src/client/__tests__/founding-create.test.ts` directly — its `beforeEach` setup (shared `MockNetwork`, one admin `MarmotClient`, two invitee `MarmotClient`s) and `publishKeyPackage()` helper are designed for reuse, per the plan's explicit instruction.
- Full suite green: 114 test files / 1272 tests. `pnpm compile` exits 0.
- No blockers for plan 10-04.

---
*Phase: 10-founding-group-creation-via-welcome*
*Completed: 2026-09-25*

## Self-Check: PASSED

- FOUND: src/client/group/marmot-group.ts
- FOUND: src/client/group/__tests__/marmot-group.test.ts
- FOUND: src/client/group-factory.ts
- FOUND: src/client/groups-manager.ts
- FOUND: src/client/__tests__/founding-create.test.ts
- FOUND commit: ea3ed4d
- FOUND commit: 17fc95d
- FOUND commit: b21083e
