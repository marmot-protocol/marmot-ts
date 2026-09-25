---
phase: 10-founding-group-creation-via-welcome
plan: 02
subsystem: client-transport
tags: [welcome-delivery, nip-59, fanout, per-recipient-outcomes, runtime]

# Dependency graph
requires: []
provides:
  - "NostrWelcomeDelivery.deliverMany() — the shared, non-throwing, per-recipient Welcome fanout (D-06/D-07)"
  - "WelcomeDeliveryOutcome discriminated union (succeeded | failed), each carrying its recipient"
  - "WelcomeFanoutOutcome on GroupPublishResult.welcomeDelivery (notRequired | attempted{outcomes})"
  - "GroupRuntime.#deliverWelcomes() rewritten as a thin, non-throwing deliverMany() caller"
affects: [10-03-PLAN.md]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-recipient fanout lives on the transport class (NostrWelcomeDelivery), reachable by both GroupRuntime and (plan 10-03) GroupFactory via group.runtime.welcomeDelivery — one implementation, no new plumbing"
    - "Never-throw, never-aggregate per-recipient outcome unions (WelcomeDeliveryOutcome / WelcomeFanoutOutcome) mirror AncillaryEffectOutcome's literal-union convention"

key-files:
  created:
    - src/client/transport/nostr/__tests__/welcome-delivery.test.ts
  modified:
    - src/client/transport/nostr/welcome-delivery.ts
    - src/client/session/group-effects.ts
    - src/client/runtime/group-runtime.ts
    - src/client/runtime/__tests__/group-runtime.test.ts

key-decisions:
  - "deliverMany() is purely additive on welcome-delivery.ts — deliver()'s existing empty-relay-list throw and its other contracts are byte-for-byte unchanged, verified via a zero-context diff against the pre-plan base"
  - "Test 2 (one succeeded, one failed) uses a network double whose getUserInboxRelays RESOLVES empty for the second recipient rather than REJECTS, with a non-empty groupRelays shared by the whole deliverMany call — createWelcomeRumor requires a non-empty relays tag for every recipient in a call, so a globally-empty groupRelays (as the plan's action text literally suggested) would make the reachable recipient fail too, not just the unreachable one"

patterns-established:
  - "Per-recipient fallible outcomes are literal unions carrying their own `recipient`, never a record keyed by pubkey or a null|result shape"

requirements-completed: [FOUND-04]

# Metrics
duration: ~25min
completed: 2026-09-25
status: complete
---

# Phase 10 Plan 02: Shared Welcome Fanout (deliverMany) Summary

**`NostrWelcomeDelivery.deliverMany()` — a shared, non-throwing, per-recipient Welcome fanout replacing `GroupRuntime`'s private aggregate-throw loop, with `GroupPublishResult.welcomeDelivery` reshaped to carry one outcome per invitee.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-25T02:38:23Z
- **Tasks:** 3
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- `NostrWelcomeDelivery.deliverMany()` is the one shared Welcome fanout implementation (D-07), reachable today by `GroupRuntime` (ordinary invite) and, per plan 10-03, by `GroupFactory` via `group.runtime.welcomeDelivery` — no new plumbing.
- The fanout never throws and never aggregates: each recipient's settled `deliver()` result maps to exactly one `WelcomeDeliveryOutcome` entry (`succeeded` | `failed`), in the order recipients were supplied.
- `GroupPublishResult.welcomeDelivery` is now `WelcomeFanoutOutcome` (`notRequired` | `attempted{ outcomes }`), giving ordinary invite the same per-recipient granularity FOUND-04 requires for founding create.
- `GroupRuntime.#deliverWelcomes()` is a thin, non-throwing `deliverMany()` caller with a defensive catch (an unexpected `deliverMany` throw still cannot reject a confirmed, persisted publish).
- The one test file in R-03's blast radius (`group-runtime.test.ts`) was migrated deliberately: its fixture's `welcomeDelivery` stub gained a `deliverMany` that reproduces real per-recipient semantics by delegating to the existing `deliver` mock, and the aggregate-shape assertion was rewritten to the new per-recipient shape with its original intent (one of two recipients fails, independently reported, confirmed state preserved) intact — no assertion was loosened.

## Task Commits

Each task was committed atomically:

1. **Task 1: deliverMany() on NostrWelcomeDelivery, plus its first unit tests** - `679bb1d` (feat)
2. **Task 2: Per-recipient welcomeDelivery on GroupPublishResult and the runtime fanout rewrite** - `ba57071` (feat)
3. **Task 3: Deliberate R-03 migration of the runtime Welcome tests** - `2be3b75` (test)

## Files Created/Modified

