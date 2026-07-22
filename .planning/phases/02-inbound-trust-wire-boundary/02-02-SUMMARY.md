---
phase: 02-inbound-trust-wire-boundary
plan: 02
subsystem: security
tags:
  [
    nostr,
    mls,
    gift-wrap,
    welcome,
    groups-manager,
    invite-manager,
    verification,
    wire-boundary,
  ]

# Dependency graph
requires:
  - phase: 02-inbound-trust-wire-boundary (plan 01)
    provides: "src/client/verify.ts (RejectReason/defaultVerifyEvent/fakeVerifyEvent), src/utils/tag-cardinality.ts (getSingletonTagValue/getListTag)"
provides:
  - "verifyEvent?: VerifyEventMethod threaded through MarmotClientOptions into GroupsManagerOptions, InviteManagerOptions, and KeyPackageManagerOptions (KeyPackageManager's is plumbing-only, consumed by 02-03)"
  - "GroupsManager #connectGroup drain rejects invalid-signature and non-singleton-h 445 events before group.ingest(), emitting a typed rejected(groupId, event, reason) event"
  - "InviteManager.ingestEvent verifies the outer kind-1059 event before any store write or decrypt, emitting rejected(event, reason); the unsigned 444 rumor is never passed through the verifier"
  - "src/core/welcome-event.ts's e/relays reads migrated to the #236 strict getters — a repeated e tag, repeated relays tag, or duplicate relay URLs reject instead of first-match-resolving"
  - "safeVerifyEvent() in verify.ts: wraps any VerifyEventMethod so a malformed event that would make applesauce's verifyEvent throw (not return false) is treated as a rejection instead of an unhandled exception"
affects: [02-03]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Trust-boundary gate ordering: verify signature first, then tag-cardinality, before any event reaches ingest/store/decrypt — established once in the 445 drain, repeated identically in the 1059 ingestEvent gate"
    - "safeVerifyEvent() wrapper as the mandatory call site for any injected VerifyEventMethod, since the underlying applesauce/nostr-tools implementation can throw on malformed input rather than returning false"
    - "getSingletonTagValue/getListTag generalized to a `<T extends { tags: string[][] }>` bound (mirroring getTagValue's own constraint) so the same strict getters validate both signed NostrEvents and unsigned Rumors"

key-files:
  created: []
  modified:
    - src/client/marmot-client.ts
    - src/client/key-package-manager.ts
    - src/client/groups-manager.ts
    - src/__tests__/groups-manager.test.ts
    - src/client/invite-manager.ts
    - src/client/__tests__/invite-manager.test.ts
    - src/core/welcome-event.ts
    - src/core/__tests__/welcome.test.ts
    - src/client/verify.ts
    - src/utils/tag-cardinality.ts

key-decisions:
  - "Deferred threading verifyEvent into GroupsManager/InviteManager's constructor calls in marmot-client.ts to Tasks 2/3 respectively (not Task 1 as the plan literally described), since GroupsManagerOptions/InviteManagerOptions don't gain the field until those tasks — keeps every task's own pnpm compile green rather than leaving a transient TS excess-property error mid-plan"
  - "Added safeVerifyEvent() to verify.ts after discovering applesauce's verifyEvent (nostr-tools/pure) only wraps its Schnorr-verify step in try/catch — the earlier getEventHash/serializeEvent call throws uncaught on a malformed event (bad pubkey format, missing field), which would otherwise crash both the 445 drain and the 1059 ingest gate; fixed once at the shared verify.ts callsite and applied to both entry points (Rule 1 — DoS-adjacent bug directly caused by this plan's own gates)"
  - "Relaxed getSingletonTagValue/getListTag (02-01) from a NostrEvent-only parameter to a generic tagged-object bound, since the 444 welcome-rumor callers pass a Rumor (no sig/id) — this was a genuine compile blocker discovered while wiring Task 3, not scope creep (Rule 3)"
  - 'Injected fakeVerifyEvent into invite-manager.test.ts''s shared beforeEach InviteManager: its pre-existing createMockGiftWrap events carry a fake sig: "signature" literal and predate the SEC-01 gate; a new dedicated ''trust boundary (SEC-01)'' describe block uses genuinely signed events against the default (real) verifier instead'
  - "REQUIREMENTS.md SEC-01/WIRE-01/WIRE-02 checkboxes intentionally left unmarked after this plan — 02-03 also declares all three and completes the 30443 KeyPackage boundary + WIRE-01 inbound-reject side; mark-complete runs once 02-03 lands (same pattern 02-01 established)"

