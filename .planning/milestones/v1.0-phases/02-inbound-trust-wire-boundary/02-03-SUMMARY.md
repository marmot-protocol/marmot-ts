---
phase: 02-inbound-trust-wire-boundary
plan: 03
subsystem: security
tags: [nostr, mls, key-package, invite, wire-boundary, verification, lifetime]

# Dependency graph
requires:
  - phase: 02-inbound-trust-wire-boundary (plan 01)
    provides: "src/client/verify.ts (RejectReason/defaultVerifyEvent/safeVerifyEvent/fakeVerifyEvent), src/utils/tag-cardinality.ts (getSingletonTagValue/getListTag), src/utils/timestamp.ts (isLifetimeWithinCap/isLifetimeCurrentWithGrace)"
  - phase: 02-inbound-trust-wire-boundary (plan 02)
    provides: "verifyEvent?: VerifyEventMethod threaded through MarmotClientOptions into KeyPackageManagerOptions/GroupsManagerOptions; the verify-then-cardinality gate pattern established at the 445/1059 boundaries"
provides:
  - "getKeyPackageLifetime(event) — inbound read of a 30443 KeyPackage's MLS Lifetime, never throws"
  - "evaluateKeyPackageForGroup Lifetime reason — soft-reject defense-in-depth for over-long/expired Lifetimes"
  - "KeyPackageManager.track() gated on verify + d/i/mls_protocol_version cardinality + Lifetime cap/current, emitting a typed rejected(event, reason) before persisting"
  - "createInviteIntent gated identically (the store-bypassing second 30443 consumption path), with GroupsManager.invite() threading its injected verifier through"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Verify -> tag-cardinality -> Lifetime-cap gate order applied identically at both 30443 consumption paths (track() and createInviteIntent), closing the loop the 02-02 SUMMARY flagged as remaining"
    - "mls_protocol_version cardinality/value check is new wiring, not a migration — the tag had zero internal read sites before this plan (RESEARCH Pitfall 1)"

key-files:
  created: []
  modified:
    - src/core/key-package-event-decode.ts
    - src/core/key-package-eligibility.ts
    - src/core/__tests__/key-package-event.test.ts
    - src/__tests__/exports.test.ts
    - src/client/key-package-manager.ts
    - src/client/__tests__/key-package-manager.test.ts
    - src/client/group/invite.ts
    - src/client/group/__tests__/invite.test.ts
    - src/client/groups-manager.ts

key-decisions:
  - "Placed the createInviteIntent trust-boundary unit tests in the existing dedicated src/client/group/__tests__/invite.test.ts rather than key-package-manager.test.ts (the plan's literal files_modified list) — invite.ts already has its own test file, and colocating tests with their source module matches this codebase's established convention (CLAUDE.md). The plan's own automated verify command for Task 3 already targeted key-package-manager.test.ts + groups-manager.test.ts only (not invite.test.ts), and the full-suite verification step exercises invite.test.ts regardless."
  - "Reused the already-decoded keyPackage.leafNode.lifetime inside evaluateKeyPackageForGroup instead of re-calling getKeyPackageLifetime (which would re-decode the event body a second time) — same isLifetimeWithinCap/isLifetimeCurrentWithGrace helpers, avoiding a redundant decode inside the existing try/catch."
  - "track()'s cardinality gate reuses the already-validated i tag value (from getSingletonTagValue) as the ref passed to addPublished, replacing the prior getKeyPackageReference() read — a genuine migration per RESEARCH (i already had an internal call site), not new wiring."

patterns-established:
  - "Both 30443 consumption paths (KeyPackageManager.track() and createInviteIntent) now apply the identical verify -> cardinality -> lifetime gate sequence, so an app cannot bypass SEC-01/WIRE-01/WIRE-02 by calling the store-bypassing path directly"

requirements-completed: [SEC-01, WIRE-01, WIRE-02]

