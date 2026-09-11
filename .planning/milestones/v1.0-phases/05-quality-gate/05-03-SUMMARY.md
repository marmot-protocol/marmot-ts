---
phase: 05-quality-gate
plan: 03
subsystem: testing
tags: [rust, mdk, openmls, key-package, lifetime, capabilities, conformance]
requires:
  - phase: 02-wire-validation
    provides: KeyPackage lifetime cap and current-time policy
  - phase: 04.1-lifecycle
    provides: current lifecycle component advertisement
provides:
  - SHA-pinned deterministic MDK KeyPackage lifetime probe
  - Rust-produced full TLS fixture with fixed-time boundary outcomes
  - Permanent TypeScript decoder, policy, and mutation parity controls
  - Reproducibility dossier covering the b4649c01 signed-capability delta
affects: [05-quality-gate, QA-02, release-evidence]
tech-stack:
  added: [standalone Cargo lifetime probe]
  patterns: [deterministic OpenMLS randomness injection, fixed-time reference projection]
key-files:
  created:
    - tools/quality-gate/lifetime-probe/src/main.rs
    - src/core/__tests__/key-package-lifetime-parity.test.ts
    - .planning/phases/05-quality-gate/05-KEY-PACKAGE-LIFETIME-DOSSIER.md
  modified:
    - src/__tests__/fixtures/key-package-lifetime-rust.json
key-decisions:
  - "Inject every KeyPackage randomness source and fixed validation time so the complete Rust MLS frame is byte-stable."
  - "Record signed advertisements separately from RFC-default effective support after MDK b4649c01."
patterns-established:
  - "Reference lifetime fixtures carry complete framed bytes, a projection digest, and independently evaluated boundary rows."
  - "Capability evidence distinguishes signed wire lists from implicit runtime support."
requirements-completed: [QA-02]
coverage:
  - id: D1
    description: MDK lifetime bytes and cap/current boundary outcomes are independently reproducible and accepted by shipping TypeScript paths.
    requirement: QA-02
    verification:
      - kind: integration
        ref: cargo locked reproduction diff plus src/core/__tests__/key-package-lifetime-parity.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: The b4649c01 signed-advertisement versus implicit-support capability delta is fixture-pinned.
    requirement: QA-02
    verification:
      - kind: unit
        ref: src/core/__tests__/key-package-lifetime-parity.test.ts#distinguishes signed advertisements from implicit RFC support
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 3: KeyPackage Lifetime Parity Summary

**Deterministic MDK KeyPackage bytes at the exact lifetime cap, decoded through shipping TypeScript with fixed-time boundary and post-b4649c01 capability controls**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-06T18:20:23Z
- **Completed:** 2026-09-06T18:29:19Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Added an isolated locked Rust probe pinned to MDK `dbf45c83`, with deterministic OpenMLS randomness, signing keys, current-profile proof bytes, and validation time.
- Added a full Rust TLS fixture and permanent tests proving `7,261,200` acceptance, `7,261,201` rejection, expired/future rejection, production default separation, and a one-second negative control.
- Captured the `b4649c01` distinction between signed capability advertisements and implicit RFC default support in executable fixture assertions and a reproducibility dossier.

## Task Commits

1. **Task 1 RED: failing lifetime parity controls** - `82e8e65` (test)
2. **Task 1 GREEN: reproducible MDK lifetime fixture** - `baae3f4` (feat)
3. **Task 2: lifetime and capability-delta dossier** - `a6f63a2` (docs)

## Files Created/Modified

- `tools/quality-gate/lifetime-probe/Cargo.toml` / `Cargo.lock` - Isolated Rust dependency graph pinned to MDK's OpenMLS revision.
- `tools/quality-gate/lifetime-probe/src/main.rs` - Fixed-time deterministic KeyPackage generator and boundary oracle.
- `src/__tests__/fixtures/key-package-lifetime-rust.json` - Rust-produced complete TLS bytes, digests, decoded projection, and outcomes.
- `src/core/__tests__/key-package-lifetime-parity.test.ts` - Shipping decoder/policy parity and mutation controls.
- `.planning/phases/05-quality-gate/05-KEY-PACKAGE-LIFETIME-DOSSIER.md` - Exact commands, revisions, values, matrix, and capability delta.

## Decisions Made

- Injected all random material and retained complete KeyPackage TLS hex because the resulting locked probe output is byte-stable across repeated runs.
- Used OpenMLS's injectable `validate_with_time` for boundary rows, matching MDK's validation implementation without allowing wall-clock drift into the fixture.
- Kept signed extension/proposal lists separate from their effective forms because `b4649c01` deliberately omits RFC defaults from signatures while adding them for internal compatibility checks.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The first compile selected `tls_codec` 0.4 while the pinned OpenMLS revision uses 0.5. Aligning the direct probe dependency to 0.5 removed the duplicate-trait mismatch; the regenerated lockfile and all locked runs then passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The KeyPackage lifetime and capability evidence is reproducible and ready for the final QA-02 consolidation. No blockers remain.

## Self-Check: PASSED

- All required probe, lockfile, fixture, test, dossier, and summary files exist.
- Commits `82e8e65`, `baae3f4`, and `a6f63a2` exist.
- Locked Rust output matches the fixture exactly; 50 focused tests and strict TypeScript compile pass.

---

_Phase: 05-quality-gate_
_Completed: 2026-09-06_
