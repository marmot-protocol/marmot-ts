---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 04
subsystem: testing
tags: [mls, key-package, account-identity-proof, applesauce, vitest]

# Dependency graph
requires:
  - phase: 07-02
    provides: "Core generateKeyPackage's additive signer?: AuthorizationProofSigner option, and src/__tests__/helpers/test-accounts.ts's testAccount(slot) deterministic account helper"
provides:
  - "All 17 core and client unit test files build every KeyPackage with a real testAccount() (or PrivateKeyAccount.fromKey) signer whose pubkey matches the credential identity (D-02)"
  - "The signer gate over the 16 non-exception files exits 0; invite-user.test.ts's one intentional proof-less generateKeyPackage call is the only signer-gate hit, left for plan 07-06"
  - "No proof-signer adapter (accountProofSigner raw-digest usage) remains in these 17 files (D-04)"
affects: [07-05, 07-06, 07-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Raw-digest proof-signer test setups (secretKey + signAccountIdentityProof) replaced by PrivateKeyAccount.fromKey(secretKey).signer, passed directly as generateKeyPackage's signer option"
    - "Local setup helpers that took a bare pubkey string (createTestState, createTestGroupState) retyped to take the PrivateKeyAccount directly and pass its .signer through (migration rule 6), matching the pattern established in 07-03's group-engine.test.ts"
    - "getPublicKey-only EventSigner stubs replaced by the matching testAccount's real .signer wherever that identity already backs a migrated KeyPackage credential in the same fixture"

key-files:
  created: []
  modified:
    - src/core/__tests__/darkmatter-invite-compat.test.ts
    - src/core/__tests__/key-package.test.ts
    - src/core/__tests__/group-message.test.ts
    - src/core/__tests__/key-package-event.test.ts
    - src/core/__tests__/group.test.ts
    - src/core/__tests__/media.test.ts
    - src/core/components/__tests__/dictionary.test.ts
    - src/core/components/__tests__/safe-aad-parity.test.ts
    - src/client/group/__tests__/fork-tree-view.test.ts
    - src/client/group/__tests__/disbanded.test.ts
    - src/client/group/__tests__/group-media-service.test.ts
    - src/client/group/__tests__/marmot-group.test.ts
    - src/client/__tests__/disband-routing.test.ts
    - src/client/__tests__/marmot-client.test.ts
    - src/client/__tests__/key-package-manager.test.ts
    - src/client/group/proposals/__tests__/invite-user.test.ts
    - src/client/session/__tests__/group-session.test.ts

key-decisions:
  - "Used the plan's default slot mapping throughout (a->6, d->9, e->11, 2->0, 3->1, 884704bd...c3a6->5), needing no new slot choices"
  - "key-package.test.ts's 'default capabilities' test asserted leafNode.extensions has length 1; since every call in the suite now carries a real signer (D-02), the leaf always emits the account-identity-proof extension alongside app_data_dictionary. Updated the assertion from 1 to 2 extensions — a necessary consequence of the migration, not a weakened assertion (the extensions[0] type check still pins app_data_dictionary first)"
  - "Left the forged-proof admin-policy test in marmot-group.test.ts untouched, per plan instruction (it hand-builds a leaf and never calls generateKeyPackage; plan 07-07 rewrites it)"
  - "Left invite-user.test.ts's 'rejects an invitee whose leaf carries no proof extension' test's proof-less generateKeyPackage call unchanged, per plan instruction (the one documented D-02 exception; plan 07-06 rewrites it)"

patterns-established:
  - "The same order-preserving default slot mapping from 07-03 is now consistent across all core, client, and engine test suites in this phase"

requirements-completed: [PROOF-03]

coverage:
  - id: D1
    description: "Every generateKeyPackage call in the 17 core and client unit test files passes a real signer whose pubkey equals the credential identity, except the one documented proof-less case in invite-user.test.ts"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "signer gate (node one-liner from 07-04-PLAN.md context) over the 16 non-exception files"
        status: pass
      - kind: unit
        ref: "signer gate run alone on src/client/group/proposals/__tests__/invite-user.test.ts (exactly one hit, the documented exception)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Raw-digest proof-signer functions (signAccountIdentityProof + secretKey) replaced by PrivateKeyAccount.signer in key-package.test.ts, darkmatter-invite-compat.test.ts, and invite-user.test.ts"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "grep -c accountProofSigner across the three files (0 in each)"
        status: pass
      - kind: unit
        ref: "pnpm vitest run (full suite, 99 files / 1102 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Byte-pinned dictionary and SafeAAD parity assertions unchanged and green"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "grep -c 00061b1a0001131200018001800380048005800680078008800c00020100 dictionary.test.ts (1, unchanged)"
        status: pass
      - kind: unit
        ref: "pnpm vitest run src/core/components/__tests__/dictionary.test.ts src/core/components/__tests__/safe-aad-parity.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "No production file, export, or fixture changed by this plan"
    verification:
      - kind: unit
        ref: "git diff --stat HEAD -- src ':(exclude)src/**/__tests__/**' ':(exclude)src/__tests__/**' (empty)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full suite and typecheck stay green after the migration"
    verification:
      - kind: unit
        ref: "pnpm vitest run (full suite, 99 files / 1102 tests)"
        status: pass
      - kind: other
        ref: "pnpm exec tsc -p tsconfig.json --noEmit"
        status: pass

duration: 35min
completed: 2026-09-14
status: complete
---

# Phase 07 Plan 04: Core and Client Test Real-Signer Migration Summary

**All 17 core and client unit test files under `src/core/__tests__/`, `src/core/components/__tests__/`, and `src/client/**/__tests__/` now build every KeyPackage with a real `testAccount()` (or `PrivateKeyAccount.fromKey`) signer matching the credential identity, with the one documented proof-less exception in `invite-user.test.ts` left for plan 07-06.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 17 (0 created)

## Accomplishments

- Migrated 8 core and component unit test files (Task 1: `darkmatter-invite-compat.test.ts`, `key-package.test.ts`, `group-message.test.ts`, `key-package-event.test.ts`, `group.test.ts`, `media.test.ts`, `dictionary.test.ts`, `safe-aad-parity.test.ts`) to pass a real signer on every `generateKeyPackage` call, replacing raw-digest proof-signer functions with `PrivateKeyAccount.fromKey(secretKey).signer` and literal `884704bd...c3a6` credentials with `testAccount(5)`.
- `group-message.test.ts`'s local `createTestState` helper was retyped to take a `PrivateKeyAccount` directly (migration rule 6) instead of a bare pubkey string.
- `key-package-event.test.ts` had 16 `generateKeyPackage` call sites across 4 independent `describe` blocks, each declaring its own `validPubkey` local — all migrated to `testAccount(5)` consistently.
- Migrated the remaining 9 client, group, session, and proposal unit test files (Task 2: `fork-tree-view.test.ts`, `disbanded.test.ts`, `group-media-service.test.ts`, `marmot-group.test.ts`, `disband-routing.test.ts`, `marmot-client.test.ts`, `key-package-manager.test.ts`, `invite-user.test.ts`, `group-session.test.ts`).
- `marmot-group.test.ts`'s local `createTestGroupState` helper was retyped to take a `PrivateKeyAccount` directly, matching the pattern 07-03 established for `group-engine.test.ts`'s `createTestGroupState`. Every hand-built `getPublicKey`-only `EventSigner` stub in this file (7 occurrences across 6 tests constructing `MarmotGroup`) was replaced with the matching `testAccount`'s real signer, and the now-unused `EventSigner` import was dropped.
- `invite-user.test.ts`'s `keyPackageWithProof` helper now passes `PrivateKeyAccount.fromKey(secretKey).signer` instead of a raw-digest `accountProofSigner` function; the intentional proof-less `generateKeyPackage` call in "rejects an invitee whose leaf carries no proof extension" was left exactly as-is, per the plan's explicit instruction (plan 07-06 rewrites it).
- `key-package-manager.test.ts`'s 7 directly-constructed `generateKeyPackage` calls (outside the manager's own `create()`/`rotate()` flow) now thread the `beforeEach`-scoped `account.signer` — the same account whose pubkey already backs the credential in each case.
- The signer gate (the plan's Node one-liner) prints nothing and exits 0 across all 16 non-exception files; run alone against `invite-user.test.ts` it prints exactly the one documented proof-less line.

## Task Commits

1. **Task 1: Real signers in core and component unit tests (D-02, D-04)** - `27c6aad` (test)
2. **Task 2: Real signers in client, group, session, and proposal unit tests (D-02, D-04)** - `32ac1ea` (test)

**Plan metadata:** pending (this SUMMARY + STATE/ROADMAP update commit)

## Files Created/Modified

- `src/core/__tests__/darkmatter-invite-compat.test.ts` - `generateOpenTuiStyleKeyPackage`'s raw-digest `accountProofSigner` replaced with `PrivateKeyAccount.fromKey(secretKey).signer`; dropped the now-unused `signAccountIdentityProof` import
- `src/core/__tests__/key-package.test.ts` - All 12 `generateKeyPackage` calls migrated; `validPubkey` now derives from `testAccount(5)`; the account-identity-proof test uses `PrivateKeyAccount.fromKey`; dropped now-unused `bytesToHex`/`schnorr`/`signAccountIdentityProof` imports; updated one assertion (see Decisions)
- `src/core/__tests__/group-message.test.ts` - `createTestState` retyped to take a `PrivateKeyAccount`; five call sites migrated to `testAccount(6/1/9/11/2)`
- `src/core/__tests__/key-package-event.test.ts` - 16 call sites across 4 `describe` blocks migrated to `testAccount(5)`
- `src/core/__tests__/group.test.ts` - Both admin fixtures migrated to `testAccount(6)`
- `src/core/__tests__/media.test.ts` - `makeClientState`'s admin fixture migrated to `testAccount(6)`
- `src/core/components/__tests__/dictionary.test.ts` - Two `884704bd...c3a6` credentials migrated to `testAccount(5)`; pinned dictionary hex unchanged
- `src/core/components/__tests__/safe-aad-parity.test.ts` - Same literal migrated to `testAccount(5)`; pinned SafeAAD hex unchanged
- `src/client/group/__tests__/fork-tree-view.test.ts` - `MEMBER`/`SIGNER` and the admin fixture migrated to `testAccount(11)`/`testAccount(6)`; dropped now-unused `EventSigner` import
- `src/client/group/__tests__/disbanded.test.ts` - `fixture()` migrated to `testAccount(6)`, returning `account` alongside `pubkey`; 4 `getPublicKey`-only stubs replaced with `account.signer`; dropped now-unused `EventSigner` import
- `src/client/group/__tests__/group-media-service.test.ts` - `ADMIN` fixture migrated to `testAccount(6)`
- `src/client/group/__tests__/marmot-group.test.ts` - `createTestGroupState` retyped to take a `PrivateKeyAccount`; 8 direct `generateKeyPackage` calls and 7 `EventSigner` stubs across 10 tests migrated to `testAccount(6/9/11)`; the hand-built forged-proof test left untouched; dropped now-unused `EventSigner` import
- `src/client/__tests__/disband-routing.test.ts` - Single fixture migrated to `testAccount(6)`; dropped now-unused `EventSigner` import
- `src/client/__tests__/marmot-client.test.ts` - 4 `createSimpleGroup`-backing fixtures in the "admin pubkey deduplication" describe migrated to `testAccount(6)`; `bob`/`c` literals left as-is (never back a KeyPackage)
- `src/client/__tests__/key-package-manager.test.ts` - 7 directly-constructed `generateKeyPackage` calls now pass the `beforeEach`-scoped `account.signer`
- `src/client/group/proposals/__tests__/invite-user.test.ts` - `keyPackageWithProof` migrated to `PrivateKeyAccount.fromKey(secretKey).signer`; dropped now-unused `bytesToHex`/`schnorr`/`signAccountIdentityProof` imports; proof-less test left unchanged
- `src/client/session/__tests__/group-session.test.ts` - `ADMIN`/`MEMBER` module constants migrated to `testAccount(6)`/`testAccount(9)`

## Decisions Made

- Used the plan's default slot mapping everywhere a literal appeared (`a`→6, `d`→9, `e`→11, `2`→0, `3`→1, `884704bd...c3a6`→5), so no new slot choices were needed.
- Updated one assertion in `key-package.test.ts`'s "should generate a valid key package with default capabilities" test: `leafNode.extensions` length changed from 1 to 2. This test previously exercised the proof-less path (no signer) to check default leaf extension count; since D-02 requires every call in this suite to carry a real signer, the leaf now always emits the account-identity-proof extension alongside `app_data_dictionary`. This is a necessary, non-weakening consequence of the migration — the `extensions[0]` type-check assertion (pinning `app_data_dictionary` first) is preserved, and the count increase reflects genuinely different code behavior, not a relaxed test.
- Left the forged-proof admin-policy test in `marmot-group.test.ts` and the proof-less test in `invite-user.test.ts` exactly as the plan specified — both are explicitly out of this plan's scope (07-07 and 07-06 respectively).

## Deviations from Plan

None - plan executed exactly as written, aside from the one necessary assertion update documented above under Decisions Made (which the plan's own migration rule 7 anticipates and requires listing, not a deviation from instructions).

## Issues Encountered

None - all 17 files migrated cleanly; the full suite passed on first run after the assertion fix in `key-package.test.ts`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 07-06 has a clean, verified precondition alongside 07-02, 07-03, and this plan: the signer gate over all core, client, and engine test files (minus the one documented exception) exits 0, so making core `generateKeyPackage`'s `signer` required will not break these suites.
- Plan 07-05 (integration/conformance test migration) can proceed independently on this same tree; this plan touched only the 17 files listed above.
- Plan 07-07 has a known, isolated target for its forged-proof-leaf rewrite in `marmot-group.test.ts`.
- Full suite green: `pnpm vitest run` (99 files / 1102 tests) and `pnpm exec tsc -p tsconfig.json --noEmit` both pass. No production file changed.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

- FOUND: src/core/__tests__/darkmatter-invite-compat.test.ts
- FOUND: src/core/__tests__/key-package.test.ts
- FOUND: src/core/__tests__/group-message.test.ts
- FOUND: src/core/__tests__/key-package-event.test.ts
- FOUND: src/core/__tests__/group.test.ts
- FOUND: src/core/__tests__/media.test.ts
- FOUND: src/core/components/__tests__/dictionary.test.ts
- FOUND: src/core/components/__tests__/safe-aad-parity.test.ts
- FOUND: src/client/group/__tests__/fork-tree-view.test.ts
- FOUND: src/client/group/__tests__/disbanded.test.ts
- FOUND: src/client/group/__tests__/group-media-service.test.ts
- FOUND: src/client/group/__tests__/marmot-group.test.ts
- FOUND: src/client/__tests__/disband-routing.test.ts
- FOUND: src/client/__tests__/marmot-client.test.ts
- FOUND: src/client/__tests__/key-package-manager.test.ts
- FOUND: src/client/group/proposals/__tests__/invite-user.test.ts
- FOUND: src/client/session/__tests__/group-session.test.ts
- FOUND: 27c6aad (Task 1 commit)
- FOUND: 32ac1ea (Task 2 commit)