coverage:
  - id: D1
    description: "getKeyPackageLifetime reads the KeyPackage leaf node Lifetime and never throws (undefined for undecodable events); evaluateKeyPackageForGroup soft-rejects over-cap (7,261,201s) and expired-beyond-grace Lifetimes with a reason, while an at-cap/current KeyPackage (7,257,600s) remains eligible"
    requirement: "WIRE-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/key-package-event.test.ts#getKeyPackageLifetime (WIRE-01 inbound read)"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/key-package-event.test.ts#evaluateKeyPackageForGroup — Lifetime check (WIRE-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "KeyPackageManager.track() rejects an inbound 30443 event with an invalid signature — emits rejected(event, 'invalid-signature'), returns false, does not persist"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a signature-corrupted 30443 event before persisting"
        status: pass
    human_judgment: false
  - id: D3
    description: "track() rejects non-singleton/invalid d, i, or mls_protocol_version (absent, duplicated, or not '1.0') with reason 'tag-cardinality' — mls_protocol_version is new wiring, not a migration"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a properly-signed 30443 event carrying a duplicate d tag as tag-cardinality"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a 30443 event with a duplicate i tag as tag-cardinality"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a 30443 event with a missing mls_protocol_version tag as tag-cardinality"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a 30443 event whose mls_protocol_version is not 1.0 as tag-cardinality"
        status: pass
    human_judgment: false
  - id: D4
    description: "track() rejects an inbound KeyPackage whose Lifetime range exceeds the 7,261,200s cap or is expired beyond the ~1h grace, with reason 'lifetime-cap'; a fully-valid event still tracks successfully (no regression)"
    requirement: "WIRE-01"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a 30443 event whose KeyPackage lifetime exceeds the cap as lifetime-cap"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > rejects a 30443 event whose KeyPackage lifetime is expired beyond the ~1h grace as lifetime-cap"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#track() — trust boundary (SEC-01/WIRE-01/WIRE-02) > tracks a fully-valid, in-cap, current, correctly-signed 30443 event successfully"
        status: pass
    human_judgment: false
  - id: D5
    description: "createInviteIntent (the store-bypassing second 30443 consumption path) throws on invalid signature, d/mls_protocol_version cardinality violations, and over-cap/expired Lifetime; delegates to an injected verifyEvent (e.g. fakeVerifyEvent); a fully-valid event still produces the expected commit intent"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > throws createInviteIntent: ... for a signature-corrupted keyPackageEvent"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > delegates verification to an injected fakeVerifyEvent (trust-upstream)"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > throws createInviteIntent: ... for a duplicate d tag (tag-cardinality)"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > throws createInviteIntent: ... for a bad mls_protocol_version (tag-cardinality)"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > throws createInviteIntent: ... for a KeyPackage lifetime over the cap"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > throws createInviteIntent: ... for an expired-beyond-grace KeyPackage lifetime"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/invite.test.ts#trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path > still builds a commit intent for a fully-valid keyPackageEvent (no regression)"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-22
status: complete
---

# Phase 2 Plan 3: 30443 KeyPackage Trust Boundary — track(), createInviteIntent, Lifetime Cap Summary

**Closed the 30443 KeyPackage inbound boundary on both consumption paths at once — verify + `d`/`i`/`mls_protocol_version` cardinality + Lifetime cap/current — completing SEC-01, WIRE-01, and WIRE-02 for the phase.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-22T10:48:59Z
- **Completed:** 2026-07-22T10:54:39Z
- **Tasks:** 3 completed
- **Files modified:** 9 (0 created, 9 modified)

## Accomplishments

- Added `getKeyPackageLifetime(event)` (`src/core/key-package-event-decode.ts`): reads the MLS `Lifetime` off a decoded 30443 KeyPackage's leaf node, returning `undefined` (never throwing) when the event is undecodable — the inbound Lifetime read helper both consumption paths now share.
- Added a Lifetime `reasons.push(...)` check to `evaluateKeyPackageForGroup` (`src/core/key-package-eligibility.ts`): an over-cap (`> 7,261,200s`) or expired-beyond-~1h-grace KeyPackage now yields `eligible: false` with a reason, defense-in-depth alongside the hard-reject boundary.
- Gated `KeyPackageManager.track()` (the passive inbound-discovery path) on, in order: signature verify (`safeVerifyEvent`), `d`/`i`/`mls_protocol_version` cardinality (`getSingletonTagValue`), and Lifetime cap/current — emitting a new typed `rejected(event, reason)` event and returning `false` before the event ever reaches `KeyPackageStore.addPublished`. `mls_protocol_version` cardinality/value ("1.0") checking is genuinely new wiring — the tag had zero internal read sites before this plan (confirmed via RESEARCH Pitfall 1). The self-publish path (`create`/`rotate`) and `addPublished`'s existing `i`-tag ref-integrity throw are unchanged.
- Gated `createInviteIntent` (`src/client/group/invite.ts`) — the second 30443 consumption path that bypasses `KeyPackageStore` entirely — on the identical verify + cardinality + Lifetime sequence, added a `verifyEvent?: VerifyEventMethod` option, and threaded `GroupsManager.invite()`'s injected `#verifyEvent` through so all three inbound entry points (445/1059/30443) plus both 30443 consumption paths share one verifier.

## Task Commits

Each task followed RED → GREEN (TDD):

1. **Task 1: Add inbound Lifetime read helper + eligibility Lifetime reason**
   - `9c27f1d` test(02-03): add failing tests for inbound Lifetime read + eligibility check
   - `c14c308` feat(02-03): add inbound KeyPackage Lifetime read + eligibility check
