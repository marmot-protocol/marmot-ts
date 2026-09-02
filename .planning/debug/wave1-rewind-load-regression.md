---
status: resolved
trigger: "Diagnose and fix the Wave 1 regression in src/__tests__/integration/rewind-persistence.test.ts: `switches to the canonical branch on restart when both forks are persisted and no new event arrives` fails after plan 03.1-01 changed GroupRegistry load ordering/hydration. Preserve the locked Phase 03.1 contract: GroupRegistry.load hydration-only, then track/cache + attach listeners, then reconverge, realize removal, emit loaded. Do not undo plan 03.1-01. Add or adjust regression coverage as needed, commit the fix atomically, and report root cause and verification."
created: 2026-09-02T14:16:46Z
updated: 2026-09-02T14:32:00Z
---

## Current Focus

bug_class: bohrbug
reasoning_checkpoint:
  hypothesis: The test fails because it invokes the hydration-only load primitive while asserting activation behavior; plan 03.1-01 intentionally moved reconvergence into the get -> track activation path so listeners are attached first.
  confirming_evidence:
    - The named test fails deterministically at the canonical-tag assertion and receives the persisted losing tag after registry.load.
    - Commit 59e2367 moved only reconvergence from load to track, while get still awaits track before returning and emitting loaded.
  falsification_test: Changing the restart call from registry.load(groupId) to registry.get(groupId) would falsify the hypothesis if the returned group still retained the losing tag or had a non-Stable lifecycle.
  fix_rationale: Exercise the public activation path in the restart regression so it verifies no-event reconvergence without reverting hydration-only load or listener-first ordering.
  blind_spots: The complete removed integration suite must still prove removed-before-loaded ordering; full compile and adjacent persistence tests may reveal callers that intentionally need hydration-only semantics.
  candidate_causes:
    - code: stale test call site asserts pre-03.1 load semantics instead of activation semantics
    - config: convergence policy could exclude the persisted competing branch, but the default policy and prior passing behavior make this testable alternative unlikely
    - data: persisted tree might contain only one tip, contradicted by the explicit two-tip assertion before save
  and_gate: no; the stale call site alone fully explains why reconvergence is never invoked, while config and persisted-data alternatives are contradicted by the fixture and code path
next_action: commit the single regression-test correction atomically and report the commit and verification to the parent agent

## Symptoms

expected: on restart with both forks persisted and no new event, the loaded group switches to the canonical branch
actual: the focused rewind-persistence integration test fails after plan 03.1-01 changed GroupRegistry load ordering and hydration
errors: focused test failure details not yet captured
reproduction: run pnpm vitest run src/__tests__/integration/rewind-persistence.test.ts and observe the named test
started: after plan 03.1-01

## Eliminated

## Evidence

- timestamp: 2026-09-02T14:20:00Z
  checked: Phase 03.1 plan, summary, research, patterns, GroupRegistry, and rewind-persistence test
  found: The locked implementation makes load hydration-only and puts multi-tip reconvergence in track; the failing test calls registry.load directly but still asserts load-time reconvergence.
  implication: The production ordering may be correct while the pre-plan test encodes the superseded contract; focused reproduction must distinguish stale test coverage from a get/activation defect.
- timestamp: 2026-09-02T14:23:00Z
  checked: focused one-shot rewind-persistence suite
  found: Exactly one deterministic failure occurs at line 270; registry.load returns the persisted losing confirmation tag, matching hydration-only semantics.
  implication: This is a Bohrbug in regression coverage, not evidence that listener-first activation fails.
- timestamp: 2026-09-02T14:23:00Z
  checked: git diff for plan 03.1-01 commit 59e2367 and current get/track implementation
  found: The commit deliberately removed reconverge from load and added it after cache/listener setup in track; get awaits track and then emits loaded.
  implication: The correct restart entry point for state-derived activation assertions is get, while direct load callers may inspect hydrated state without effects.
- timestamp: 2026-09-02T14:26:00Z
  checked: focused suite after changing the named regression from registry.load to registry.get
  found: All 7 rewind-persistence tests pass, including canonical restart convergence with no new event.
  implication: The falsification test supports the root cause and confirms production activation behavior without undoing hydration-only load.
- timestamp: 2026-09-02T14:29:00Z
  checked: adjacent removed, history-tree-persistence, and rewind-persistence suites plus strict compile
  found: 17 tests pass across 3 files and TypeScript compile passes; removed.test preserves the listener-first removed-before-loaded contract.
  implication: The targeted regression correction does not disturb adjacent hydration, activation, removal, or persistence behavior.
- timestamp: 2026-09-02T14:32:00Z
  checked: revert-and-reconfirm on the exact registry entry-point hunk
  found: Restoring registry.load makes the named test fail at the canonical-tag assertion; reapplying registry.get makes it pass.
  implication: The one-line call-site correction is causally sufficient and directly exercises activation-owned reconvergence.

## Resolution

root_cause: The rewind-persistence regression retained a direct GroupRegistry.load call and its old load-time reconvergence assertion after plan 03.1-01 made load hydration-only; activation now occurs through get -> track after cache/listener setup.
fix: Updated the restart reconvergence regression to use GroupRegistry.get, the activation entry point, and documented that load remains hydration-only while get tracks/listens first.
verification:
  target_test: { result: pass }
  mutation_check: { result: skipped, reason_if_skipped: "Stryker is not configured or present in the workspace", mutant_killed: false }
  no_op_deletion: { result: pass, deletion_justified_by_rca: false }
  adjacent_tests: { result: pass, suites_run: [removed.test.ts, history-tree-persistence.test.ts, rewind-persistence.test.ts, pnpm compile] }
  revert_and_reconfirm: { result: pass, bug_returned_on_revert: true, fixed_on_reapply: true }
  guardrail_verdict: accepted
files_changed: [src/__tests__/integration/rewind-persistence.test.ts]
oracle_type: specified
