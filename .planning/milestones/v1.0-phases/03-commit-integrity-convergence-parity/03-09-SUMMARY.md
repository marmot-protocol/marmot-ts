---
phase: 03-commit-integrity-convergence-parity
plan: 09
subsystem: convergence-notifications
tags: [mls, convergence, notifications, rewind, removal]
requires:
  - phase: 03-commit-integrity-convergence-parity
    provides: inbound and rewind-landed notification derivation and withdrawal ledger
provides:
  - Listener-first persisted removal realization through GroupsManager
  - Digest-attributed local commit and selfUpdate notification delivery
  - Rewind withdrawal accounting for locally confirmed commits
affects: [03-10, 03-11, phase-03-reverification]
tech-stack:
  added: []
  patterns: [listener-first realization, publish-confirmed notification results, digest-keyed withdrawal]
key-files:
  created: []
  modified:
    - src/client/group/marmot-group.ts
    - src/client/group-registry.ts
    - src/client/groups-manager.ts
    - src/client/runtime/group-runtime.ts
    - src/client/session/group-effects.ts
    - src/client/session/group-session.ts
    - src/engine/group-engine.ts
    - src/__tests__/groups-manager.test.ts
    - src/client/runtime/__tests__/group-runtime.test.ts
    - src/engine/__tests__/state-notification-withdrawal.test.ts
key-decisions:
  - "Persisted removal realization is explicitly invoked by GroupRegistry only after lifecycle forwarding listeners are attached."
  - "Local state notifications are exposed on GroupPublishResult rather than fabricating an inbound IngestResult."
  - "confirmPublished derives attribution from the encoded pending MLS commit and records it before a future rewind can invalidate it."
metrics:
  duration: 7min
  completed: 2026-09-01
status: complete
---

# Phase 03 Plan 09: Local Notification Delivery and Withdrawal Summary

**Listener-first tombstone realization and publish-confirmed, digest-attributed local notifications now remain observable and exactly withdrawable across restarts and fork rewinds.**

## Performance

- **Duration:** 7 minutes
- **Started:** 2026-09-01T21:20:56Z
- **Completed:** 2026-09-01T21:27:08Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Deferred persisted tombstone realization until `GroupRegistry` has installed removal forwarders, preserving exactly-once delivery for concurrent loads and across restarts.
- Derived local commit and self-update notifications from the confirmed MLS commit bytes, recorded them in the notification ledger, and exposed them through `GroupPublishResult` only after publish acknowledgment.
- Added a real fork-recovery regression proving a locally confirmed component commit is withdrawn by exact digest when a peer branch wins.
- Preserved marker clearing and deterministic state-before-payload invalidation ordering.

## Task Commits

1. **Task 1: Deliver load-time removal after public listeners attach** - `e0ba9e5`
2. **Task 2: Derive, ledger-record, and surface local commit notifications** - `6e0f5ef`
3. **Task 3: Prove rewind withdrawal of locally confirmed changes** - `a8247cd`

## Verification Evidence

| Command | Result |
| --- | --- |
| `pnpm vitest run src/__tests__/groups-manager.test.ts src/engine/__tests__/self-eviction.test.ts` | PASS — 15/15 tests |
| `pnpm vitest run src/engine/__tests__/state-notification-withdrawal.test.ts src/client/runtime/__tests__/group-runtime.test.ts src/client/session/__tests__/group-session.test.ts` | PASS — 36/36 tests |
| `pnpm vitest run src/engine/__tests__/state-notification-withdrawal.test.ts src/__tests__/groups-manager.test.ts` | PASS — 23/23 tests |
| All five named plan suites together | PASS — 52/52 tests |
| `pnpm compile` | PASS |
| `pnpm build` | PASS |
| Lockfile SHA-256 after every pnpm command | PASS — `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932` |

## Decisions Made

- Kept `MarmotGroup.fromClientState` construction side-effect free; the registry now owns the listener-first realization boundary.
- Extended `GroupPublishResult` with a notification array so local actions use their existing consumer result path without masquerading as inbound ingest.
- Used the same `commitDigest(encode(mlsMessageEncoder, commitMessage))` attribution path for local and inbound commits.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Awaited realization at every registry tracking caller**

- **Found during:** Task 1
- **Issue:** Changing `GroupRegistry.track` to listener-first asynchronous realization required its create/import adoption callers to await completion; otherwise public methods could return before the exactly-once marker and event were settled.
- **Fix:** Updated both `GroupsManager` tracking call sites to await the registry contract.
- **Files modified:** `src/client/groups-manager.ts`
- **Verification:** GroupsManager concurrent-load/restart regression and self-eviction suite pass.
- **Commit:** `e0ba9e5`

**Total deviations:** 1 auto-fixed critical wiring issue. **Impact:** No architecture change; the existing registry ownership boundary is now consistently awaited.

## Authentication Gates

None.

## Known Stubs

None.

## Issues Encountered

- The first local-rewind fixture used a peer-authored app-component update, which the admin authorization policy correctly rejected before convergence. The fixture was corrected to use a legal peer self-update while retaining the locally confirmed component change under withdrawal.
- The first task commit initially inherited already-staged future plan files; it was immediately amended before further work so only Task 1 files remain in the task commit, and the staged plans were restored unchanged.

## Next Phase Readiness

- CONV-02 is observable through the public load path.
- CONV-03 now covers inbound, rewind-landed, local commit, and self-update origins with exact digest withdrawal accounting.
- Plans 03-10 and 03-11 remain staged and untouched for their own executions.

## Self-Check: PASSED

- All modified source and test files exist.
- Task commits `e0ba9e5`, `6e0f5ef`, and `a8247cd` exist in Git history.
- All acceptance criteria and plan-level verification commands passed.
- No stubs, skipped tests, unrun verification, or unplanned threat surface remain.
- The authoritative `pnpm-lock.yaml` remained byte-for-byte unchanged.

---

_Phase: 03-commit-integrity-convergence-parity_
_Completed: 2026-09-01_
