---
phase: 04-feature-parity-conformance-vectors
plan: 01
subsystem: protocol-wire
tags: [mls, app-components, safe-aad, nostr-routing, mdk-fixtures]

requires:
  - phase: 03-commit-integrity-convergence-parity
    provides: App-component integrity validation and production KeyPackage paths
provides:
  - Reference-compatible SafeAAD advertisement on every production LeafNode and KeyPackage
  - Group-state rejection for unsupported SafeAAD framing
  - MDK nostr-routing state, update, and malformed-byte regression coverage
affects: [04-02-own-commit-stamp, conformance-vectors, key-packages]

tech-stack:
  added: []
  patterns: [pinned upstream JSON fixtures, leaf-only app-component advertisement]

key-files:
  created:
    - src/core/components/__tests__/nostr-routing.test.ts
  modified:
    - src/core/components/ids.ts
    - src/core/components/dictionary.ts
    - src/core/components/__tests__/dictionary.test.ts
    - src/__tests__/exports.test.ts
    - refs/mdk

key-decisions:
  - "Encode SafeAAD's empty supported-component set as the canonical one-byte empty vector (00), matching MDK."
  - "Reject SafeAAD in the generic GroupContext dictionary builder while constructing the leaf dictionary through the lower-level sorted dictionary codec."
  - "Statically import pinned MDK JSON fixtures in test-only code so Vitest, Deno, and Bun can consume the same corpus without Node filesystem APIs."

patterns-established:
  - "Leaf-only protocol components are built through a dedicated leaf builder and rejected by the group-state builder."
  - "Upstream fixture_name values remain unchanged as Vitest identifiers for direct failure correlation."

requirements-completed: [WIRE-04, CONF-01]

coverage:
  - id: D1
    description: "Production KeyPackages carry the MDK-compatible app_components and SafeAAD leaf dictionary bytes."
    requirement: WIRE-04
    verification:
      - kind: integration
        ref: "src/core/components/__tests__/dictionary.test.ts#matches the MDK leaf dictionary bytes through a real KeyPackage"
        status: pass
    human_judgment: false
  - id: D2
    description: "SafeAAD remains leaf-only and is rejected as GroupContext component state."
    requirement: WIRE-04
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/dictionary.test.ts#rejects SafeAAD as group-component state"
        status: pass
    human_judgment: false
  - id: D3
    description: "MDK nostr-routing valid-state, valid-update, and duplicate-relay fixtures execute against production codecs."
    requirement: CONF-01
    verification:
      - kind: integration
        ref: "src/core/components/__tests__/nostr-routing.test.ts#MDK nostr-routing byte fixtures"
        status: pass
    human_judgment: false

duration: 18min
completed: 2026-09-05
status: complete
---

# Phase 4 Plan 1: SafeAAD and Routing Fixture Tracer Summary

**Reference-compatible SafeAAD LeafNode dictionaries and immutable MDK nostr-routing fixtures now exercise production wire codecs byte-for-byte.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-09-05T14:33:13Z
- **Completed:** 2026-09-05T14:48:05Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Added `SAFE_AAD_COMPONENT_ID` and emitted the exact sorted MDK leaf dictionary from every production KeyPackage path.
- Kept SafeAAD out of group state with an explicit rejection at the GroupContext dictionary builder.
- Loaded all three pinned MDK nostr-routing fixtures and proved valid byte round-trips plus duplicate-relay rejection through production codecs.
- Verified the exact CI pnpm 10.18.3 launcher and preserved the validated frozen lockfile digest.

## Task Commits

Each task was committed atomically:

1. **Reference prerequisite: fast-forward MDK submodule** - `acfead6` (chore)
2. **Task 0: Normalize execution to the CI pnpm 10 toolchain** - `1103ea9` (chore)
3. **Task 1 RED: Add failing SafeAAD production-path tests** - `d5abfb4` (test)
4. **Task 1 GREEN: Generate the reference-compatible leaf dictionary** - `2fa3086` (feat)
5. **Task 2: Run MDK nostr-routing byte fixtures** - `f414618` (test)
6. **Integration fix: Add SafeAAD to the deliberate root export snapshot** - `19a3a1f` (fix)