patterns-established:
  - "Verify-then-cardinality gate order at every inbound trust boundary: signature check first (cheap, universal), tag-cardinality check second (kind-specific), both before the event is trusted downstream"

requirements-completed: []
# SEC-01 and WIRE-02 are NOT marked complete here — 02-03 also declares them
# and completes the remaining boundary (30443) before the phase's traceability
# is updated. See key-decisions above.

coverage:
  - id: D1
    description: "An inbound 445 event with an invalid id/signature is rejected in the #connectGroup drain before group.ingest() is called, emitting rejected(groupId, event, 'invalid-signature')"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts#rejects an inbound 445 event with an invalid signature before ingest"
        status: pass
    human_judgment: false
  - id: D2
    description: "A 445 event whose h tag is repeated/empty/duplicate is rejected with reason 'tag-cardinality' before ingest, even when properly signed"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts#rejects a properly-signed 445 event carrying a duplicate h tag before ingest"
        status: pass
    human_judgment: false
  - id: D3
    description: "An inbound 1059 gift wrap with an invalid outer id/signature is rejected in InviteManager.ingestEvent before it is stored or decrypted, emitting rejected(event, 'invalid-signature')"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/client/__tests__/invite-manager.test.ts#rejects a 1059 gift wrap with an invalid outer signature before store/decrypt"
        status: pass
    human_judgment: false
  - id: D4
    description: "getWelcome rejects a 444 rumor whose e is non-singleton or whose relays is empty/duplicate via the strict getters, while well-formed welcomes are unaffected"
    requirement: "WIRE-02"
    verification:
      - kind: unit
        ref: "src/core/__tests__/welcome.test.ts#rejects a kind 444 rumor carrying two e tags (#236 singleton cardinality)"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/welcome.test.ts#rejects a kind 444 rumor whose relays tag carries duplicate URLs (#236 list cardinality)"
        status: pass
    human_judgment: false
  - id: D5
    description: "verifyEvent is injectable through MarmotClientOptions and defaults to applesauce verifyEvent; supplying fakeVerifyEvent makes verification a no-op (delegation) on both the 445 and 1059 gates"
    requirement: "SEC-01"
    verification:
      - kind: unit
        ref: "src/__tests__/groups-manager.test.ts#delegates verification to an injected fakeVerifyEvent (trust-upstream)"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/invite-manager.test.ts#delegates verification to an injected fakeVerifyEvent (trust-upstream)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-22
status: complete
---

# Phase 2 Plan 2: Inbound Trust Wiring — 445 Drain, 1059 Gift Wrap, 444 Welcome Getters Summary

**Threaded an injectable `verifyEvent` through `MarmotClient` and gated the 445 group-message drain and 1059 gift-wrap ingest on verify-before-trust plus `#236` tag-cardinality, migrating the 444 welcome rumor's `e`/`relays` reads to the strict getters — while fixing a shared DoS-adjacent bug where the underlying verifier could throw instead of reject.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-22T11:22:00Z (approx.)
- **Completed:** 2026-07-22T11:32:49Z
- **Tasks:** 3 completed
- **Files modified:** 10 (0 created, 10 modified)

## Accomplishments

