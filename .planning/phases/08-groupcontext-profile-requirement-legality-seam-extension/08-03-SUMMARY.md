---
phase: 08-groupcontext-profile-requirement-legality-seam-extension
plan: 03
subsystem: auth
tags: [mls, account-identity-proof, group-profile, storage, engine-gates, client]

# Dependency graph
requires:
  - phase: 08-groupcontext-profile-requirement-legality-seam-extension
    provides: "getGroupProfileSupport (08-01), validateCommitLegality D-01a profile check (08-01), standalone-Add admission closed on every seam (08-02)"
provides:
  - "UnsupportedGroupProfileError (src/engine/group-engine.ts, exported via ./engine): thrown by MarmotGroupEngine.send() for every outbound intent kind before the audit send_entry emit, for a group outside the current account identity proof profile"
  - "MarmotGroupEngine.profileSupport / GroupSession.profileSupport / MarmotGroup.profileSupport getters, all derived (never cached) from getGroupProfileSupport(state.groupContext.extensions)"
  - "ingestEnvelopes pre-peel D-11 gate: every envelope in an unsupported-profile group is yielded skipped with reason unsupported-profile, before any decrypt; GroupSession.ingest() mirrors this right after the terminal-tombstone short-circuit"
  - "SkippedIngestResult.reason gains 'unsupported-profile'; ingestResultDisposition maps it to stale/unsupported_required_feature"
  - "MarmotGroup.resumePendingDisband() returns early for an unsupported group (D-12: nothing published automatically)"
  - "GroupRegistry.track() classifies profileSupport per group and skips reconverge()/resumePendingDisband() for an unsupported one, while hydrateLifecycleEvidence/realizeRemovalIfNeeded/realizeDisbandIfNeeded still run (local-only); classification is non-throwing so loadAll()'s Promise.all batch is never broken by one bad record"
  - "docs/client/best-practices.md 'Legacy groups' destroy() guidance; .changeset/account-identity-proof-v2.md records every Phase 8 behavior change and export"
