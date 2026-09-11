---
phase: 04-feature-parity-conformance-vectors
plan: 06
subsystem: testing
tags: [conformance, mls, fixtures, deterministic-runner, snapshots]
requires:
  - phase: 04-01..04-05
    provides: SafeAAD, durable convergence evidence, recovery anchors, and bounded scheduling
provides:
  - Strict MDK manifest validation with root-contained executable artifacts
  - Canonical live MLS snapshot including GroupContext and exporter commitments
  - Production-backed deterministic scenario subject with explicit capability refusal
affects: [04-07, CONF-01, portable-vectors]
tech-stack:
  added: []
  patterns: [test-only capability boundary, canonical protocol projection]
key-files:
  created:
    - src/__tests__/conformance/manifest.ts
    - src/__tests__/conformance/snapshot.ts
    - src/__tests__/conformance/subject.ts
    - src/__tests__/conformance/runner.ts
    - src/__tests__/conformance/adapter.test.ts
  modified:
    - ts-mls/src/index.ts
    - src/__tests__/helpers/mock-network.ts
key-decisions:
  - "Only scenario_vector records expose loadable artifacts; inventory records that reference Rust/formal sources remain descriptive and cannot escape the vectors root through this adapter."
  - "Canonical equality hashes the public ts-mls GroupContext encoder output and commits to an MLS exporter secret without exposing the secret."
  - "The scenario subject composes MarmotGroup and MockNetwork instead of duplicating protocol behavior."
patterns-established:
  - "Conformance operations declare a capability before execution and return a typed unsupported result containing the upstream scenario id."
  - "Stable scenario input order is retained while set-like capabilities, gates, and dictionary entries are canonically sorted."
requirements-completed: [CONF-01]
coverage:
  - id: D1
    description: Strict pinned-manifest loader and exhaustive canonical MLS state projection
    requirement: CONF-01
    verification:
      - kind: integration
        ref: src/__tests__/conformance/adapter.test.ts#strictly validates and projects live MLS state
        status: pass
    human_judgment: false
  - id: D2
    description: Production-backed deterministic subject with queue, time, restart, and unsupported-capability behavior
    requirement: CONF-01
    verification:
      - kind: integration
        ref: src/__tests__/conformance/adapter.test.ts#drives production groups
        status: pass
    human_judgment: false
duration: 7min
completed: 2026-09-05
status: complete
---

# Phase 04 Plan 06: Conformance Adapter Summary

**Strict MDK fixture loading, cryptographically canonical live-state snapshots, and a deterministic production `MarmotGroup` scenario boundary**

## Performance

- **Duration:** 7 min
- **Started:** 2026-09-05T15:47:00Z
- **Completed:** 2026-09-05T15:54:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Exported the existing `groupContextEncoder` through the public `ts-mls` root using a focused submodule commit and parent pointer update.
- Added strict manifest validation and path containment, plus an exhaustive canonical snapshot derived from real MLS state and cryptography.
- Added deterministic production-group scenario execution, restart serialization, virtual time, queued transport fault controls, and explicit unsupported-capability reporting.

## Task Commits

1. **Task 1: Validate the manifest and canonical snapshot projection** - `bb425f6`, `c790181`
2. **Task 2: Drive production clients through a capability-declared deterministic subject** - `fc21f50`

The nested `ts-mls` source commit is `af6d1c5`.

## Files Created/Modified

- `src/__tests__/conformance/manifest.ts` - Strict manifest contracts and safe artifact resolution.
- `src/__tests__/conformance/snapshot.ts` - Canonical protocol-state projection and validator.
- `src/__tests__/conformance/subject.ts` - Production-backed capability-declared adapter.
- `src/__tests__/conformance/runner.ts` - Stable sequential scenario runner.
- `src/__tests__/conformance/adapter.test.ts` - Live crypto, loader, restart, deadline, delivery, and refusal tests.
- `src/__tests__/helpers/mock-network.ts` - Deterministic queued delivery/fault controls.
- `ts-mls/src/index.ts` - Public `groupContextEncoder` export.

## Decisions Made

- Non-scenario manifest inventory may describe artifacts outside `vectors/`, but the adapter only resolves executable `scenario_vector` artifacts and always confines those beneath the pinned root.
- Application output and input disposition arrays preserve semantic scenario order; set-like data is sorted before comparison.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Distinguished executable vectors from inventory-only manifest records**

- **Found during:** Task 1 manifest test
- **Issue:** The upstream manifest includes Rust-only/formal inventory entries without artifacts and one formal path outside `vectors/`; treating every entry as executable either rejected the pinned manifest or permitted unsafe resolution.
- **Fix:** Validate all known record shapes strictly, but resolve and expose paths only for `scenario_vector` entries, retaining root containment for executable fixtures.
- **Files modified:** `src/__tests__/conformance/manifest.ts`
- **Verification:** Adapter test accepts the pinned manifest while rejecting absolute and traversal paths.
- **Committed in:** `c790181`

**Total deviations:** 1 auto-fixed (Rule 1 bug). **Impact on plan:** Required to model the upstream manifest faithfully without weakening the executable fixture trust boundary.

## Issues Encountered

- The nested `ts-mls` repository lacked local author identity. It was configured from the superproject's existing repository-local identity; no global configuration changed.

## TDD Gate Compliance

- Behavior tests and implementation landed together in the task feature commits rather than separate RED/GREEN commits. All specified behavioral and plan-level verification commands pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plan 04-07 can map the portable MDK corpus onto this adapter and compare snapshots without adding fixture-specific protocol rules.

## Self-Check: PASSED

- All five created conformance files exist.
- Superproject commits `bb425f6`, `c790181`, and `fc21f50` and submodule commit `af6d1c5` exist.
- Adapter tests, `ts-mls` build, and library compile pass.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
