---
phase: 03-commit-integrity-convergence-parity
plan: 07
subsystem: convergence
tags: [mls, ts-mls, engine, ingest, group-engine, client, convergence, vitest]

# Dependency graph
requires:
  - phase: 03-02
    provides: StateNotification discriminated union, StateNotificationLedger (record/invalidatedByRewind/pruneBelow), envelope-less StateInvalidatedIngestResult, notifications?/withdrawn fields on the IngestResult union
  - phase: 03-04
    provides: the inbound commit-legality gate + retained-history/fork-recovery seams in ingest.ts this plan's direct-branch derivation sits inside
  - phase: 03-06
    provides: MarmotGroup#clearRemovalMarker (the marker-clearing call site this plan wires), AppliedForkResolution.tipCommitMessage (the attribution field this plan's `notifications` field supersedes at the forkPool rewind site)
provides:
  - deriveStateNotifications (src/engine/state-notifications.ts) — pure before/after commit diff producing epochAdvanced/memberAdded/memberRemoved/componentChanged/selfRemoved in a fixed, deterministic order
  - groupWithdrawnNotificationsByCommit — groups a rewind's flat withdrawn notification array by producing commit digest, one stateInvalidated result per superseded commit
  - IngestContext.recordStateNotifications + AppliedForkResolution.notifications/withdrawnNotifications (src/engine/ingest.ts)
  - MarmotGroupEngine#stateNotifications ledger, wired into #applyForkResolution (the single shared rewind-apply path for both pool-replay recovery and tree-fed re-convergence) and #ingestContext's recordStateNotifications hook
  - stateInvalidated yielded BEFORE invalidated at both rewind sites (ingest.ts's forkPool branch and group-engine.ts's #reconvergeFromTree), a deterministic ordering guarantee (D-11)
  - MarmotGroup#ingest's stateInvalidated handler: clears the removal marker when withdrawn contains a selfRemoved entry (CONV-03)
  - src/engine/__tests__/state-notification-withdrawal.test.ts (8 tests)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "StateNotification derivation lives ONLY on the accepted-commit path (ingest.ts's direct in-order branch, and the forkPool/tree-fed rewind-apply path in #applyForkResolution) — never in fork-recovery.ts's candidate exploration, so a losing/rejected/skipped input can never produce a notification"
    - "#stateNotifications is a structural sibling of #delivered (DeliveredPayloadLedger): both pruned below the retained anchor at the same two record sites, both withdrawn via invalidatedByRewind inside the single shared #applyForkResolution"
    - "groupWithdrawnNotificationsByCommit centralizes the per-commit grouping so both rewind sites (ingest.ts forkPool, group-engine.ts #reconvergeFromTree) emit identically-shaped stateInvalidated results without duplicating the grouping logic"

key-files:
  created:
    - src/engine/__tests__/state-notification-withdrawal.test.ts
  modified:
    - src/engine/state-notifications.ts
    - src/engine/ingest.ts
    - src/engine/group-engine.ts
    - src/client/group/marmot-group.ts
    - .planning/phases/03-commit-integrity-convergence-parity/deferred-items.md

key-decisions:
  - "Tasks 1 and 2 landed in a single commit (7c5c5c2), not two: Task 1's direct-commit-branch notification recording calls ctx.recordStateNotifications, which only type-checks once Task 2's IngestContext hook and AppliedForkResolution fields exist, and Task 2's #applyForkResolution changes reference deriveStateNotifications from Task 1. Splitting them would require an artificial, non-compiling intermediate commit."
  - "[Rule 2 - auto-add missing critical functionality] Extended notification derivation+ledger-recording to the forkPool rewind site's own winning tip commit (group-engine.ts's #applyForkResolution), not just the direct in-order branch the plan's Task 1 read_first narrowly scoped to. Without this, a commit that becomes canonical via a rewind (rather than direct in-order application) could never have ITS OWN notifications withdrawn by a LATER rewind — a real gap against the plan's own must_haves.truths (\"every accepted commit on the selected branch produces StateNotification values\"). This replaces 03-06's hand-built single-selfRemoved-element array at the forkPool 'removed' yield with the same derived list used elsewhere."
  - "Marker-clearing (CONV-03's second half) is tested at the MarmotGroup wiring boundary — a crafted stateInvalidated result injected via a monkey-patched session.ingest — rather than via a fully organic 'removed via rewind, then un-removed via a later rewind' engine scenario. Investigation (see deferred-items.md 'From plan 03-07') found this composition is currently unreachable: ForkRecovery's candidate dedup (keyed by resulting confirmationTag) always drops a commit that would remove the OBSERVING party, because a removedFromGroup tombstone's confirmationTag is byte-identical to its parent's (verified directly against ts-mls — there is no legitimate new transcript hash for the party being removed to compute); and the direct removal branch deliberately skips retained-history/tree recording ('retained history is moot'), so tree-fed re-convergence has nothing to switch back to once a group is removed via that path. Both are pre-existing, cross-cutting engine/ts-mls interactions this plan's tasks do not touch."
  - "Kept AppliedForkResolution.tipCommitMessage (03-06) even though ingest.ts no longer reads it directly (superseded by the new .notifications field) — it stays available to any other future seam, and removing a public-ish type field wasn't asked for."

requirements-completed: [CONV-03]

coverage:
  - id: D1
    description: "Every accepted commit on the selected branch derives commit-digest-attributed StateNotification values (epochAdvanced, memberAdded, memberRemoved, componentChanged, selfRemoved), delivered on the processed/removed ingest result"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#derives epochAdvanced and memberAdded, both carrying the same commitDigest, for a commit that adds a member"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#derives a memberRemoved notification (no actor) for a commit that removes a different member"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#derives a componentChanged notification for exactly the updated component id"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#is deterministic: two calls over the same parent/resulting pair return an identical array"
        status: pass
    human_judgment: false
  - id: D2
    description: "A rewind that supersedes a commit withdraws exactly that commit's notifications, attributed to its digest, scoped away from the winning branch's own notifications, driven end-to-end by a real MarmotGroupEngine"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#withdraws exactly a superseded commit's notifications when a rewind lands on a competing branch"
        status: pass
    human_judgment: false
  - id: D3
    description: "stateInvalidated is yielded before any invalidated app-payload result at a rewind site, giving the two retraction streams a deterministic relative order"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#yields stateInvalidated before any invalidated app-payload result at a rewind site"
        status: pass
    human_judgment: false
  - id: D4
    description: "MarmotGroup#ingest clears the persisted removed-inactive marker when a stateInvalidated result's withdrawn set contains a selfRemoved entry"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#clears the persisted removed-inactive marker when ingest yields a stateInvalidated result whose withdrawn set contains selfRemoved (CONV-03)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The notification ledger stays bounded to the rollback horizon — pruned below the retained anchor at the same record sites as DeliveredPayloadLedger"
    requirement: "CONV-03"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/state-notification-withdrawal.test.ts#prunes the notification ledger below the retained anchor, so an old commit's notifications cannot be resurrected past the horizon"
        status: pass
    human_judgment: false

# Metrics
duration: 95min
completed: 2026-08-04
status: complete
---

# Phase 3 Plan 7: Close CONV-03 — State Notification Attribution and Withdrawal on Rewind Summary

**Derives commit-digest-attributed StateNotification values on every accepted commit, withdraws exactly a superseded commit's notifications on rewind (deterministically ordered ahead of app-payload invalidation), and clears the persisted removal marker when a withdrawn set contains selfRemoved — closing the phase's final requirement, CONV-03.**

## Performance

- **Duration:** ~95 min
- **Tasks:** 3 (Task 1+2 combined into one commit due to interface coupling; Task 3 separate)
- **Files modified:** 5 (1 new test file, 4 modified)

## Accomplishments

- `deriveStateNotifications` (`src/engine/state-notifications.ts`) performs a pure before/after diff between a commit's parent and resulting `ClientState`, emitting `epochAdvanced`, sorted `memberAdded`/`memberRemoved` (no `actor` — the committer isn't visible to a pure diff), sorted `componentChanged` (reading the raw `app_data_dictionary` via ts-mls's `getAppDataDictionary` so unknown component ids participate), and `selfRemoved` when the resulting state is the `removedFromGroup` tombstone and the parent's wasn't — in a fixed order so two calls over the same commit are byte-identical.
- `groupWithdrawnNotificationsByCommit` groups a rewind's flat withdrawn array by producing commit digest, so a rewind that supersedes more than one commit yields one `stateInvalidated` result per superseded commit, not one per notification.
- `src/engine/ingest.ts`'s direct in-order commit branch computes the commit's digest once and derives notifications for both its `processed` and `removed` yields, recording them into the engine's ledger via the new `IngestContext.recordStateNotifications` hook. The `removedFromGroup` yield's notifications now always include `selfRemoved` alongside `epochAdvanced`/`memberRemoved`, derived rather than hand-built.
- `MarmotGroupEngine` gained `#stateNotifications` (`StateNotificationLedger`), a structural sibling of `#delivered`. `#applyForkResolution` — the single shared rewind-apply path used by both pool-replay recovery (`#resolveFork`) and tree-fed re-convergence (`#reconvergeFromTree`) — withdraws superseded notifications via `invalidatedByRewind`, derives and ledger-records the WINNING tip commit's own notifications (closing the loop so a commit landed via a rewind can itself be superseded later), and prunes both ledgers below the new retained anchor.
- Both rewind sites (`ingest.ts`'s forkPool branch and `group-engine.ts`'s `#reconvergeFromTree`) now yield grouped `stateInvalidated` results strictly before their existing `invalidated` app-payload retraction loop — a deterministic ordering guarantee (D-11) proven directly by a test that asserts index order in the drained generator output.
- `MarmotGroup#ingest` (`src/client/group/marmot-group.ts`) gained a `stateInvalidated` handler: when `withdrawn` contains a `selfRemoved` entry, it calls the existing `#clearRemovalMarker` (03-06) — the persisted removed-inactive marker no longer stays stale once a rewind un-does the removal.
- Added `src/engine/__tests__/state-notification-withdrawal.test.ts` (8 tests): attribution for `memberAdded`/`memberRemoved`/`componentChanged`, `deriveStateNotifications` determinism, scoped withdrawal on a real rewind, `stateInvalidated`-before-`invalidated` ordering, CONV-03 marker-clearing, and ledger pruning below the retained anchor.
- Re-ran the full suite after each task; `convergence-parity.test.ts`, `commit-legality-seams.test.ts`, `send-commit-legality.test.ts`, and `self-eviction.test.ts` are untouched and still pass. Full suite: 75 files / 706 tests green (up from the 74-file/698-test baseline this plan started from).

## Task Commits

Each task was committed atomically:

1. **Tasks 1+2 (combined): Derive commit-attributed state notifications, wire the ledger, and yield stateInvalidated on rewind (D-10, D-11)** - `7c5c5c2` (feat)
2. **Task 3: Clear the removal marker on withdrawn selfRemoved and prove the withdrawal end to end** - `dc068a9` (feat)

**Plan metadata:** (this commit) - `docs(03-07): complete plan`

## Files Created/Modified

- `src/engine/state-notifications.ts` - `deriveStateNotifications` (pure commit diff) and `groupWithdrawnNotificationsByCommit` (per-digest grouping helper)
- `src/engine/ingest.ts` - Direct commit branch derives + ledger-records notifications on both `processed`/`removed` yields; `IngestContext.recordStateNotifications` hook; `AppliedForkResolution.notifications`/`withdrawnNotifications` fields; forkPool rewind site yields derived notifications and grouped `stateInvalidated` before `invalidated`
- `src/engine/group-engine.ts` - `#stateNotifications` ledger; `#applyForkResolution` withdraws + derives + records + prunes; `#reconvergeFromTree` yields grouped `stateInvalidated` before `invalidated`
- `src/client/group/marmot-group.ts` - `ingest()`'s `stateInvalidated` handler calls `#clearRemovalMarker` when `withdrawn` contains `selfRemoved`
- `src/engine/__tests__/state-notification-withdrawal.test.ts` - New: 8 tests
- `.planning/phases/03-commit-integrity-convergence-parity/deferred-items.md` - Logged the two structural gaps discovered while investigating the fully-organic marker-clear scenario (see Decisions)

## Decisions Made

See frontmatter `key-decisions` for the full list. Highlights:
- Tasks 1+2 combined into a single commit — their interfaces are mutually dependent and cannot compile independently.
- Extended notification derivation to the forkPool rewind site's winning commit too (Rule 2), not just the direct branch, so a rewind-landed commit's own notifications are recoverable by a later withdrawal.
- Marker-clearing is proven at the `MarmotGroup` wiring boundary rather than via a fully organic engine scenario, after discovering two pre-existing structural gaps (ForkRecovery's confirmationTag-based candidate dedup always drops a self-removing commit; the direct removal branch skips tree/retained recording) — logged to `deferred-items.md` as the concrete follow-up.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Extended notification derivation + ledger recording to the forkPool rewind site's own winning commit**
- **Found during:** Task 2, while designing the withdrawal test scenarios
- **Issue:** The plan's Task 1 read_first scoped notification derivation to only the direct in-order commit branch (lines ~595-663 in the plan's line numbering). A commit that becomes canonical via a REWIND (the forkPool `processed`/`removed` yield, or a tree-fed switch) never had its own notifications derived or ledger-recorded — meaning such a commit could never itself be superseded and withdrawn by a LATER rewind. This directly contradicts the plan's own `must_haves.truths` ("every accepted commit on the selected branch produces StateNotification values") and would make CONV-03's marker-clearing requirement partially unreachable for commits landed via a rewind.
- **Fix:** `#applyForkResolution` (group-engine.ts) now derives notifications for the winning chain's own tip commit and records them into `#stateNotifications`, exposed as `AppliedForkResolution.notifications`. `ingest.ts`'s forkPool site uses this instead of 03-06's hand-built single-`selfRemoved`-element array.
- **Files modified:** `src/engine/group-engine.ts`, `src/engine/ingest.ts`
- **Verification:** `pnpm compile` exits 0; full suite green; `withdraws exactly a superseded commit's notifications...` test proves the withdrawal side of this end-to-end
- **Committed in:** `7c5c5c2`

**2. [Rule 1 - Bug in test design, not production code] Digest-search loops needed to vary content, not rely on internal randomization, for AppDataUpdate-only commits**
- **Found during:** Writing the withdrawal test
- **Issue:** `createCommit` is fully deterministic for identical `(state, proposals)` inputs when the commit needs no UpdatePath (an AppDataUpdate-only proposal set doesn't touch the tree) — unlike a path-changing proposal (Remove, self-update), which ts-mls randomizes per call. A digest-search loop that only regenerates the SAME AppDataUpdate proposal never converges.
- **Fix:** Vary the component payload bytes with the attempt counter in the search loop for AppDataUpdate-based tests, documented inline.
- **Files modified:** `src/engine/__tests__/state-notification-withdrawal.test.ts` (test-only)
- **Verification:** Test passes reliably across repeated runs
- **Committed in:** `dc068a9`

**3. [Rule 4-adjacent, resolved without architectural change] Discovered `ForkRecovery`'s confirmationTag-based candidate dedup structurally drops any commit that removes the observing party**
- **Found during:** Task 3, building the CONV-03 marker-clearing test
- **Issue:** Verified directly against ts-mls (isolated `processMessage` call, no state reuse involved): a `removedFromGroup` tombstone's `confirmationTag` is byte-identical to its parent's (no legitimate new transcript hash exists for the party being removed to compute). `ForkRecovery#buildBranches`'s `explore()` dedups candidates by resulting `confirmationTag` via a `seen` set BEFORE recording any edge, so a commit that would remove the observer can never become an explorable candidate — no branch, no edge. Separately, the direct removal branch in `ingest.ts` (pre-existing, unrelated to this plan) skips `ctx.recordCommit` entirely ("retained history is moot"), so `GroupHistoryTree`/`RetainedHistoryStore` never learn the tip advanced to the tombstone, and `buildTreeBranchSet` requires the current tip to be a known tree node — so tree-fed re-convergence can never even attempt a switch once removed via the direct branch.
- **Resolution:** Did NOT attempt a fix (would require changing `ForkRecovery`'s candidate dedup key and/or the direct removal branch's tree-recording behavior — both cross-cutting changes well beyond this plan's scope and risk profile). Instead, tested marker-clearing at the `MarmotGroup` wiring boundary directly (a crafted `stateInvalidated` result), and logged the full investigation to `deferred-items.md` "From plan 03-07" as the concrete, actionable follow-up for whichever future plan next touches `fork-recovery.ts`'s dedup key or the removal branch's tree recording.
- **Files modified:** `src/engine/__tests__/state-notification-withdrawal.test.ts`; `.planning/phases/03-commit-integrity-convergence-parity/deferred-items.md`
- **Verification:** The marker-clearing test passes deterministically; full suite green
- **Committed in:** `dc068a9`

---

**Total deviations:** 3 (1 missing-critical auto-fix, 1 test-design bug fix, 1 documented structural-gap discovery with no code change)
**Impact on plan:** Deviation 1 was necessary to satisfy the plan's own stated completion bar. Deviations 2-3 are test-construction fixes/documentation; no production behavior changed beyond deviation 1. No scope creep — the two structural gaps found in deviation 3 were investigated but deliberately NOT fixed, since doing so would mean redesigning `ForkRecovery`'s candidate identity and/or the removal branch's retained-history semantics, both cross-cutting and outside this plan's scope.

## Issues Encountered

- Building the fully-organic "removed via rewind, then un-removed via a later rewind" scenario for CONV-03's marker-clearing test surfaced the two structural gaps described in Deviation 3 above. Resolved by testing the marker-clearing wiring directly rather than attempting an engine-level fix.
- `createCommit`'s determinism for AppDataUpdate-only proposals (no UpdatePath) initially broke a digest-search loop copied from `convergence-parity.test.ts`'s pattern (which uses path-changing proposals). Resolved per Deviation 2.
- Pre-existing, out-of-scope items from earlier plans remain open (see `deferred-items.md`): `pnpm lint` failing repo-wide on `refs/mdk/target/**` (missing `.prettierignore` entry) — not touched by this plan (verified via `npx prettier --check` on this plan's own touched files instead).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CONV-03 is marked `Complete` in `REQUIREMENTS.md` (checkbox list + traceability table): notification attribution, scoped withdrawal on rewind, deterministic `stateInvalidated`-before-`invalidated` ordering, marker-clearing on a withdrawn `selfRemoved`, and ledger pruning are all implemented and tested at their correct boundaries.
- This is the FINAL plan of Phase 03 (commit-integrity-convergence-parity) — all requirements owned by this phase (WIRE-03, CONV-01, CONV-02, CONV-03) are now Complete.
- Two structural gaps in the engine/ts-mls interaction (documented in `deferred-items.md` "From plan 03-07") remain open for a future plan: `ForkRecovery`'s confirmationTag-based candidate dedup cannot represent a commit that removes the observing party, and the direct removal branch's skip of tree/retained recording blocks any later tree-fed un-removal. Neither blocks this plan's own deliverables, which are proven at their correct boundaries (engine-level for derivation/withdrawal, `MarmotGroup`-level for marker-clearing).

---
*Phase: 03-commit-integrity-convergence-parity*
*Completed: 2026-08-04*