- `src/client/transport/nostr/welcome-delivery.ts` - Adds `WelcomeDeliveryOutcome`, `DeliverManyWelcomesOptions`, and `NostrWelcomeDelivery.deliverMany()`, purely additive
- `src/client/transport/nostr/__tests__/welcome-delivery.test.ts` - New unit test file (first for this class): success/failure mapping, empty-recipient-list, per-recipient gift-wrap addressing, `deliver()`'s unchanged single-recipient throw contract
- `src/client/session/group-effects.ts` - Adds `WelcomeFanoutOutcome`; `GroupPublishResult.welcomeDelivery` retyped from `AncillaryEffectOutcome` to `WelcomeFanoutOutcome`
- `src/client/runtime/group-runtime.ts` - `#deliverWelcomes()` rewritten to call `this.welcomeDelivery.deliverMany()` and return `WelcomeFanoutOutcome`, never throwing; `#publishCommitResult`'s welcome try/catch collapses to a direct call
- `src/client/runtime/__tests__/group-runtime.test.ts` - `makeRuntime()`'s fixture and the "GroupRuntime Welcome delivery" describe block migrated to the new interface/shape (R-03)

## Decisions Made

- **Task 1 setup deviation (execution-level, not a plan decision):** the plan's Test 2 action text says to pass an empty `groupRelays` while making `getUserInboxRelays` reject for the second recipient, "so the fallback is empty too." Tracing `deliver()`'s actual code path shows `createRumor()` (which needs a non-empty `groupRelays` for the rumor's `relays` tag) runs unconditionally, before any inbox-relay resolution, and consumes the *same* `groupRelays` value shared across every recipient in one `deliverMany()` call. An empty `groupRelays` for the whole call would make `createWelcomeRumor` throw for the reachable recipient too, contradicting "one succeeded and one failed." Implemented instead with a non-empty `groupRelays` (satisfying `createRumor` for both recipients) and a network double whose `getUserInboxRelays` *resolves* `[]` (rather than rejecting) for the second recipient — this exercises the identical `deliver()` throw ("No relays available...") without touching `deliver()`/`createWelcomeRumor()`, which Task 1 explicitly forbids modifying. No production code changed as a result; this only affects test setup.
- Everything else executed exactly as planned: `WelcomeDeliveryOutcome`/`WelcomeFanoutOutcome` shapes, field names, and `deliverMany()`'s signature match the plan's interfaces verbatim.

## Deviations from Plan

None requiring the Rule 1-4 protocol — the one setup adjustment above is a test-construction detail necessitated by tracing `deliver()`'s actual (unmodified) code path, not a change to planned behavior, an auto-fix, or an architectural decision.

### Acceptance-criteria grep precision notes (not deviations, documented for the verifier)

Two of the plan's grep-based acceptance criteria are sensitive to unrelated, pre-existing content and would misreport if run exactly as literally written with default `git diff` context:

1. **Task 2:** `git diff src/client/session/group-effects.ts | grep -c 'GroupPublishWork'` returns `2`, not `0`. Both hits are unchanged context lines (`export type GroupPublishWork =` and `work: GroupPublishWork;`) pulled into the diff's default 3-line context window by an adjacent edit (the new `WelcomeDeliveryOutcome` type import). Verified precisely with `git diff --unified=0 ... | grep -c 'GroupPublishWork'` → `0`: no `+`/`-` line touches `GroupPublishWork` anywhere. `GroupPublishWork` itself is untouched, matching D-05's intent.
2. **Task 3:** `grep -v '^\s*\*' ... | grep -v '^\s*//' | grep -c 'toBeDefined'` returns `1`, not `0`. The one hit (`expect(failed).toBeDefined();`) is a pre-existing assertion in the unrelated, unmodified "executes the pinned invite-publish-fail rollback before Welcome delivery" test — it checks that a fixture-derived scenario step was found, not a `welcomeDelivery` assertion, and predates this plan. Per the scope boundary ("only auto-fix issues directly caused by the current task's changes"), this line was left as-is rather than edited solely to satisfy a grep that was written to catch a loosened `welcomeDelivery` assertion specifically — no `welcomeDelivery` assertion in the migrated block uses `toBeDefined()`.

Both invariants the criteria intend to protect (GroupPublishWork not reshaped; no welcomeDelivery assertion loosened) hold true, verified above by more precise checks.

## Issues Encountered

None beyond the Test 2 construction detail documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `deliverMany()` and `WelcomeDeliveryOutcome` are in place exactly as plan 10-03 expects to import them (`src/client/transport/nostr/welcome-delivery.ts`).
- Verified via full suite: `pnpm vitest run src/client/ src/engine/` → 50 files, 457 tests, all passing.
- `pnpm compile` and `tsc --noEmit -p tsconfig.json` (full project including tests) both exit 0.
- No blockers for plan 10-03 (founding orchestration in `GroupFactory.create()`).

---
*Phase: 10-founding-group-creation-via-welcome*
*Completed: 2026-09-25*

## Self-Check: PASSED

- FOUND: src/client/transport/nostr/welcome-delivery.ts
- FOUND: src/client/transport/nostr/__tests__/welcome-delivery.test.ts
- FOUND: src/client/session/group-effects.ts
- FOUND: src/client/runtime/group-runtime.ts
- FOUND: src/client/runtime/__tests__/group-runtime.test.ts
- FOUND: .planning/phases/10-founding-group-creation-via-welcome/10-02-SUMMARY.md
- FOUND commit: 679bb1d
- FOUND commit: ba57071
- FOUND commit: 2be3b75
