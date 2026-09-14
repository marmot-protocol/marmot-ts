---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 08
subsystem: auth
tags: [key-package, account-identity-proof, app-components, ts-mls, client, docs, changeset]

# Dependency graph
requires:
  - phase: 07-06
    provides: "Atomic wire cut to 0x8009: generateKeyPackage requires a signer and always emits the 0x8009 leaf proof; invite, admin-policy, and join-via-Welcome all validate through the 0x8009 class validators"
  - phase: 07-07
    provides: "The legacy 0xf2f1 module, its tests, Rust fixture, and probe generator are deleted; the package root no longer exports any of the 15 legacy proof symbols"
provides:
  - "ListedKeyPackage.nonCurrent — KeyPackageStore.list() classifies every stored entry via validateKeyPackageAccountIdentityProof, flagging any package lacking a valid current 0x8009 proof (e.g. a pre-v2 legacy-only leaf); watchKeyPackages() snapshots inherit the flag"
  - "KeyPackageManager.ensurePublished skips !pkg.used && !pkg.nonCurrent entries only, so a stored legacy KeyPackage is never reused for publication, is never auto-deleted, and no kind-5 deletion is sent for it — apps remove it explicitly via purge()"
  - "A major changeset (.changeset/account-identity-proof-v2.md) documenting every breaking change of the 0x8009 clean cut across all of Phase 7, and a docs migration section in docs/client/best-practices.md"
  - "Every other docs page and README swept clean of the removed accountProofSigner option and the legacy marmot.account-identity-proof.v1 LeafNode extension as a current description"
