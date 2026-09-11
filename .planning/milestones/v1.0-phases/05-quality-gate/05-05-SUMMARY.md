---
phase: 05-quality-gate
plan: 05
subsystem: testing
tags: [rust, mdk, openmls, safe-aad, app-data-dictionary, capabilities]
requires:
  - phase: 04-feature-parity-conformance-vectors
    provides: TypeScript SafeAAD LeafNode encoding and dictionary scope validation
  - phase: 05-quality-gate
    provides: pinned dbf45c83 MDK reference and b4649c01 capability-delta context
provides:
  - Genuine MDK Engine-to-KeyPackage SafeAAD extractor pinned to dbf45c83
  - Exact stable SafeAAD dictionary projection with mutation and scope controls
  - Post-b4649c01 signed-versus-effective capability evidence
  - Reproducible SafeAAD parity dossier
affects: [05-quality-gate, QA-02, release-evidence]
tech-stack:
  added: [standalone Cargo SafeAAD probe]
  patterns: [genuine-engine wire extraction, stable projection of nondeterministic signed leaf data]
key-files:
  created:
    - tools/quality-gate/safe-aad-probe/src/main.rs
    - src/__tests__/fixtures/safe-aad-rust.json
    - src/core/components/__tests__/safe-aad-parity.test.ts
    - .planning/phases/05-quality-gate/05-SAFE-AAD-DOSSIER.md
  modified: []
key-decisions:
  - "Extract the oracle only from bytes returned by the public current-profile MDK Engine::fresh_key_package path."
  - "Serialize the exact extracted SafeAAD entry as the stable projection because current account-proof timestamps and signatures make the surrounding dictionary nondeterministic."
patterns-established:
  - "Rust wire oracles declare their full public extraction path and reject an unpinned MDK checkout."
  - "Capability fixtures distinguish signed advertisements from RFC-default effective support."
requirements-completed: [QA-02]
coverage:
  - id: D1
    description: SafeAAD bytes are extracted from a genuine MDK KeyPackage and match the shipping TypeScript LeafNode projection exactly.
    requirement: QA-02
    verification:
      - kind: integration
        ref: cargo locked reproduction diff plus src/core/components/__tests__/safe-aad-parity.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: SafeAAD scope, byte mutation, and post-b4649c01 implicit-default capability behavior are permanently enforced.
    requirement: QA-02
    verification:
      - kind: unit
        ref: src/core/components/__tests__/safe-aad-parity.test.ts#MDK SafeAAD parity
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 5: SafeAAD Parity Summary

**Genuine MDK Engine KeyPackage extraction with byte-exact SafeAAD projection, LeafNode scope enforcement, mutation sensitivity, and post-b4649c01 capability evidence**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-06T18:39:00Z
- **Completed:** 2026-09-06T18:48:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added an isolated locked Rust probe that constructs a real current-profile MDK Engine and parses only the KeyPackage bytes returned by `CgkaEngine::fresh_key_package`.
- Added a pinned fixture and four permanent tests proving exact SafeAAD projection bytes, LeafNode-only scope, byte-mutation rejection, and RFC-default capability omission.
- Recorded exact SHAs, commands, bytes, digests, actual component advertisements, and the `b4649c01` signed-versus-effective capability change.

## Task Commits

1. **Task 1 RED: failing SafeAAD parity controls** - `07b41f8` (test)
2. **Task 1 GREEN: genuine MDK SafeAAD extraction** - `4b42264` (feat)
3. **Task 2: SafeAAD and capability-delta dossier** - `5d673f5` (docs)

## Files Created/Modified

- `tools/quality-gate/safe-aad-probe/Cargo.toml` / `Cargo.lock` - Isolated dependency graph pinned to the MDK workspace and its OpenMLS revision.
- `tools/quality-gate/safe-aad-probe/src/main.rs` - Genuine current-profile engine builder, public KeyPackage call, wire parser, and stable projection emitter.
- `src/__tests__/fixtures/safe-aad-rust.json` - SHA-pinned SafeAAD bytes, actual MDK app components, and signed/effective capabilities.
- `src/core/components/__tests__/safe-aad-parity.test.ts` - Exact parity, scope, capability, and one-byte mutation controls.
- `.planning/phases/05-quality-gate/05-SAFE-AAD-DOSSIER.md` - Reproduction commands and complete D-04/D-06 evidence.

## Decisions Made

- Used the public `EngineBuilder` and `CgkaEngine::fresh_key_package` seam rather than reproducing MDK's private serializer helper.
- Projected only the exact extracted SafeAAD entry because the surrounding current-profile proof component includes a live timestamp and signature; the complete actual app-component list remains recorded separately.
- Tested the `b4649c01` invariant as omission of RFC-default ids plus presence of non-default ids, allowing legitimate additional non-default TypeScript capabilities.

## Deviations from Plan

None - plan executed exactly as written, including its explicit stable-projection allowance for unrelated nondeterministic proof material.

## Issues Encountered

The initial stable-projection insert retained a borrowed byte slice, while OpenMLS requires an owned vector. Converting the exact extracted slice with `to_vec()` resolved the compile error without changing the bytes. The mutation control was broadened to accept the production decoder's precise low-level truncation error rather than one wrapper-specific message.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

SafeAAD and the post-`b4649c01` capability delta are pinned and ready for QA-02 consolidation. No blockers remain.

## Self-Check: PASSED
