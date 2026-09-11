---
phase: 02-inbound-trust-wire-boundary
plan: 04
subsystem: security
tags:
  [nostr, trust-boundary, wire-boundary, tag-cardinality, dedup, mls-welcome]

# Dependency graph
requires:
  - phase: 02-inbound-trust-wire-boundary
    provides: safeVerifyEvent, getSingletonTagValue/getListTag (tag-cardinality.ts), the 445/1059/30443 trust-boundary gates built in plans 02-01..02-03
provides:
  - 1059 `p`-tag singleton cardinality gate in InviteManager.ingestEvent (WIRE-02)
  - dedup-after-verify reordering in GroupsManager#connectGroup drain, closing the 445 same-id-forgery censorship path (SEC-01/WR-01)
  - createWelcomeRumor duplicate-relay-URL rejection, matching getWelcome's own consumer-side cardinality rule (WIRE-02 self-consistency/WR-02)
affects:
  [
    phase-03-convergence,
    phase-04-feature-parity,
    any future audit of the inbound trust boundary,
  ]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Object-identity dedup set (rejectedEvents) alongside an id-based trusted-only dedup set (seen) — prevents duplicate rejection emits for relay-replay of the exact same malformed event object, without letting an untrusted id poison the trusted dedup slot"

key-files:
  created: []
  modified:
    - src/client/invite-manager.ts
    - src/client/__tests__/invite-manager.test.ts
    - src/client/groups-manager.ts
    - src/__tests__/groups-manager.test.ts
    - src/core/welcome-event.ts
    - src/core/__tests__/welcome.test.ts

key-decisions:
  - "Introduced a second, object-identity-keyed rejectedEvents Set in #connectGroup's drain (not specified verbatim in the plan) to keep the existing single-rejection tests green while still letting a distinct, validly-signed same-id event pass — the trusted-only `seen` set alone would have caused duplicate rejected emits under MockNetwork's backfill+subscribe replay of the same malformed event object."

requirements-completed: [SEC-01, WIRE-01, WIRE-02]

coverage:
  - id: D1
    description: "InviteManager.ingestEvent rejects a 1059 gift wrap whose p tag is repeated, absent, or empty-valued with reason tag-cardinality, after the signature gate and before storage; a single non-empty p tag still ingests"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/invite-manager.test.ts#trust boundary (WIRE-02) — 1059 `p` tag cardinality"
        status: pass
    human_judgment: false
  - id: D2
    description: "A corrupted-signature same-id 445 forgery arriving first does not censor the genuine, validly-signed event arriving later; the genuine event still reaches group.ingest(), and re-delivery of the verified event stays deduped"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts#does not let a corrupted same-id forgery censor the genuine event that arrives later (WR-01)"
        status: pass
    human_judgment: false
  - id: D3
    description: "createWelcomeRumor rejects duplicate relay URLs at produce time; a distinct-relay rumor round-trips through getWelcome/getWelcomeGroupRelays unchanged"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/core/__tests__/welcome.test.ts#createWelcomeRumor"
        status: pass
    human_judgment: false

# Metrics
duration: 12min
completed: 2026-07-22
status: complete
---

# Phase 02 Plan 04: Inbound Trust/Wire-Boundary Gap Closure Summary

**Closed the three confirmed 02-VERIFICATION.md gaps — 1059 `p`-tag cardinality enforcement, 445 dedup-after-verify reordering, and createWelcomeRumor/getWelcome relay-cardinality parity — each with a failing-then-passing test.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-22T11:22:00Z
- **Completed:** 2026-07-22T11:32:52Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- `InviteManager.ingestEvent` now enforces the 1059 `p`-tag singleton cardinality rule (WIRE-02/SC3): a repeated, absent, or empty-valued `p` tag is rejected with reason `"tag-cardinality"` after the outer-signature gate and before storage, closing the last unimplemented entry in the required-tag cardinality contract.
- `GroupsManager#connectGroup`'s drain now records an event id in the dedup `seen` set only after it passes both `safeVerifyEvent` and the `h`-tag cardinality gate — a corrupted same-id forgery can no longer poison the dedup slot and silently drop the genuine, validly-signed message that arrives afterward (SEC-01/WR-01 restored).
- `createWelcomeRumor` now rejects a `groupRelays` array containing a duplicate URL at produce time, matching the #236 list-cardinality rule its own consumer (`getWelcome`/`getWelcomeGroupRelays` via `getListTag`) already enforces — the library can no longer emit an invite it cannot itself decode (WIRE-02 self-consistency/WR-02).

## Task Commits

Each task was committed atomically:

1. **Task 1: Enforce 1059 `p`-tag cardinality in InviteManager.ingestEvent (GAP 1 / WIRE-02)** - `549274d` (feat)
2. **Task 2: Reorder #connectGroup drain so only verified 445 events occupy the dedup slot (GAP 2 / SEC-01 / WR-01)** - `0c125c9` (fix)
3. **Task 3: Make createWelcomeRumor reject duplicate relay URLs to match its own consumer (GAP 3 / WIRE-02 / WR-02)** - `1e8a958` (fix)