2. **Task 2: Gate KeyPackageManager.track() on verify + cardinality + lifetime cap; emit 'rejected'**
   - `0522d52` test(02-03): add failing tests for KeyPackageManager.track() trust boundary
   - `367108b` feat(02-03): gate KeyPackageManager.track() on verify + cardinality + lifetime
3. **Task 3: Gate the store-bypassing createInviteIntent path on verify + cardinality + lifetime**
   - `4d35b70` test(02-03): add failing tests for createInviteIntent trust boundary
   - `539b96e` feat(02-03): gate createInviteIntent on verify + cardinality + lifetime

**Plan metadata:** (this commit, pending)

## Files Created/Modified

- `src/core/key-package-event-decode.ts` - `getKeyPackageLifetime(event)` read helper (never throws) (MODIFIED)
- `src/core/key-package-eligibility.ts` - `evaluateKeyPackageForGroup` now pushes a Lifetime reason for over-cap/expired KeyPackages (MODIFIED)
- `src/core/__tests__/key-package-event.test.ts` - new `getKeyPackageLifetime` and `evaluateKeyPackageForGroup` Lifetime describe blocks (MODIFIED)
- `src/__tests__/exports.test.ts` - inline snapshot updated for the new `getKeyPackageLifetime` export (MODIFIED, Rule 3 auto-fix, matches 02-01's precedent)
- `src/client/key-package-manager.ts` - `track()` gated on verify + cardinality + lifetime; new `rejected` event on `KeyPackageManagerEvents` (MODIFIED)
- `src/client/__tests__/key-package-manager.test.ts` - new "track() — trust boundary (SEC-01/WIRE-01/WIRE-02)" describe block (7 tests) (MODIFIED)
- `src/client/group/invite.ts` - `createInviteIntent` gated on verify + cardinality + lifetime; new `verifyEvent` option (MODIFIED)
- `src/client/group/__tests__/invite.test.ts` - new "trust boundary (SEC-01/WIRE-01/WIRE-02) — the store-bypassing path" describe block (7 tests) (MODIFIED)
- `src/client/groups-manager.ts` - `invite()` now passes `verifyEvent: this.#verifyEvent` to `createInviteIntent` (MODIFIED)

## Decisions Made

- Placed the `createInviteIntent` trust-boundary tests in the existing dedicated `src/client/group/__tests__/invite.test.ts` rather than `key-package-manager.test.ts` (the plan's literal `files_modified` entry for Task 3) — `invite.ts` already has its own colocated test file per this codebase's convention, and the plan's own Task 3 automated verify command already targeted `key-package-manager.test.ts` + `groups-manager.test.ts` (not `invite.test.ts`); the phase-level full-suite verification step exercises `invite.test.ts` regardless.
- Reused the already-decoded `keyPackage.leafNode.lifetime` inside `evaluateKeyPackageForGroup`'s existing try block instead of calling `getKeyPackageLifetime` a second time, avoiding a redundant decode of the same event body.
- `track()`'s cardinality gate captures the validated `i` tag value directly from `getSingletonTagValue` and reuses it as the `addPublished` ref, replacing the prior `getKeyPackageReference()` call — a genuine migration (the `i` tag already had an internal call site here, per RESEARCH), not new wiring.

## Deviations from Plan

None (beyond the test-file-placement decision documented above, which preserves every acceptance criterion the plan specified).

## Issues Encountered

None. All pre-existing tests in `key-package-manager.test.ts`, `groups-manager.test.ts`, and `invite.test.ts` that construct hand-signed or tampered events continued to pass unmodified — every event those tests exercise for success paths is produced by real signing code (`finalizeEvent`/`signer.signEvent`), matching RESEARCH Pitfall 4's low-risk assessment.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-01, WIRE-01, and WIRE-02 are now closed across all three inbound entry points (445, 1059, 30443) and both 30443 consumption paths (`track()`/`addPublished()` and `createInviteIntent`). This is the phase's last contributing plan for these requirement IDs — `requirements mark-complete` runs for SEC-01/WIRE-01/WIRE-02 after this plan (02-01 and 02-02 intentionally left them Pending).
- Full test suite (639 tests, 68 files) and `pnpm compile` both pass clean; `grep` confirms zero references to `ts-mls`'s dead `maximumTotalLifetime` config field in `key-package-manager.ts` (the cap is enforced by reading `notAfter - notBefore` in marmot-ts, per RESEARCH Pitfall 3).
- Phase 2 (inbound-trust-wire-boundary) is complete. Phase 3 (commit-integrity/convergence parity, CONV-04 verify-first) is next per the roadmap.

---

_Phase: 02-inbound-trust-wire-boundary_
_Completed: 2026-07-22_

## Self-Check: PASSED

All 9 modified files and 6 task-commit hashes verified present on disk / in git history.
