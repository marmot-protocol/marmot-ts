---
phase: 05-quality-gate
plan: 04
subsystem: testing
tags: [rust, mdk, nostr, key-package, tag-cardinality, conformance]
requires:
  - phase: 02-wire-validation
    provides: strict Nostr required-tag cardinality accessors and inbound gates
  - phase: 05-quality-gate
    provides: deterministic current-profile KeyPackage fixture from plan 05-03
provides:
  - SHA-pinned MDK kind-30443 tag-production probe
  - Rust-produced ordered tag fixture and mutation-sensitive TypeScript parity test
  - Complete specification-derived malformed required-tag matrix
  - Two-source dossier preserving the D-05 attribution boundary
affects: [05-quality-gate, QA-02, release-evidence]
tech-stack:
  added: [standalone Cargo tag probe]
  patterns: [producer-oracle evidence separated from specification-derived receiver evidence]
key-files:
  created:
    - tools/quality-gate/tag-probe/src/main.rs
    - src/__tests__/fixtures/key-package-tags-rust.json
    - src/core/__tests__/key-package-tag-parity.test.ts
    - .planning/phases/05-quality-gate/05-TAG-CARDINALITY-DOSSIER.md
  modified:
    - src/core/key-package-event-encode.ts
key-decisions:
  - "Use MDK only as the kind-30443 producer oracle; source every inbound rejection row to the Marmot transport specification."
  - "Match MDK's complete required-tag order by placing the i tag before ciphersuite and list advertisements."
patterns-established:
  - "Cross-implementation dossiers visibly separate independently produced bytes from locally tested normative behavior."
  - "Cardinality matrices iterate the shared table so every declared event/tag row receives identical malformed-shape controls."
requirements-completed: [QA-02]
coverage:
  - id: D1
    description: MDK kind-30443 tags are independently reproducible and match the complete ordered TypeScript producer output.
    requirement: QA-02
    verification:
      - kind: integration
        ref: cargo locked reproduction diff plus src/core/__tests__/key-package-tag-parity.test.ts#matches the Rust-produced canonical tag array and order
        status: pass
    human_judgment: false
  - id: D2
    description: Every specification-required singleton and list tag rejects all applicable malformed cardinality shapes.
    requirement: QA-02
    verification:
      - kind: unit
        ref: src/core/__tests__/key-package-tag-parity.test.ts#specification-derived required-tag rejection matrix
        status: pass
    human_judgment: false
duration: 7min
completed: 2026-09-06
status: complete
---

# Phase 5 Plan 4: Tag Cardinality Dossier Summary

**Pinned MDK kind-30443 producer tags matched byte-for-byte and in order, with a separately attributed 11-row specification-derived inbound rejection matrix**

## Performance

- **Duration:** 7 min
- **Started:** 2026-09-06T18:31:15Z
- **Completed:** 2026-09-06T18:37:12Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- Added an isolated locked Rust probe that asserts MDK `dbf45c83` and emits canonical kind-30443 tags through MDK's public publisher.
- Added a Rust-produced fixture and permanent TypeScript test comparing the complete ordered tag array with mutation sensitivity.
- Exercised missing, repeated, empty, extra-singleton, and duplicate-list rejection across all 11 required `(kind, tag)` rows.
- Recorded the producer and receiver evidence under visibly separate authority headings so no TypeScript-only rejection is represented as Rust output.

## Task Commits

1. **Task 1 RED: failing tag parity and matrix controls** - `41bb297` (test)
2. **Task 1 GREEN: reproducible MDK fixture and producer-order parity** - `1555092` (feat)
3. **Task 2: two-source tag cardinality dossier** - `3ada453` (docs)

## Files Created/Modified

- `tools/quality-gate/tag-probe/Cargo.toml` / `Cargo.lock` - Isolated dependency graph using MDK path dependencies.
- `tools/quality-gate/tag-probe/src/main.rs` - SHA-pinned MDK publisher probe and deterministic fixture renderer.
- `src/__tests__/fixtures/key-package-tags-rust.json` - Rust-produced kind, provenance, ordered tags, and tag-array digest.
- `src/core/__tests__/key-package-tag-parity.test.ts` - Producer parity, mutation control, and complete spec-derived matrix.
- `src/core/key-package-event-encode.ts` - Canonical MDK-compatible required-tag ordering.
- `.planning/phases/05-quality-gate/05-TAG-CARDINALITY-DOSSIER.md` - Commands, revisions, exact array, digests, negative control, and attribution boundary.

## Decisions Made

- Used MDK's public `NostrKeyPackagePublication::to_event_at` only for outbound kind-30443 production evidence.
- Used `refs/marmot/transports/nostr.md` as the sole authority for 445, 1059, 444, and 30443 inbound malformed-cardinality dispositions because MDK provides no general oracle for that matrix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Aligned TypeScript required-tag order with MDK**

- **Found during:** Task 1 GREEN
- **Issue:** Production TypeScript appended `i` after the ciphersuite and list tags, while MDK emits `i` immediately after `mls_protocol_version`.
- **Fix:** Calculated the KeyPackageRef before tag construction and inserted `i` in MDK's canonical position.
- **Files modified:** `src/core/key-package-event-encode.ts`
- **Verification:** Complete Rust/TypeScript array comparison and existing KeyPackage event suite pass.
- **Committed in:** `1555092`

**2. [Rule 3 - Blocking] Made locked fixture reproduction stable under repository formatting**

- **Found during:** Task 1 GREEN
- **Issue:** Serde's generic pretty JSON layout differed from the repository's staged Prettier layout, causing the required raw fixture diff to fail after formatting.
- **Fix:** Made the Rust probe render its owned tag fixture in the repository's deterministic JSON layout while retaining values directly from MDK's event.
- **Files modified:** `tools/quality-gate/tag-probe/src/main.rs`
- **Verification:** Locked probe output diffs byte-for-byte with the formatted checked-in fixture.
- **Committed in:** `1555092`

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** Both fixes were necessary for exact producer parity and reproducible committed evidence; no protocol capability was added.

## Issues Encountered

The fixed KeyPackage uses MDK's current account-proof profile, so the transport wrapper had to preserve `ProtocolProfile::Current` before metadata extraction. This was corrected inside the probe before fixture generation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Tag production and cardinality evidence is reproducible and ready for final QA-02 consolidation. No blockers remain.

## Self-Check: PASSED

- All required probe, lockfile, fixture, test, producer, dossier, and summary files exist.
- Commits `41bb297`, `1555092`, and `3ada453` exist.
- Locked Rust output matches the fixture exactly; 101 focused tests and strict TypeScript compile pass.

---

_Phase: 05-quality-gate_
_Completed: 2026-09-06_