affects: [08-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "D-11 traffic refusal repeats the disband/self-evicted gate precedent at both engine (authoritative) and session (mirror, so refused input touches neither the wrapper nor effect ledger) layers, matching Phase 04.1-06's repeated-terminal-gate pattern"
    - "profileSupport is a derived read (never cached) at every layer -- engine computes it fresh from canonical state on each access, session/MarmotGroup delegate straight through -- so an adopted state is always reflected without an invalidation path to maintain"

key-files:
  created:
    - src/engine/__tests__/unsupported-profile.test.ts
    - src/client/__tests__/unsupported-profile-groups.test.ts
  modified:
    - src/engine/types.ts
    - src/engine/ingest-disposition.ts
    - src/engine/ingest.ts
    - src/engine/group-engine.ts
    - src/client/session/group-session.ts
    - src/client/group/marmot-group.ts
    - src/client/group-registry.ts
    - docs/client/best-practices.md
    - .changeset/account-identity-proof-v2.md

key-decisions:
  - "GroupRegistry.track() guards both group.reconverge() and group.resumePendingDisband() with the same profileSupported boolean, even though MarmotGroup.resumePendingDisband() already self-guards -- redundant but matches the plan's explicit instruction and keeps the registry's own activation logic legible without relying on a callee's internal check"
  - "Reworded the pre-existing D-14 send() comment (a Task 1 collateral edit) to drop a redundant 'send_entry' mention, since the file's own D-14 comment text already contained literal 'removedFromGroup'/'send_entry' substrings that inflate the plan's own mechanical ordering grep -- documented as a deviation below rather than left silently non-matching"

requirements-completed: []

coverage:
  - id: D1
    description: "A group whose GroupContext no longer classifies as the current account-identity-proof profile refuses every outbound send intent kind (applicationMessage, proposal, commit, selfUpdate) with UnsupportedGroupProfileError, before any audit send_entry emit or state change; a supported-profile engine is unaffected"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/unsupported-profile.test.ts (8 tests, all send-intent kinds + control case)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every inbound envelope for an unsupported-profile group, including application messages and commits, is yielded skipped with reason unsupported-profile before any peel/decrypt, with stale/unsupported_required_feature disposition, and canonical state unchanged"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/unsupported-profile.test.ts#skips an inbound application-message/commit envelope pre-peel"
        status: pass
    human_judgment: false
  - id: D3
    description: "A stored group outside the current profile (missing-requirement or mixed-profile) loads through client.groups.loadAll() without throwing, alongside a current-profile group, and exposes profileSupport with the correct proofReason"
    requirement: "GRP-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/unsupported-profile-groups.test.ts#loads a current-profile group alongside a 'neither' and a 'mixed' stored group, #reports profileSupport"
        status: pass
    human_judgment: false
  - id: D4
    description: "An unsupported-profile group stays listable and destroy()-able, refuses submitIntent/selfUpdate and ingest with no publish, and a persisted pending disband request is not resumed during load"
    verification:
      - kind: unit
        ref: "src/client/__tests__/unsupported-profile-groups.test.ts#refuses submitIntent and selfUpdate, #destroy() removes an unsupported group's stored state, #does not disband an unsupported group with a persisted pending disband request"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-09-15
status: complete
---

# Phase 8 Plan 3: GroupContext Profile Requirement & Legality-Seam Extension (Unsupported-Profile Load & Traffic Refusal) Summary

**A stored group outside the current `0x8009` profile now loads and stays listable/destroy()-able, but every outbound send throws `UnsupportedGroupProfileError` and every inbound envelope is skipped pre-peel as `unsupported-profile` -- closing the Phase 7 D-10 "load untouched" gap so an unvalidated legacy peer can no longer exchange application messages or proposals.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-09-15
- **Tasks:** 3
- **Files modified:** 11 (2 new, 9 modified)

## Accomplishments
- `UnsupportedGroupProfileError` (`src/engine/group-engine.ts`): a typed, pubkey-free refusal thrown by `send()` for every outbound intent kind (applicationMessage, proposal, commit, selfUpdate) before the audit `send_entry` emit, when the group's canonical GroupContext no longer classifies as the current profile. `MarmotGroupEngine.profileSupport` is a new derived (never cached) getter wrapping `getGroupProfileSupport`.
- `ingestEnvelopes` (`src/engine/ingest.ts`) gains a D-11 pre-peel gate mirroring the existing disband/self-evicted gates: every envelope in an unsupported-profile group -- including application messages -- is yielded `skipped`/`unsupported-profile` before any decrypt attempt. `SkippedIngestResult.reason` gained the literal, and `ingestResultDisposition` maps it to `stale`/`unsupported_required_feature`.
- `GroupSession.profileSupport` and `GroupSession.ingest()` mirror the engine gate right after the terminal-tombstone short-circuit, so refused input never touches the wrapper or effect ledgers. `MarmotGroup.profileSupport` delegates through, orthogonal to the existing `status` getter, and `resumePendingDisband()` returns early for an unsupported group (D-12: no automatic publish).
- `GroupRegistry.track()` classifies each loaded group's `profileSupport` and skips `reconverge()`/`resumePendingDisband()` for an unsupported one, while hydration/removal/disband realization still run (local-only, no publish). Classification via `getGroupProfileSupport` is non-throwing, so `loadAll()`'s `Promise.all` batch can never be broken by one legacy/mixed record.
- New `src/engine/__tests__/unsupported-profile.test.ts` (8 tests) and `src/client/__tests__/unsupported-profile-groups.test.ts` (6 tests) prove D-11/D-12 end to end: classification, all four send-intent kinds, inbound application-message and commit envelopes, `loadAll()` across current/neither/mixed groups, `submitIntent`/`selfUpdate` refusal with no publish, inbound skip with `stale` disposition, `destroy()` removing stored state, and a pending disband request left un-resumed.
- `docs/client/best-practices.md` "Legacy groups" now tells apps how to find (`group.profileSupport.kind === "unsupported"`) and `destroy()` such groups; `.changeset/account-identity-proof-v2.md` records the full D-01..D-12 legality-seam-extension behavior change set and every new export from this phase's three plans.

## Task Commits

Each task was committed atomically:

1. **Task 1: Engine-level unsupported-profile gates (outbound send, inbound ingest) and typed refusal** - `23dfd5a` (feat)
2. **Task 2: Client flag, session short-circuit, non-throwing load, and destroy path** - `4a5ee6c` (feat)
3. **Task 3: Migration docs line (D-12), changeset entry, full-suite regression** - `29aaf5c` (docs)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/engine/types.ts` - `SkippedIngestResult.reason` gains `"unsupported-profile"`
- `src/engine/ingest-disposition.ts` - maps `unsupported-profile` to `stale`/`unsupported_required_feature`
- `src/engine/ingest.ts` - D-11 pre-peel inbound gate (imports `getGroupProfileSupport`)
- `src/engine/group-engine.ts` - `UnsupportedGroupProfileError`, `profileSupport` getter, `send()` outbound gate
- `src/engine/__tests__/unsupported-profile.test.ts` (new) - 8 tests: classification, all 4 send-intent kinds, inbound app-message/commit skip, supported control
- `src/client/session/group-session.ts` - `profileSupport` getter, `ingest()` mirror gate
- `src/client/group/marmot-group.ts` - `profileSupport` getter, `resumePendingDisband()` guard
- `src/client/group-registry.ts` - `track()` activation guard (reconverge/resumePendingDisband skipped for unsupported)
- `src/client/__tests__/unsupported-profile-groups.test.ts` (new) - 6 tests: loadAll across 3 profiles, profileSupport, submitIntent/selfUpdate refusal, inbound skip, destroy(), pending-disband-not-resumed
- `docs/client/best-practices.md` - "Legacy groups" destroy() guidance + example
- `.changeset/account-identity-proof-v2.md` - Phase 8 breaking-change and Added bullets

## Decisions Made
- `GroupRegistry.track()` guards both `reconverge()` and `resumePendingDisband()` with one `profileSupported` boolean even though `MarmotGroup.resumePendingDisband()` already self-guards -- intentionally redundant, matching the plan's explicit instruction so the registry's activation sequence stays legible without relying on a callee's internal check.
- Left `GRP-02` (and this plan's own `requirements` frontmatter listing) unmarked in `REQUIREMENTS.md` -- its full text ("...rejected identically on send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence") is the seam-parity matrix plan 08-04 explicitly builds, matching the same discretion 08-01 and 08-02 already exercised for the same requirement. This plan's D-11/D-12 unsupported-profile work is a distinct, separately-verified concern.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Doc-only] Reworded a pre-existing send() comment to reduce mechanical-grep noise**
- **Found during:** Task 1
- **Issue:** The plan's acceptance criteria mechanically greps `send()` for `removedFromGroup`, `UnsupportedGroupProfileError`, `send_entry` in that exact order. The pre-existing D-14 comment (`"once canonical state is the removedFromGroup tombstone... before the audit \`send_entry\` emit"`) already contained both literal substrings, so the grep produces two extra leading tokens (`removedFromGroup send_entry`) even on the unmodified baseline (verified via `git show HEAD:src/engine/group-engine.ts`) -- the criterion as literally written was already unsatisfiable before this plan touched the file.
- **Fix:** Reworded my own new D-11 comment to drop a redundant `send_entry` mention (from 2 extra occurrences down to the baseline's 2), rather than editing the pre-existing D-14 comment, which is out of this task's file-content scope. The underlying property the criterion checks -- `removedFromGroup` check, then `UnsupportedGroupProfileError` check, then the `send_entry` audit emit, in that order -- holds correctly and is proven by the passing send-intent tests.
- **Files modified:** src/engine/group-engine.ts
- **Verification:** `pnpm vitest run src/engine` (150/150 pass); manual inspection of `send()` gate order
- **Committed in:** 23dfd5a (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (doc-only, pre-existing grep-noise limitation, not a behavior bug)
**Impact on plan:** No production-logic impact. The mechanical acceptance-criteria grep for gate ordering cannot be made to output exactly `removedFromGroup UnsupportedGroupProfileError send_entry` without editing pre-existing Phase 04.1-06 comment text outside this task's scope; the actual gate ordering property is correct and test-verified.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 08-04 (GRP-02 seam-parity matrix: `src/engine/__tests__/account-identity-proof-seams.test.ts`, `src/__tests__/helpers/engine-seam-fixtures.ts`) is unaffected by this plan's D-11/D-12 scope -- different seams (per-message admission vs. load-time classification).
- `profileSupport` is now available at every layer (`MarmotGroupEngine`, `GroupSession`, `MarmotGroup`) for any future UI/tooling that wants to surface legacy-group cleanup prompts.
- Full suite: 102 files / 1150 tests passing (was 100/1136 before this plan); `pnpm compile`, full-project `tsc --noEmit`, and `pnpm docs:build` all clean; `pnpm exec prettier --check` clean on all touched paths.

---
*Phase: 08-groupcontext-profile-requirement-legality-seam-extension*
*Completed: 2026-09-15*

## Self-Check: PASSED

All 11 created/modified files listed above verified present on disk; all 3 task commit hashes (23dfd5a, 4a5ee6c, 29aaf5c) verified in `git log --all`.
