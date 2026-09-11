---
phase: 05-quality-gate
plan: 02
subsystem: testing
tags: [rust, mdk, proof-v2, conformance, nostr, schnorr]
requires:
  - phase: 01-proof-v2
    provides: account identity proof-v2 production verification path
provides:
  - SHA-pinned deterministic MDK proof-v2 reproduction probe
  - Rust-produced proof fixture with encoded bytes and provenance
  - Permanent production-path parity and mutation controls
  - Reproducibility dossier bound to MDK dbf45c83
affects: [05-quality-gate, QA-02, release-evidence]
tech-stack:
  added: [standalone Cargo proof probe]
  patterns: [independent immutable oracle plus negative controls]
key-files:
  created:
    - tools/quality-gate/proof-v2-probe/src/main.rs
    - src/__tests__/conformance/proof-v2-parity.test.ts
    - .planning/phases/05-quality-gate/05-PROOF-V2-DOSSIER.md
  modified:
    - src/__tests__/fixtures/proof-v2-rust.json
    - .gitignore
key-decisions:
  - "Use deterministic k256 prehash signing so repeated locked Rust runs emit identical proof bytes."
  - "Label the fixture legacy-version-byte-2 and distinguish it from MDK's current 0x8009 component profile."
patterns-established:
  - "Reference fixtures record their source SHA and complete encoded bytes."
  - "Interop assertions include independent canonical-data and signature mutations."
requirements-completed: [QA-02]
coverage:
  - id: D1
    description: MDK proof-v2 output is independently reproducible and accepted by shipping TypeScript verification.
    requirement: QA-02
    verification:
      - kind: integration
        ref: cargo locked reproduction diff plus src/__tests__/conformance/proof-v2-parity.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Canonical-event and signature mutations are rejected by the parity harness.
    requirement: QA-02
    verification:
      - kind: unit
        ref: src/__tests__/conformance/proof-v2-parity.test.ts#rejects canonical-event and signature mutations
        status: pass
    human_judgment: false
duration: 7min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 2: Proof-v2 Dossier Summary

**Deterministic MDK proof-v2 bytes pinned to `dbf45c83`, verified through the shipping TypeScript leaf path with mutation-sensitive controls**

## Performance

- **Duration:** 7 min
- **Started:** 2026-09-06T18:12:00Z
- **Completed:** 2026-09-06T18:19:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added a standalone Rust probe that asserts the exact MDK SHA and emits stable fixture JSON using MDK's canonical event and proof-extension implementation.
- Added a focused permanent test covering proof decode, event-id parity, raw Schnorr verification, production LeafNode verification, and two negative controls.
- Recorded exact revisions, tool versions, commands, outputs, fixture fields, digest, and the legacy/current profile distinction in the dossier.

## Task Commits

1. **Task 1 RED: failing proof-v2 parity controls** - `c6fc694` (test)
2. **Task 1 GREEN: reproducible MDK fixture and production-path parity** - `a2376e6` (feat)
3. **Task 1 generated-output hygiene** - `ccdff08` (chore)
4. **Task 2: proof-v2 reproducibility dossier** - `fc7620e` (docs)

## Files Created/Modified

- `tools/quality-gate/proof-v2-probe/Cargo.toml` / `Cargo.lock` - Isolated, locked Rust probe dependency graph.
- `tools/quality-gate/proof-v2-probe/src/main.rs` - Deterministic MDK-backed fixture generator with SHA assertion.
- `src/__tests__/fixtures/proof-v2-rust.json` - Rust-produced profile, provenance, signature, event id, and full proof bytes.
- `src/__tests__/conformance/proof-v2-parity.test.ts` - Shipping-path acceptance and mutation controls.
- `.planning/phases/05-quality-gate/05-PROOF-V2-DOSSIER.md` - Reproducibility evidence.
- `.gitignore` - Ignores nested Cargo `target/` output.

## Decisions Made

- Used deterministic BIP-340 prehash signing through the same k256 pattern as MDK's own support code; Nostr event signing may use auxiliary randomness and therefore is unsuitable for a byte-stable fixture.
- Preserved MDK independence: the Rust probe produces every expected fixture field, while TypeScript only consumes and verifies those fields.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Ignored nested Cargo build output**

- **Found during:** Task 1
- **Issue:** The new standalone probe generated thousands of untracked `target/` artifacts.
- **Fix:** Added `target/` to the root ignore rules.
- **Files modified:** `.gitignore`
- **Verification:** `git status --short` contains no generated Cargo output.
- **Committed in:** `ccdff08`

**2. [Rule 1 - Bug] Corrected the negative-control error assertion**

- **Found during:** Task 1 GREEN verification
- **Issue:** The test expected a non-production error string instead of the verifier's actual stable domain message.
- **Fix:** Asserted `proof signature does not verify for credential identity`.
- **Files modified:** `src/__tests__/conformance/proof-v2-parity.test.ts`
- **Verification:** Focused Vitest suite passes 2/2 tests.
- **Committed in:** `a2376e6`

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** Both changes were required for correct verification and clean repository state; no feature scope was added.

## Issues Encountered

The first probe implementation used Nostr SDK event signing, whose auxiliary randomness changed signatures between runs. It was replaced with deterministic k256 prehash signing before the fixture was committed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

The proof-v2 QA-02 dossier is reproducible and ready for consolidation into the final quality gate. No blockers remain.

## Self-Check: PASSED

- All required probe, fixture, test, and dossier files exist.
- Commits `c6fc694`, `a2376e6`, `ccdff08`, and `fc7620e` exist.
- Locked Rust output matches the fixture byte-for-byte; focused Vitest and strict TypeScript compile pass.

---

_Phase: 05-quality-gate_
_Completed: 2026-09-06_
