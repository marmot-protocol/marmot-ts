---
status: resolved
trigger: "Diagnose and fix the two Wave 2 failures in src/engine/__tests__/state-notification-withdrawal.test.ts: clearing persisted removed-inactive marker on ingest stateInvalidated/selfRemoved withdrawal and on reconverge selfRemoved withdrawal. Plan 03.1-06 namespaced durable removal markers; likely clear paths still use legacy key. Preserve plan 03.1-06 contract and tests, do not undo namespacing."
created: 2026-09-02T14:37:46Z
updated: 2026-09-02T14:41:20Z
---

## Current Focus

reasoning_checkpoint:
  hypothesis: the two tests fail because their fixture seeds and checks the deprecated bare `groupId` key, while `MarmotGroup` correctly clears only the durable namespaced `${groupId}/removed` key required by Plan 03.1-06
  confirming_evidence:
    - the focused run deterministically fails only the two assertions reading the bare `idHex` key, each receiving the seeded `true`
    - all production marker operations share `#removedMarkerKey`, which resolves `${this.idStr}/removed`
    - Plan 03.1-06 explicitly forbids legacy bare-key migration and requires only namespaced marker clearing
  falsification_test: seed `${idHex}/removed`; if ingest/reconverge leaves that key true, then the production withdrawal clear path is defective and the fixture-key hypothesis is false
  fix_rationale: updating both fixtures to seed and assert the namespaced key makes them exercise the current durable-storage contract without weakening their withdrawal-path assertions
  blind_spots: the tests mock session result production, so they verify MarmotGroup wiring but not real engine derivation; preceding tests already cover real withdrawal derivation and Plan 03.1-06 integration tests cover namespace collision
  candidate_causes:
    - code: stale test fixture key did not follow the namespacing contract introduced by Plan 03.1-06
    - config: no environment or runtime configuration selects marker keys; the injected store is key-agnostic
  and_gate: no — the stale fixture key alone fully explains both deterministic failures across the same runtime and data
next_action: parent agent reviews the atomic commit and accepts the verified Wave 2 correction

## Symptoms

expected: persisted removed-inactive marker is cleared when ingest withdraws stateInvalidated/selfRemoved and when reconverge withdraws selfRemoved
actual: two Wave 2 tests report that the persisted removed-inactive marker remains
errors: focused failures in state-notification-withdrawal.test.ts
reproduction: run pnpm vitest run src/engine/__tests__/state-notification-withdrawal.test.ts
started: after Plan 03.1-06 namespaced durable removal markers

## Eliminated

## Evidence

- timestamp: 2026-09-02T14:37:46Z
  checked: Plan 03.1-06 plan and summary
  found: D-14 explicitly requires every marker read/write/clear to use `${groupId}/removed` and forbids legacy bare-key migration
  implication: changing production to clear the bare key would violate the preserved contract

- timestamp: 2026-09-02T14:37:46Z
  checked: src/client/group/marmot-group.ts marker operations
  found: `#removedMarkerKey` returns `${this.idStr}/removed`; realization reads/writes it and `#clearRemovalMarker` removes it
  implication: the production clear path is already internally consistent with the namespaced contract

- timestamp: 2026-09-02T14:37:46Z
  checked: two Wave 2 tests
  found: both seed and assert `idHex`, the deprecated bare key, rather than `${idHex}/removed`
  implication: test fixtures still encode the legacy storage contract and cannot observe the intended namespaced clear

- timestamp: 2026-09-02T14:39:00Z
  checked: focused one-shot Vitest run with frozen/offline pnpm and lock hash guards
  found: exactly 2 of 13 tests failed; each read the seeded bare `idHex` marker as `true`; the other 11 passed
  implication: the failure is deterministic (bohrbug) and localized to the two stale fixture keys

- timestamp: 2026-09-02T14:41:00Z
  checked: corrected fixture focused run
  found: all 13 tests passed when both fixtures seeded and asserted `${idHex}/removed`
  implication: production ingest and reconverge withdrawal paths both clear the durable namespaced marker

- timestamp: 2026-09-02T14:41:00Z
  checked: revert-and-reconfirm
  found: restoring the bare fixture key reproduced exactly the same two failures; reapplying the namespaced fixture correction restored the intended test setup
  implication: the fixture correction is causally sufficient and minimal

## Resolution

root_cause: both Wave 2 tests retained the legacy bare group-id marker fixture after Plan 03.1-06 changed the durable contract to `${groupId}/removed`; production correctly refuses to clear the bare key
fix: update the two withdrawal test fixtures to seed and assert `${groupId}/removed`, preserving the Plan 03.1-06 namespace contract
verification:
  target_test: { result: pass }
  mutation_check: { result: skipped, reason_if_skipped: no Stryker configuration or dependency is present; change is fixture-key setup rather than production behavior }
  no_op_deletion: { result: pass, deletion_justified_by_rca: false }
  adjacent_tests: { result: pass, suites_run: [src/__tests__/integration/removed.test.ts, pnpm compile] }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true }
  guardrail_verdict: accepted
files_changed: [src/engine/__tests__/state-notification-withdrawal.test.ts]