affects: [08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Legacy-shaped KeyPackage test fixtures are built by calling ts-mls's own generateKeyPackage directly (aliased import) with a bare 0xf2f1 makeCustomExtension leaf extension, never by importing the deleted legacy proof module"

key-files:
  created:
    - .changeset/account-identity-proof-v2.md
  modified:
    - src/client/key-package-store.ts
    - src/client/key-package-manager.ts
    - src/client/__tests__/key-package-manager.test.ts
    - docs/client/best-practices.md
    - docs/client/marmot-client.md
    - docs/client/proposals.md
    - docs/core/index.md
    - docs/core/protocol.md
    - docs/core/key-packages.md
    - docs/core/groups.md
    - docs/guide/architecture.md
    - README.md
    - examples/opentui/README.md

key-decisions:
  - "Chose an optional ListedKeyPackage.nonCurrent listing field (Claude's Discretion per D-09) rather than a separate query method, computed inline in KeyPackageStore.list() by running validateKeyPackageAccountIdentityProof per stored entry and catching any throw"
  - "ensurePublished's existing.find selector changed from !pkg.used to !pkg.used && !pkg.nonCurrent — a one-line, surgical change that leaves create/rotate/remove/purge/selectForWelcome untouched, matching the plan's explicit scope boundary"
  - "docs/core/protocol.md's required_capabilities paragraph was rewritten to state proposalTypes as app_data_update (0x0008) and self_remove (0x000a), matching src/core/capabilities.ts's marmotRequiredCapabilitiesExtension exactly, rather than leaving the stale legacy-0xf2f1 wording in place"
  - "examples/opentui/README.md's 'account-proof signer' reference was dropped outright (not migrated to a new description) after confirming no such helper file exists anywhere under examples/opentui/src — it was already dead documentation before this plan"

patterns-established: []

requirements-completed: [CUT-01, CUT-02]

coverage:
  - id: D1
    description: "KeyPackageStore.list() and KeyPackageManager.list()/watchKeyPackages() flag every stored KeyPackage that fails validateKeyPackageAccountIdentityProof (legacy 0xf2f1 or no valid 0x8009 proof) with nonCurrent: true, and omit the flag for current packages"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#non-current stored KeyPackages (D-09) > a KeyPackage created through manager.create() lists without a nonCurrent property (current)"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#non-current stored KeyPackages (D-09) > a legacy-shaped KeyPackage added through manager.add() lists with nonCurrent === true, including watchKeyPackages snapshots"
        status: pass
    human_judgment: false
  - id: D2
    description: "ensurePublished ignores nonCurrent entries as well as used ones: with only a non-current unused package stored it creates and publishes exactly one fresh 0x8009 KeyPackage, leaves the legacy entry stored, and sends no kind-5 deletion"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#non-current stored KeyPackages (D-09) > ensurePublished ignores a non-current unused package, publishes exactly one fresh current package, and sends no kind-5"
        status: pass
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#non-current stored KeyPackages (D-09) > ensurePublished returns the existing current unused package and publishes nothing when one is already stored"
        status: pass
      - kind: integration
        ref: "src/__tests__/integration/invite-listen-ensure.test.ts#invites.listen + keyPackages.ensurePublished > ensurePublished creates one KeyPackage and is idempotent"
        status: pass
    human_judgment: false
  - id: D3
    description: "A non-current package is removed only when the app explicitly calls purge(); nothing is auto-deleted"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/client/__tests__/key-package-manager.test.ts#non-current stored KeyPackages (D-09) > purge(legacyRef) removes a non-current entry explicitly — nothing is auto-deleted"
        status: pass
    human_judgment: false
  - id: D4
    description: "A major changeset lists the removed proof-signer option, the required generateKeyPackage signer and optional createdAt, the new makeLeafAppComponentsExtension signature, the 15 removed legacy exports, the 13 added exports, the nonCurrent flag, and join rejection of legacy groups"
    requirement: "CUT-01"
    verification:
      - kind: other
        ref: "grep -c '\"@internet-privacy/marmot-ts\": major' .changeset/account-identity-proof-v2.md -> 1; all 19 required symbol substrings present (15 removed + validateLeafAccountIdentityProof + validateKeyPackageAccountIdentityProof + produceAccountIdentityProof + nonCurrent)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The docs carry a short migration section (KeyPackage republishing via ensurePublished + purge of nonCurrent entries, legacy groups rejected on join, the signer change); no other docs page or README still instructs a separate proof signer or describes the v1 LeafNode extension as current"
    requirement: "CUT-01"
    verification:
      - kind: other
        ref: "grep -c 'Migrating to account identity proof v2' docs/client/best-practices.md -> 1; grep -c ensurePublished/purge/nonCurrent each -> >=1; grep -rln accountProofSigner and account-identity-proof.v1 across docs/README/opentui-README outside best-practices.md -> empty; docs/core/protocol.md f2f1 count -> 0; docs/signers/ file count -> 0"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-09-14
status: complete
---

# Phase 7 Plan 8: Legacy KeyPackage State and Release Surface Summary

**`KeyPackageStore.list()` now flags any stored KeyPackage lacking a valid current `0x8009` proof as `nonCurrent`, `ensurePublished` skips and never reuses such entries (no auto-delete, no kind-5), and the phase's full breaking-change surface ships as a major changeset plus a docs migration section, with every stale proof-signer/legacy-extension reference swept from the rest of the docs.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 13 (1 created, 12 modified)

## Accomplishments

- `src/client/key-package-store.ts`: `ListedKeyPackage` gained an optional `nonCurrent?: boolean` field, documented as "true when the stored KeyPackage lacks a valid current account identity proof (0x8009)... never reused by ensurePublished, removed only by explicit purge()". `KeyPackageStore.list()` runs `validateKeyPackageAccountIdentityProof(publicPackage)` (imported from `../core/components/account-identity-proof.js`) per local entry inside a try/catch, spreading `{ nonCurrent: true }` into the mapped listing object on any throw, following the file's existing conditional-spread style for `used`.
- `src/client/key-package-manager.ts`: `ensurePublished`'s selector changed to `existing.find((pkg) => !pkg.used && !pkg.nonCurrent)`, so a stored legacy or otherwise non-current package is skipped and a fresh current one is created and published instead. JSDoc on both `ensurePublished` and `list()` documents the flag and the no-auto-delete guarantee. `create`, `rotate`, `remove`, `purge`, and `selectForWelcome` are untouched.
- `src/client/__tests__/key-package-manager.test.ts` gained a `describe("non-current stored KeyPackages (D-09)")` block (5 tests) built around a new `buildLegacyKeyPackage` helper that calls ts-mls's own `generateKeyPackage` directly (aliased `mlsGenerateKeyPackage`) with a bare `makeCustomExtension({ extensionType: 0xf2f1, ... })` leaf extension — no import from the deleted legacy proof module anywhere in the fixture. Covers: a `create()`d package lists with no `nonCurrent` property; a legacy-shaped `add()`ed package lists `nonCurrent === true` in both `list()` and `watchKeyPackages()` snapshots; `ensurePublished` with only a non-current unused package publishes exactly one fresh kind-30443 event, returns a different ref, leaves the legacy entry stored and still `nonCurrent`, and sends no kind-5; `ensurePublished` with an existing current unused package returns it and publishes nothing; `purge(legacyRef)` removes the non-current entry explicitly.
- `.changeset/account-identity-proof-v2.md`: a major changeset for `@internet-privacy/marmot-ts` documenting the whole Phase 7 breaking-change surface — the removed proof-signer option across all five option types, `generateKeyPackage`'s required `signer`/optional `createdAt`, `makeLeafAppComponentsExtension`'s required proof, capabilities no longer advertising/requiring `0xf2f1`, join rejection of legacy/mixed/neither-profile groups, the 15 removed legacy proof exports (named), the 13 added `0x8009` exports (named), and `ListedKeyPackage.nonCurrent`.
- `docs/client/best-practices.md`: replaced the stale "Supply an account-identity-proof signer for interop" section (which told users to provide `accountProofSigner` for a `v1` proof) with "Migrating to account identity proof v2 (0x8009)" — three subsections covering the signer (no separate option), republishing (`ensurePublished` + `purge` of `nonCurrent` entries), and legacy-group rejection.
- Swept every other flagged docs location: `docs/client/marmot-client.md` (dropped the `accountProofSigner` optional-dependency bullet, extended the `signer` bullet), `docs/client/proposals.md` (invite proof sentence now names `0x8009`/`AccountIdentityProofError`), `docs/core/index.md` and `docs/guide/architecture.md` (identity bridging described as the `0x8009` app component), `docs/core/protocol.md` (required-capabilities paragraph now matches `src/core/capabilities.ts` exactly — `app_data_dictionary` extension plus `app_data_update`/`self_remove` proposals, `0x8009` in every new group's `app_components`), `docs/core/key-packages.md` and `docs/core/groups.md` (added `signer` to all three `generateKeyPackage` samples plus a `0x8009` requirements bullet), `README.md` (wire-compat sentence and signer description updated, standalone signer bullet removed), `examples/opentui/README.md` (dropped the now-nonexistent "account-proof signer" helper reference — verified no such file exists under `examples/opentui/src`). Confirmed `docs/signers/` remains empty.
- Full gates green: `pnpm vitest run src/client/__tests__/key-package-manager.test.ts src/__tests__/integration/invite-listen-ensure.test.ts` (79/79), `pnpm compile`, root `tsc --noEmit`, `pnpm vitest run` (full suite, 98 files / 1097 tests — one unrelated `src/engine/__tests__/state-notification-withdrawal.test.ts` flake on the first full-suite run, reproduced as passing both standalone and on a clean full-suite rerun; not touched by this plan), and `prettier --check` on all Task 1 and Task 2 files.

## Task Commits

1. **Task 1: Flag non-current stored KeyPackages and skip them in ensurePublished (D-09)** - `05dd17d` (feat)
2. **Task 2: Major changeset and docs migration section; remove stale proof-signer and v1-extension docs (D-11, CUT-01)** - `32c6d22` (docs)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `src/client/key-package-store.ts` - `ListedKeyPackage.nonCurrent?: boolean`; `list()` classifies via `validateKeyPackageAccountIdentityProof`
- `src/client/key-package-manager.ts` - `ensurePublished` selects `!pkg.used && !pkg.nonCurrent`; JSDoc updated
- `src/client/__tests__/key-package-manager.test.ts` - New `non-current stored KeyPackages (D-09)` describe block (5 tests) plus `buildLegacyKeyPackage` fixture helper
- `.changeset/account-identity-proof-v2.md` - Major changeset for the full Phase 7 breaking-change surface
- `docs/client/best-practices.md` - "Migrating to account identity proof v2 (0x8009)" section
- `docs/client/marmot-client.md` - Signer bullet extended, proof-signer bullet removed
- `docs/client/proposals.md` - Invite proof sentence names `0x8009`/`AccountIdentityProofError`
- `docs/core/index.md`, `docs/guide/architecture.md` - Identity bridging described as the `0x8009` app component
- `docs/core/protocol.md` - Required-capabilities paragraph matches current `marmotRequiredCapabilitiesExtension`
- `docs/core/key-packages.md`, `docs/core/groups.md` - `signer` added to `generateKeyPackage` samples, `0x8009` requirements bullet
- `README.md` - Wire-compat sentence and signer bullet updated
- `examples/opentui/README.md` - Dropped the stale "account-proof signer" reference

## Decisions Made

- Chose an optional `ListedKeyPackage.nonCurrent` listing field (Claude's Discretion per D-09) computed inline in `KeyPackageStore.list()`, rather than a separate query method — matches the file's existing conditional-spread pattern for `used`.
- `ensurePublished`'s selector change is the only production-code edit to that method — a one-line, surgical change per the plan's explicit scope boundary (`create`/`rotate`/`remove`/`purge`/`selectForWelcome` untouched).
- Rewrote `docs/core/protocol.md`'s required-capabilities paragraph to state the proposal types exactly as `src/core/capabilities.ts`'s `marmotRequiredCapabilitiesExtension` computes them (`app_data_update` + `self_remove`), rather than leaving the stale legacy-`0xf2f1` wording that predated the clean cut.
- Dropped `examples/opentui/README.md`'s "account-proof signer" reference outright after confirming (via `find`/`grep`) no such helper exists anywhere under `examples/opentui/src` — it was already dead documentation.

## Deviations from Plan

None - plan executed exactly as written. All acceptance-criteria greps passed on first check.

## Issues Encountered

One `src/engine/__tests__/state-notification-withdrawal.test.ts` test failed on the first full-`pnpm vitest run` pass (`toBeGreaterThan(0)` assertion on a derived tree-position index) but passed both in isolation and on an immediate full-suite rerun. Not caused by this plan — no file this plan touches overlaps `src/engine/`, and the plan's own verification scope (`key-package-manager.test.ts`, `invite-listen-ensure.test.ts`, `pnpm compile`, `tsc --noEmit`) never exercises that module. Logged here for visibility rather than investigated further, since it reproduces as a pass and is out of this plan's scope per the deviation-rules scope boundary.

## Known Stubs

None - every changed function is a complete implementation; no placeholder data or unwired paths were introduced.

## Threat Flags

None. This plan's own `<threat_model>` (T-07-34..T-07-37, all disposition `mitigate`) covers every trust boundary touched by Task 1 (persisted KeyPackageStore -> publication) and Task 2 (docs -> integrators); no new surface was introduced.

## Deferred / Known Gaps

Carried forward unchanged from 07-06/07-07 SUMMARYs (this plan touched neither):

1. **D-06 (admin-policy skip), Phase 8 GRP-02/GRP-04:** a proof-less Add still skips the admin-policy proof gate rather than being rejected.
2. **D-10 (stored legacy groups):** stored v1.0 groups requiring the legacy `0xf2f1` extension continue to load and operate locally untouched; Phase 8's legality seams must reject them going forward.
3. **Send/ingest/pool-replay/convergence seams** do not yet call the `0x8009` validators — Phase 8 (GRP-02) closes this.

## User Setup Required

None - no external service configuration required. The major version bump itself is a downstream-app concern (documented in the changeset and migration docs), not an action required of this repository's maintainers.

## Next Phase Readiness

- Phase 7 (`account-identity-proof-component-0x8009-legacy-clean-cut`) is now fully complete: all 8 plans landed, `CUT-01` and `CUT-02` are `Complete` in `REQUIREMENTS.md` (marked by 07-07; reconfirmed unchanged here), and the release surface (major changeset + migration docs) ships alongside the code.
- Full suite (98 files / 1097 tests), `pnpm compile`, root `tsc --noEmit`, and `prettier --check` on every touched file are all green.
- No known blockers for Phase 8.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

All `files_modified` verified present on disk (`.changeset/account-identity-proof-v2.md` confirmed created; all 12 modified files confirmed present); both task commit hashes (`05dd17d`, `32c6d22`) verified in `git log`.