_All three tasks were TDD (`tdd="true"`); each commit bundles the new/failing test alongside the fix since the target behavior is a small, existing-call-site wiring change rather than a new module — tests and implementation were authored and verified together per task before committing._

## Files Created/Modified

- `src/client/invite-manager.ts` - Added `getSingletonTagValue(event, "p")` gate in `ingestEvent`, after `safeVerifyEvent` and before the seen/store write; broadened the `rejected` event JSDoc
- `src/client/__tests__/invite-manager.test.ts` - Added a "trust boundary (WIRE-02) — 1059 `p` tag cardinality" describe with 5 new tests (two-`p`, absent-`p`, empty-`p`, valid single-`p` happy path, invalid-signature-runs-first)
- `src/client/groups-manager.ts` - Reordered `#connectGroup`'s drain: `seen.add(event.id)` moved into the trusted branch (after signature + `h`-cardinality checks pass); added a `rejectedEvents` object-identity `Set` to suppress duplicate `rejected` emits for exact-object relay replay without blocking a distinct same-id event
- `src/__tests__/groups-manager.test.ts` - Added a WR-01 regression test: corrupted same-id forgery rejected first, genuine event still reaches `group.ingest()` via the live path, re-delivery of the verified event stays deduped
- `src/core/welcome-event.ts` - Added a duplicate-URL rejection (`new Set(groupRelays).size !== groupRelays.length`) to `createWelcomeRumor`'s existing guard block; updated the `groupRelays` param JSDoc
- `src/core/__tests__/welcome.test.ts` - Added a `createWelcomeRumor` describe with 2 tests: duplicate-relay throw, and distinct-relay round-trip parity with `getWelcome`/`getWelcomeGroupRelays`

## Decisions Made

- Introduced an object-identity-keyed `rejectedEvents` Set alongside the trusted-only `seen` id Set in `#connectGroup`'s drain. The plan's literal instruction ("do not add ids for events emitted as rejected") is necessary for WR-01 but, applied alone, would have caused the existing single-rejection tests to start seeing duplicate `rejected` emits — `MockNetwork`'s `#connectGroup` flow backfills via `request()` and then immediately re-delivers the same still-present event object through `subscription().subscribe()`'s initial replay (this mirrors a real relay's REQ behavior: a fresh subscription can re-return matching stored events already seen via a prior backfill query). Tracking rejected event objects by reference (not id) suppresses the redundant re-rejection of the literal same malformed object while leaving a _different_ object carrying the same id (the WR-01 forgery scenario) free to be evaluated fresh and, if valid, trusted.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added object-identity rejectedEvents tracking to avoid duplicate-rejection regression**

- **Found during:** Task 2 (reordering `#connectGroup`'s drain)
- **Issue:** Moving `seen.add(event.id)` to occur only in the trusted branch (per plan's literal wording) would let a rejected event's id be re-evaluated on every redelivery. Given `MockNetwork`'s backfill + subscribe-replay both deliver the same still-present event object, the two existing single-rejection tests ("rejects an inbound 445 event with an invalid signature before ingest", "rejects a properly-signed 445 event carrying a duplicate h tag before ingest") would have started asserting 2 rejections instead of 1.
- **Fix:** Added a local `rejectedEvents: Set<NostrEvent>` (object-identity, not id-keyed) inside `#connectGroup`. An event already in `rejectedEvents` is skipped silently on redelivery (no re-verify, no re-emit); a genuinely different object with the same id (WR-01's forged-then-genuine scenario) is unaffected since it's a different reference.
- **Files modified:** `src/client/groups-manager.ts`
- **Verification:** All 3 existing SEC-01/WIRE-02 tests plus the new WR-01 regression test pass; full suite green (68 files / 647 tests)
- **Committed in:** `0c125c9` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug prevention, necessary correctness fix)
**Impact on plan:** Necessary to satisfy the plan's own "existing tests remain green" acceptance criterion while still closing WR-01. No scope creep — confined to the same file/task the plan targeted.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three confirmed 02-VERIFICATION.md gaps are closed; Phase 02's SEC-01/WIRE-01/WIRE-02 success criteria now fully hold, including the WIRE-02 required-tag cardinality contract across all four kinds (445, 1059, 444, 30443) and the SEC-01 no-unverified-field-trust guarantee for 445 delivery.
- WIRE-01 (KeyPackage lifetime cap) was untouched, as required — no lifetime code was modified in this plan.
- Full test suite green (68 files / 647 tests), `pnpm compile` clean, `pnpm vitest run` clean — ready for phase transition / Phase 03.

---

_Phase: 02-inbound-trust-wire-boundary_
_Completed: 2026-07-22_

## Self-Check: PASSED

All 6 modified source/test files confirmed present on disk; all 3 task commit hashes (`549274d`, `0c125c9`, `1e8a958`) confirmed in git history.