## Files Created/Modified

- `src/core/components/ids.ts` - Registers the upstream SafeAAD component identifier.
- `src/core/components/dictionary.ts` - Builds the reference leaf dictionary and rejects SafeAAD group state.
- `src/core/components/__tests__/dictionary.test.ts` - Pins real-KeyPackage extension bytes and leaf/group boundaries.
- `src/core/components/__tests__/nostr-routing.test.ts` - Runs three immutable MDK fixtures through production codecs.
- `src/__tests__/exports.test.ts` - Pins the newly public SafeAAD component identifier in the root API surface.
- `refs/mdk` - Fast-forwarded the required reference submodule; no byte-fixture or SafeAAD contract changed.

## Decisions Made

- SafeAAD data is `encodeComponentsList([])`, producing canonical `00`, exactly as MDK does.
- `APP_COMPONENTS_COMPONENT_ID` is inserted into the advertised list by the shared leaf builder, so callers cannot omit the self-advertisement.
- The generic group extension builder rejects SafeAAD instead of admitting state that would require unsupported SafeAAD-framed authenticated data.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Fast-forwarded the MDK reference before phase execution**

- **Found during:** Phase-start reference check
- **Issue:** `refs/mdk` was ten commits behind `origin/HEAD`; AGENTS.md requires checking and updating both reference submodules at every phase start.
- **Fix:** Inspected the upstream diff, confirmed the pinned byte fixtures and SafeAAD/routing contract were unchanged, then fast-forwarded the submodule pointer.
- **Files modified:** `refs/mdk`
- **Verification:** `git -C refs/mdk log HEAD..origin/HEAD` is empty after update.
- **Committed in:** `acfead6`

**2. [Rule 1 - Bug] Updated the deliberate root export snapshot for SafeAAD**

- **Found during:** Post-wave integration verification
- **Issue:** Exporting `SAFE_AAD_COMPONENT_ID` through the existing component barrel changed the root package surface, but the exact inline export snapshot still described the prior surface.
- **Fix:** Added only `SAFE_AAD_COMPONENT_ID` at its sorted position in the expected root exports.
- **Files modified:** `src/__tests__/exports.test.ts`
- **Verification:** Focused export tests and the complete 786-test Vitest suite pass.
- **Committed in:** `19a3a1f`

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** The source-of-truth reference is current and the root public API contract now reflects the planned export; no unrelated snapshots changed.

## Issues Encountered

- Task 2's new conformance tests passed on their first execution because the production routing codec already implemented the required behavior. The task adds permanent upstream-backed evidence and required no production-code GREEN change.

## TDD Gate Compliance

- Task 1 completed a distinct RED (`d5abfb4`) then GREEN (`2fa3086`) sequence.
- Task 2 is test-only fixture integration; its first run passed against the existing production codec, so no artificial failing test or production change was introduced.

## Known Stubs

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `CI=true npx --yes pnpm@10.18.3 vitest run src/core/components/__tests__/dictionary.test.ts src/core/components/__tests__/nostr-routing.test.ts` — 11 tests passed.
- `CI=true npx --yes pnpm@10.18.3 vitest run src/__tests__/exports.test.ts` — 2 tests passed.
- `CI=true npx --yes pnpm@10.18.3 vitest run` — 81 files and 786 tests passed.
- `CI=true npx --yes pnpm@10.18.3 compile` — passed.
- `pnpm-lock.yaml` remained at SHA-256 `0f516945e45e257735c4c89a5e9e08b4bb2f839b7ce48121a71b4fb0b03a0932`.

## Next Phase Readiness

- WIRE-04's production byte boundary is closed.
- The MDK fixture-loading pattern is ready for the wider conformance corpus in subsequent Phase 4 plans.
- No blockers remain for Plan 04-02.

## Self-Check: PASSED

- All created and modified files exist.
- Commits `acfead6`, `1103ea9`, `d5abfb4`, `2fa3086`, `f414618`, and `19a3a1f` exist in repository history.

---
*Phase: 04-feature-parity-conformance-vectors*
*Completed: 2026-09-05*
