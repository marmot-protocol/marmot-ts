---
phase: 02-inbound-trust-wire-boundary
plan: 01
subsystem: security
tags: [nostr, mls, key-package, applesauce, wire-boundary, verification]

# Dependency graph
requires: []
provides:
  - "src/client/verify.ts — RejectReason taxonomy + injectable defaultVerifyEvent/fakeVerifyEvent"
  - "src/utils/tag-cardinality.ts — #236 table-driven TAG_CARDINALITY + strict getSingletonTagValue/getListTag"
  - "src/utils/timestamp.ts — createDefaultKeyPackageLifetime (84-day cap, ~1h backdate), isLifetimeWithinCap, isLifetimeCurrentWithGrace"
  - "src/core/key-package.ts — generateKeyPackage rejects an explicit lifetime override that exceeds the 84-day cap"
affects: [02-02, 02-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Trust-boundary primitives (verifier, tag-cardinality, lifetime cap) isolated as pure helper modules so entry-point wiring plans only call them, never reimplement"
    - "Reject-via-typed-undefined (not throw) for cardinality violations, matching the project's inbound-multi-outcome convention"

key-files:
  created:
    - src/client/verify.ts
    - src/client/__tests__/verify.test.ts
    - src/utils/tag-cardinality.ts
    - src/utils/__tests__/tag-cardinality.test.ts
    - src/utils/__tests__/timestamp.test.ts
  modified:
    - src/utils/timestamp.ts
    - src/core/key-package.ts
    - src/__tests__/exports.test.ts

key-decisions:
  - "Kept createThreeMonthLifetime as a deprecated alias re-export of createDefaultKeyPackageLifetime rather than a hard rename, per CONTEXT's Claude's Discretion"
  - "Cap enforcement lives entirely in marmot-ts (isLifetimeWithinCap + a throw guard in generateKeyPackage) rather than ts-mls's LifetimeConfig.maximumTotalLifetime, which is dead code in rc.14 (RESEARCH Pitfall 3)"
  - "getTagValue in src/utils/nostr.ts left byte-for-byte untouched; the new strict getters live in a new sibling module (src/utils/tag-cardinality.ts) per D-10"

patterns-established:
  - "Table-driven (kind, tagName) -> cardinality data map (TAG_CARDINALITY) as the single source of truth for #236 required-tag rules, consumed by strict getters that return undefined (never throw) on any cardinality violation"

requirements-completed: [SEC-01, WIRE-01, WIRE-02]

coverage:
  - id: D1
    description: "src/client/verify.ts exports RejectReason (invalid-signature | lifetime-cap | tag-cardinality), defaultVerifyEvent (referentially applesauce's verifyEvent), and re-exports fakeVerifyEvent — the injectable SEC-01 verifier surface"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/client/__tests__/verify.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "src/utils/tag-cardinality.ts implements the #236 TAG_CARDINALITY table plus getSingletonTagValue/getListTag strict getters that reject absent/repeated/empty/duplicate required tags instead of first-match resolving"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/utils/__tests__/tag-cardinality.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Produce-side KeyPackage lifetime capped at 84 days (7,257,600s) with a ~1h backdated notBefore (createDefaultKeyPackageLifetime), plus isLifetimeWithinCap/isLifetimeCurrentWithGrace inbound-check helpers with symmetric ~1h grace"
    requirement: "WIRE-01"
    verification:
      - kind: unit
        ref: "src/utils/__tests__/timestamp.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "generateKeyPackage rejects an explicit lifetime override whose range exceeds the 84-day cap, closing the WIRE-01 produce-side gap regardless of how lifetime is supplied"
    requirement: "WIRE-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/key-package.test.ts#should reject an explicit lifetime override that exceeds the 84-day cap (D-08/D-09)"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-22
status: complete
---

# Phase 2 Plan 1: Trust-Boundary Primitives + Produce-Side Lifetime Cap Summary

**RejectReason taxonomy + injectable applesauce verifier, a #236 table-driven tag-cardinality validator, and an 84-day capped/backdated KeyPackage lifetime with a guarded explicit-override path.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-22T11:09:37Z
- **Completed:** 2026-07-22T11:14:40Z
- **Tasks:** 3 completed
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments

- Created `src/client/verify.ts`: the `RejectReason` string-literal union (`'invalid-signature' | 'lifetime-cap' | 'tag-cardinality'`), `defaultVerifyEvent` (referentially applesauce's `verifyEvent`), and re-exported `fakeVerifyEvent`/`VerifyEventMethod`/`VerifiedEvent` — the shared SEC-01 verifier surface all three Wave 2/3 entry points will import.
- Created `src/utils/tag-cardinality.ts`: the #236 cardinality table (`TAG_CARDINALITY`) encoding every (kind, tag) → singleton/list rule from D-11, plus `getSingletonTagValue`/`getListTag` strict getters that return `undefined` (never throw) on any absent/repeated/empty/duplicate violation. `getTagValue` in `src/utils/nostr.ts` left untouched.
- Renamed `createThreeMonthLifetime` to `createDefaultKeyPackageLifetime` (84-day range, ~1h backdated `notBefore`), keeping the old name as a `@deprecated` alias; added `isLifetimeWithinCap` and `isLifetimeCurrentWithGrace` inbound-check helpers with a symmetric ~1h grace window.
- Closed the WIRE-01 produce-side gap on both paths: `generateKeyPackage`'s default lifetime is now capped at the source, and an explicit `lifetime` override exceeding 7,261,200s is rejected with a thrown `Error` before any KeyPackage is built.

## Task Commits

Each task followed RED → GREEN (TDD):

1. **Task 1: Create src/client/verify.ts**
   - `ccd2758` test(02-01): add failing test for verify.ts trust-boundary primitives
   - `d487b5c` feat(02-01): create src/client/verify.ts trust-boundary primitives
2. **Task 2: Create src/utils/tag-cardinality.ts**
   - `b74d831` test(02-01): add failing test for tag-cardinality.ts #236 validator
   - `f22dfc7` feat(02-01): implement #236 table-driven tag-cardinality validator
3. **Task 3: Cap + backdate + rename produce-side lifetime; guard explicit override**
   - `2c2047e` test(02-01): add failing tests for capped/backdated lifetime + explicit-override guard
   - `f6adb91` feat(02-01): cap/backdate produce-side KeyPackage lifetime, guard explicit override

**Plan metadata:** (this commit)

## Files Created/Modified

- `src/client/verify.ts` - RejectReason taxonomy, defaultVerifyEvent, re-exported applesauce verifier surface (NEW)
- `src/client/__tests__/verify.test.ts` - unit tests for the above (NEW)
- `src/utils/tag-cardinality.ts` - TAG_CARDINALITY table + getSingletonTagValue/getListTag strict getters (NEW)
- `src/utils/__tests__/tag-cardinality.test.ts` - unit tests for the above (NEW)
- `src/utils/timestamp.ts` - createDefaultKeyPackageLifetime (84-day cap + backdate), createThreeMonthLifetime deprecated alias, isLifetimeWithinCap, isLifetimeCurrentWithGrace (MODIFIED)
- `src/utils/__tests__/timestamp.test.ts` - unit tests for the above (NEW)
- `src/core/key-package.ts` - generateKeyPackage now calls createDefaultKeyPackageLifetime and rejects an over-cap explicit lifetime override (MODIFIED)
- `src/core/__tests__/key-package.test.ts` - two new tests: explicit over-cap lifetime rejects, explicit at-cap lifetime succeeds (MODIFIED)
- `src/__tests__/exports.test.ts` - inline snapshot updated for the three new timestamp.ts exports (MODIFIED, Rule 3 auto-fix)

## Decisions Made

- Kept `createThreeMonthLifetime` as a deprecated alias rather than a hard rename, per CONTEXT's Claude's Discretion note — downstream callers do not break.
- The 84-day cap is enforced entirely in marmot-ts (`isLifetimeWithinCap` + a throw guard in `generateKeyPackage`), not delegated to `ts-mls`'s `LifetimeConfig.maximumTotalLifetime`, which RESEARCH confirmed is unread/dead code in ts-mls 2.0.0-rc.14.
- `getTagValue` in `src/utils/nostr.ts` was left byte-for-byte untouched (D-10); the new strict getters live in the new sibling module `src/utils/tag-cardinality.ts` rather than being added inline to `nostr.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated exports.test.ts inline snapshot**

- **Found during:** Task 3 (timestamp.ts lifetime cap/rename)
- **Issue:** `src/utils/timestamp.ts` is re-exported through `src/utils/index.ts` → `src/index.ts`; adding `createDefaultKeyPackageLifetime`, `isLifetimeWithinCap`, and `isLifetimeCurrentWithGrace` as new exports caused `src/__tests__/exports.test.ts`'s `toMatchInlineSnapshot` to fail (a pre-existing test asserting the exact export surface, not part of this plan's files_modified list but a direct, correctness-required consequence of the new exports).
- **Fix:** Ran `pnpm vitest run src/__tests__/exports.test.ts -u` to regenerate the inline snapshot with the three new symbols in their sorted positions; verified no other exports changed.
- **Files modified:** `src/__tests__/exports.test.ts`
- **Verification:** `pnpm vitest run src/__tests__/exports.test.ts` passes; full suite (`pnpm vitest run`) passes 611/611.
- **Committed in:** `f6adb91` (part of Task 3 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the pre-existing export-surface regression test accurate after adding the plan's own new exports. No scope creep — no new symbols were added beyond what the plan specified.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three shared primitives (`RejectReason`/`defaultVerifyEvent`, `TAG_CARDINALITY`/strict getters, `createDefaultKeyPackageLifetime`/`isLifetimeWithinCap`/`isLifetimeCurrentWithGrace`) exist, are unit-tested, and are ready for Wave 2/3 plans (02-02, 02-03) to wire into the three inbound entry points (445 `#connectGroup` drain, 1059 `InviteManager.ingestEvent`, 30443 `KeyPackageStore.addPublished`/`createInviteIntent`).
- WIRE-01 produce side is fully closed (default path capped; explicit-override path guarded). WIRE-01's inbound-reject side, SEC-01's boundary wiring, and WIRE-02's call-site migrations remain for 02-02/02-03.
- Full test suite (611 tests, 68 files) and `pnpm compile` both pass clean; no regressions introduced.

---

_Phase: 02-inbound-trust-wire-boundary_
_Completed: 2026-07-22_

## Self-Check: PASSED

All 6 created files and 6 commit hashes verified present on disk / in git history.