- Added `verifyEvent?: VerifyEventMethod` to `MarmotClientOptions`, resolved once in the constructor and threaded into `GroupsManager`, `InviteManager`, and `KeyPackageManager` (the last is plumbing-only, consumed by plan 02-03's 30443 gate).
- `GroupsManager`'s `#connectGroup` drain now verifies every inbound kind-445 event's signature and its `h` tag's `#236` singleton cardinality BEFORE the event ever reaches `group.ingest()`, emitting a new `rejected(groupId, event, reason)` event (`"invalid-signature"` or `"tag-cardinality"`) and dropping the event.
- `InviteManager.ingestEvent` now verifies the OUTER kind-1059 event before any store write or decrypt attempt, closing the gap `unlockGiftWrap` leaves (it only verifies the inner NIP-59 seal, never the outer envelope). Emits `rejected(event, "invalid-signature")` and returns `false` on failure; the unsigned 444 rumor is never itself passed through the verifier.
- Migrated `src/core/welcome-event.ts`'s `e`/`relays` reads to the `#236` strict getters (`getSingletonTagValue`/`getListTag`): a repeated `e` tag, a repeated `relays` tag, or duplicate relay URLs now reject instead of silently first-match-resolving.
- Fixed a real bug discovered while wiring the gates: applesauce's `verifyEvent` only wraps its Schnorr-verify step in try/catch — a malformed event (bad pubkey format, etc.) makes the earlier `getEventHash`/`serializeEvent` call throw uncaught. Added `safeVerifyEvent()` to `verify.ts` and used it at both the 445 and 1059 call sites so a malformed event is always a typed rejection, never an unhandled exception.

## Task Commits

1. **Task 1: Thread injectable verifyEvent through MarmotClient into all three managers** - `e3d099d` (feat)
2. **Task 2: Gate the 445 #connectGroup drain on verify + `h` cardinality; emit 'rejected'** - `46f92dd` (feat)
3. **Task 3: Gate the 1059 InviteManager.ingestEvent on outer verify; migrate 444 e/relays to strict getters** - `9210f12` (feat)

**Plan metadata:** (this commit, pending)

## Files Created/Modified

- `src/client/marmot-client.ts` - Added `verifyEvent?: VerifyEventMethod` option; resolves default once and threads it into GroupsManager/InviteManager/KeyPackageManager construction (MODIFIED)
- `src/client/key-package-manager.ts` - Added `verifyEvent?: VerifyEventMethod` to `KeyPackageManagerOptions`; stores a private `#verifyEvent` field, plumbing only for 02-03 (MODIFIED)
- `src/client/groups-manager.ts` - Added `verifyEvent` option + `#verifyEvent` field; `#connectGroup` drain verifies signature and `h` cardinality before `group.ingest()`; new `rejected` event on `GroupsManagerEvents` (MODIFIED)
- `src/__tests__/groups-manager.test.ts` - New "trust boundary (SEC-01/WIRE-02)" describe block: invalid-signature rejection, properly-signed duplicate-h rejection, fakeVerifyEvent delegation (MODIFIED)
- `src/client/invite-manager.ts` - Added `verifyEvent` option + `#verifyEvent` field; `ingestEvent` verifies the outer 1059 event before store/decrypt; new `rejected` event on `InviteManagerEvents` (MODIFIED)
- `src/client/__tests__/invite-manager.test.ts` - Injected `fakeVerifyEvent` into the shared `beforeEach` (pre-existing mock gift wraps aren't really signed); new "trust boundary (SEC-01)" describe block with genuinely signed events (MODIFIED)
- `src/core/welcome-event.ts` - `getWelcomeKeyPackageEventId`/`getWelcome`'s `e` read and `getWelcomeGroupRelays`'s `relays` read migrated to `getSingletonTagValue`/`getListTag` (MODIFIED)
- `src/core/__tests__/welcome.test.ts` - New tests: duplicate `e` tag, repeated `relays` tag, duplicate relay URLs, all still rejecting with the existing error messages (MODIFIED)
- `src/client/verify.ts` - Added `safeVerifyEvent()`: wraps a `VerifyEventMethod` call in try/catch so a malformed event can't crash the caller (MODIFIED)
- `src/utils/tag-cardinality.ts` - `getSingletonTagValue`/`getListTag` relaxed from `NostrEvent`-only to a generic `<T extends { tags: string[][] }>` bound so they also accept the unsigned `Rumor` shape (MODIFIED)

## Decisions Made

- Deferred threading `verifyEvent` into `GroupsManager`/`InviteManager`'s constructor calls in `marmot-client.ts` to Tasks 2/3 respectively rather than doing it all in Task 1 as the plan's prose literally described — `GroupsManagerOptions`/`InviteManagerOptions` don't gain the `verifyEvent` field until those tasks, so wiring it earlier would have left Task 1's own `pnpm compile` failing on an excess-property error. The plan itself anticipated this ("receiving option fields... added in Tasks 2 and 3").
- Added `safeVerifyEvent()` after discovering `applesauce`'s `verifyEvent` (`nostr-tools/pure`) only wraps its Schnorr-verify call in try/catch, not its `getEventHash`/`serializeEvent` call — a malformed event (e.g. non-hex `pubkey`) makes it throw uncaught. This broke several pre-existing InviteManager tests that feed intentionally-malformed mock events. Fixed once in `verify.ts` and applied at both the 445 and 1059 call sites (a shared root cause, not two separate bugs).
- Relaxed `getSingletonTagValue`/`getListTag` (built in 02-01 against `NostrEvent` only) to a generic `<T extends { tags: string[][] }>` bound, mirroring `getTagValue`'s own constraint — the 444 welcome-rumor callers pass a `Rumor` (no `sig`/`id` fields), which is a genuine type incompatibility, not a style choice.
- Injected `fakeVerifyEvent` into `invite-manager.test.ts`'s shared `beforeEach`: its `createMockGiftWrap` events carry a fake `sig: "signature"` literal and predate the SEC-01 gate; they test storage/seen-tracking/watch behavior unrelated to signature verification. A new dedicated describe block tests the SEC-01 gate itself against genuinely signed events.
- REQUIREMENTS.md's SEC-01/WIRE-01/WIRE-02 checkboxes are intentionally left unmarked after this plan — 02-03 also declares all three in its frontmatter and completes the 30443 KeyPackage boundary plus WIRE-01's inbound-reject side. Marking complete happens once 02-03 lands, per the pattern 02-01 already established.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Deferred verifyEvent threading into GroupsManager/InviteManager constructor calls from Task 1 to Tasks 2/3**

- **Found during:** Task 1
- **Issue:** The plan's Task 1 prose said to pass `verifyEvent` into all three manager constructor calls in `marmot-client.ts`, but `GroupsManagerOptions`/`InviteManagerOptions` don't declare the field until Tasks 2/3 — passing it in Task 1 would fail TypeScript's excess-property check on the object literal, breaking Task 1's own `pnpm compile` verification step.
- **Fix:** Task 1 only threaded `verifyEvent` into `KeyPackageManager` (whose option field is added in Task 1 itself); the `new GroupsManager({...})`/`new InviteManager({...})` calls were updated in Tasks 2/3 respectively, alongside their option-type additions.
- **Files modified:** `src/client/marmot-client.ts` (touched again in Tasks 2 and 3)
- **Verification:** `pnpm compile` passes after every task's commit.
- **Committed in:** `e3d099d`, `46f92dd`, `9210f12`

**2. [Rule 1 - Bug] Added safeVerifyEvent() to catch exceptions thrown by the underlying verifier on malformed events**

- **Found during:** Task 3
- **Issue:** Adding the outer-verify gate to `InviteManager.ingestEvent` broke 5 pre-existing tests with an unhandled `"can't serialize event with wrong or missing properties"` exception. Applesauce's `verifyEvent` (from `nostr-tools/pure`) calls `getEventHash(event)` outside its own try/catch — that call throws when the event can't be serialized (e.g. a non-hex `pubkey`), and only the later Schnorr-verify step is defensively wrapped. The same root cause silently applied to the 445 drain committed in Task 2, just not exercised by that task's test fixtures (which all had well-formed shapes).
- **Fix:** Added `safeVerifyEvent(verify, event)` to `src/client/verify.ts`, wrapping any `VerifyEventMethod` call in try/catch and treating a thrown error as `false` (reject). Used it at both the `GroupsManager` drain (Task 2's code) and the `InviteManager.ingestEvent` gate (Task 3's code).
- **Files modified:** `src/client/verify.ts`, `src/client/groups-manager.ts`, `src/client/invite-manager.ts`
- **Verification:** Full suite green (619/619); no unhandled rejections in the vitest run.
- **Committed in:** `9210f12` (also amends Task 2's already-committed drain code, since the fix addresses the same shared root cause)

**3. [Rule 3 - Blocking] Relaxed getSingletonTagValue/getListTag's parameter type from NostrEvent to a generic tagged-object bound**

- **Found during:** Task 3
- **Issue:** `pnpm compile` failed with `Property 'sig' is missing in type 'Rumor' but required in type 'NostrEvent'` at all three `welcome-event.ts` call sites — `getSingletonTagValue`/`getListTag` (created in 02-01) were typed against `NostrEvent` only, but `getWelcomeKeyPackageEventId`/`getWelcome`/`getWelcomeGroupRelays` operate on the unsigned `Rumor` type (no `sig`/`id` fields).
- **Fix:** Changed both functions' signatures to `<T extends { tags: string[][] }>(event: T, name: string)`, mirroring the existing `getTagValue` helper's own generic constraint in `applesauce-core/helpers/event`. Behavior is unchanged for `NostrEvent` callers (445/1059 sites); the constraint is now structurally satisfied by `Rumor` too.
- **Files modified:** `src/utils/tag-cardinality.ts`
- **Verification:** `pnpm compile` passes; `src/utils/__tests__/tag-cardinality.test.ts` (02-01's own suite) still passes unchanged (12/12).
- **Committed in:** `9210f12`

**4. [Rule 1 - Bug] Injected fakeVerifyEvent into invite-manager.test.ts's shared beforeEach**

- **Found during:** Task 3
- **Issue:** Adding the outer-verify gate broke 13 of the file's 19 pre-existing tests. `createMockGiftWrap` builds kind-1059 events with a hardcoded `sig: "signature"` literal and non-hex `pubkey` — never real signatures. The default (real) verifier correctly rejects them, but these tests exercise storage/seen-tracking/watch-generator behavior unrelated to signature verification.
- **Fix:** Injected `verifyEvent: fakeVerifyEvent` into the file's shared `beforeEach`-constructed `InviteManager`, preserving the trust-upstream testing intent those tests always had. Added a new, separate "trust boundary (SEC-01)" describe block using dedicated `InviteManager` instances (one default-verifier, one `fakeVerifyEvent`) against genuinely signed events to test the new gate itself.
- **Files modified:** `src/client/__tests__/invite-manager.test.ts`
- **Verification:** `pnpm vitest run src/client/__tests__/invite-manager.test.ts` — 21/21 pass (19 pre-existing + 2 new).
- **Committed in:** `9210f12`

---

**Total deviations:** 4 auto-fixed (2 blocking compile/wiring fixes, 1 bug fix shared across two entry points, 1 test-fixture fix necessitated by the new gate)
**Impact on plan:** All four were required to keep each task's own verification (`pnpm compile` / `pnpm vitest run`) green while implementing exactly what the plan specified; none expand the plan's scope beyond its stated `files_modified` list plus the two shared primitive files (`verify.ts`, `tag-cardinality.ts`) that both entry points' gates depend on.

## Issues Encountered

- A subtle test-authoring trap: `finalizeEvent` (used to build a "real" 445/1059 event) caches `event[verifiedSymbol] = true` on the event it just signed. A naive `{ ...real, sig: "corrupted" }` object spread copies that own enumerable symbol property along with the other fields, silently short-circuiting `defaultVerifyEvent` back to `true` regardless of the corrupted signature. Both `groups-manager.test.ts` and `invite-manager.test.ts`'s corruption helpers explicitly `delete corrupted[verifiedSymbol]` after spreading, documented inline, to force a real re-verification.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-01 is closed for the 445 and 1059 entry points; WIRE-02 is closed for 445 `h` and 444 `e`/`relays`. Plan 02-03 remains: the 30443 KeyPackage boundary (SEC-01's third entry point) and WIRE-01's inbound-reject side (capped/backdated lifetime enforcement on receipt, not just produce).
- `KeyPackageManager` already has `verifyEvent` threaded and stored (`#verifyEvent`, plumbing only) — 02-03 wires it into the actual 30443 gate (`track()`/`addPublished()`) without needing to touch `marmot-client.ts` again.
- `safeVerifyEvent()` is available in `verify.ts` for 02-03 to reuse at the 30443 call site — any injected verifier should be called through it, not directly, to avoid reintroducing the same throw-on-malformed-event gap.
- Full test suite (619 tests, 68 files) and `pnpm compile` both pass clean; no `src/engine/**` changes (confirmed via `git diff --name-only`); `pnpm lint` shows zero warnings on any `src/` file (all warnings are pre-existing, in the vendored `refs/mdk/` Rust build artifacts, unrelated to this plan).
- **REQUIREMENTS.md traceability note:** SEC-01 and WIRE-02 checkboxes remain `[ ]` (Pending) after this plan — 02-03 also declares these plus WIRE-01 in its frontmatter. Mark complete only once 02-03 lands (same pattern 02-01 established).

---

_Phase: 02-inbound-trust-wire-boundary_
_Completed: 2026-07-22_

## Self-Check: PASSED

All 10 modified files and 3 task-commit hashes verified present on disk / in git history.
