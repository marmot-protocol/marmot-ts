---
phase: 05-quality-gate
plan: 06
subsystem: testing
tags: [attestation, provenance, rust, typescript, negative-controls]
requires:
  - phase: 05-quality-gate
    provides: Four independently generated QA-02 parity dossiers from plans 02-05 and final CI workflow from plan 01
provides:
  - Machine-enforced dossier evidence schema with mutation self-tests
  - Four dossiers bound to one immutable tested source and gitlink tuple
  - Distinct source and attestation commit identities
affects: [quality-gate, release-evidence, QA-02]
tech-stack:
  added: []
  patterns: [detached immutable-source attestation, git-tree provenance verification]
key-files:
  created:
    - scripts/validate-quality-dossiers.mjs
    - .planning/phases/05-quality-gate/05-DOSSIER-SCHEMA.json
  modified:
    - .planning/phases/05-quality-gate/05-PROOF-V2-DOSSIER.md
    - .planning/phases/05-quality-gate/05-KEY-PACKAGE-LIFETIME-DOSSIER.md
    - .planning/phases/05-quality-gate/05-TAG-CARDINALITY-DOSSIER.md
    - .planning/phases/05-quality-gate/05-SAFE-AAD-DOSSIER.md
key-decisions:
  - "Bind every dossier to tested_source_sha b937e3f3e4fddcb6e48aff4ca6507623504be48d and keep attestation_sha 172eb0a4f01812ffb0578b7155fd5d600453c86a explicitly distinct."
  - "Resolve reference provenance from git ls-tree at the tested commit, never from current HEAD or mutable submodule checkouts."
patterns-established:
  - "Dossier evidence lives in a versioned marked JSON block and is checked mechanically before release aggregation."
requirements-completed: [QA-02]
coverage:
  - id: D1
    description: All four dossiers attest one immutable tested source, Marmot SHA, MDK SHA, and frozen lockfile digest.
    requirement: QA-02
    verification:
      - kind: integration
        ref: node scripts/validate-quality-dossiers.mjs
        status: pass
    human_judgment: false
  - id: D2
    description: Missing evidence, mixed tuples, false gitlinks, and absent negative-control or oracle provenance are rejected.
    requirement: QA-02
    verification:
      - kind: unit
        ref: node scripts/validate-quality-dossiers.mjs --self-test
        status: pass
    human_judgment: false
duration: 12min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 6: Unified Dossier Attestation Summary

**Four independent Rust/TypeScript parity dossiers now share one immutable tested-source tuple, enforced by a dependency-free validator with 30 negative mutation classes.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-09-06T18:49:30Z
- **Completed:** 2026-09-06T19:01:30Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added a versioned embedded-JSON contract and validator that checks all required commands, outputs, oracle independence, negative controls, D-05 classification, and D-06 review fields.
- Froze source and template changes at `b937e3f3e4fddcb6e48aff4ca6507623504be48d`, then installed with pnpm 10.18.3 from the frozen lockfile and ran all generators, diffs, compile/build, and 68 focused tests in a detached worktree.
- Recorded evidence later in attestation commit `172eb0a4f01812ffb0578b7155fd5d600453c86a`, without self-referentially treating that commit as tested source.

## Task Commits

1. **Task 1 RED: define dossier evidence contract** - `6af3337` (test)
2. **Task 1 GREEN: enforce dossier evidence schema** - `4eff036` (feat)
3. **Task 2 source freeze: immutable dossier templates** - `b937e3f` (docs)
4. **Task 2 evidence: unified dossier attestations** - `172eb0a` (docs)

## Files Created/Modified

- `scripts/validate-quality-dossiers.mjs` - Parses marked evidence blocks, checks required fields and exact source gitlinks, and runs mutation self-tests.
- `.planning/phases/05-quality-gate/05-DOSSIER-SCHEMA.json` - Versions the contract and enumerates shared and conditional fields.
- The four `05-*-DOSSIER.md` files - Record identical immutable provenance plus dossier-specific commands, results, controls, and classifications.

## Decisions Made

- The immutable tested source is `b937e3f3e4fddcb6e48aff4ca6507623504be48d`; the later evidence commit is `172eb0a4f01812ffb0578b7155fd5d600453c86a`.
- Detached Cargo executions used their existing per-probe target directories after `/tmp` quota pressure; source, manifests, lockfiles, fixtures, and reference gitlinks all came from the detached tested-source worktree.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Recovered the pinned local ts-mls submodule object**

- **Found during:** Task 2 detached worktree provisioning
- **Issue:** The upstream submodule remote no longer advertised pinned commit `af6d1c5`.
- **Fix:** Fetched that exact object from the main workspace's local submodule repository and checked it out detached in the temporary worktree.
- **Files modified:** Temporary worktree only
- **Verification:** `git submodule status` reported the exact superproject-pinned SHA.
- **Committed in:** Not applicable; no source change.

**2. [Rule 3 - Blocking] Reused existing Cargo target directories after temporary-filesystem quota exhaustion**

- **Found during:** Task 2 Rust probe reproduction
- **Issue:** Four independent debug graphs exhausted the 1.7 GiB `/tmp` filesystem.
- **Fix:** Removed only generated target output from the temporary worktree and reran each locked manifest with its established repository-local target cache.
- **Files modified:** Generated build output only
- **Verification:** All four Rust streams diffed byte-for-byte against their committed fixtures.
- **Committed in:** Not applicable; no source change.

---

**Total deviations:** 2 auto-fixed (2 Rule 3).
**Impact on plan:** The immutable source and command semantics were preserved; only dependency-object and build-cache locations changed.

## Issues Encountered

The first multi-probe shell loop used zsh semantics incorrectly and was replaced with four explicit commands. No evidence from the failed invocation was recorded as passing.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

QA-02 has machine-checkable, immutable provenance ready for final quality-gate aggregation. No blockers remain.

## Self-Check: PASSED

- All six created or modified evidence files exist.
- Commits `6af3337`, `4eff036`, `b937e3f`, and `172eb0a` exist.
- Validator, 30-class self-test, lockfile source check, four Rust fixture diffs, compile/build, and 68 focused parity tests passed.

---

_Phase: 05-quality-gate_
_Completed: 2026-09-06_
