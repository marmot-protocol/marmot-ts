---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 06
subsystem: auth
tags: [mls, key-package, account-identity-proof, app-components, ts-mls, group]

# Dependency graph
requires:
  - phase: 07-01
    provides: "0x8009 proof class: template, producer, leaf/KeyPackage/tree validators, GroupContext profile classifier, container location guards (pure layer, not yet wired)"
  - phase: 07-02
    provides: "Core generateKeyPackage's additive signer option and deterministic testAccount(slot) test helper"
  - phase: 07-03..07-05
    provides: "Every generateKeyPackage call across engine/core/client/integration/conformance tests passes a real signer, so making signer required has no stragglers"
provides:
  - "generateKeyPackage requires signer, always emits a single app_data_dictionary leaf extension carrying the 0x8009 proof (no proof-less path, no legacy proof-signer option)"
  - "SUPPORTED_APP_COMPONENT_IDS and DEFAULT_GROUP_COMPONENT_IDS include 0x8009; ensureMarmotCapabilities/marmotRequiredCapabilitiesExtension stop advertising/requiring legacy 0xf2f1"
  - "Invite, admin-policy Add gate, and join-via-Welcome all validate through the plan 07-01 0x8009 validators with explicit ciphersuites, instead of the legacy verifier"
affects: [07-07, 08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "makeLeafAppComponentsExtension(proof, supportedIds?) builds one app_data_dictionary extension with exactly three entries (app_components list, empty SafeAAD, 0x8009 data) -- correct by construction, never a separate legacy extension"
    - "Every legality seam (invite/admin-policy/join) calls the class validator with an explicit ciphersuite (never inferred from the KeyPackage/leaf itself)"
    - "Projection-based byte pins for nondeterministic dictionaries: rebuild only the deterministic entries with the production builder rather than pinning a live proof's bytes"

key-files:
  created:
    - src/client/__tests__/join-account-identity-proof.test.ts
  modified:
    - src/core/key-package.ts
    - src/core/components/dictionary.ts
    - src/core/components/ids.ts
    - src/core/capabilities.ts
    - src/engine/admin-policy.ts
    - src/client/group/proposals/invite-user.ts
    - src/client/groups-manager.ts
    - src/core/__tests__/key-package.test.ts
    - src/core/__tests__/capabilities.test.ts
    - src/core/__tests__/group.test.ts
    - src/core/components/__tests__/dictionary.test.ts
    - src/core/__tests__/key-package-tag-parity.test.ts
    - src/core/__tests__/darkmatter-invite-compat.test.ts
    - src/client/group/proposals/__tests__/invite-user.test.ts

key-decisions:
  - "PROOF-03 was already marked Complete by plan 07-04 (premature per its own SUMMARY); re-verified here against the actual 0x8009 leaf format and left Complete since it is now genuinely true"
  - "CUT-01 stays Pending: its 'and the legacy proof exports are removed' clause is still false (src/core/account-identity-proof.ts and its src/core/index.ts re-export are untouched by design -- plan 07-07 deletes them). Marking it Complete now would misstate current capability, matching the precedent 07-01 set for premature completion"
  - "Marked PROOF-04, PROOF-05, PROOF-06, and CUT-02 Complete: every wire-seam behavior each requirement describes (typed rejections at invite; KeyPackage-level 0x8009 rejection; GroupContext/SafeAAD rejection; legacy-extension and mixed-profile rejection) is now reachable from production code and covered by a passing test, per the orchestrator's explicit instruction to mark per what this plan actually delivers"
  - "admin-policy's Add gate is a like-for-like swap only: hasAccountIdentityProofMaterial(leaf) still gates whether the leaf is validated at all, so a proof-less Add is still skipped (marked KNOWN GAP (D-06), unchanged scope, transferred to Phase 8 GRP-02/GRP-04) -- but legacy-only material is no longer skipped, it is now validated and rejected (CUT-02)"

patterns-established:
  - "Test files construct malformed leaf/KeyPackage fixtures by rebuilding the app_data_dictionary from raw entries via ts-mls's makeAppDataDictionaryExtension + buildAppDataDictionary directly, bypassing the production builder's guards, rather than mutating extensionData bytes in place"

requirements-completed: [PROOF-04, PROOF-05, PROOF-06, CUT-02]

coverage:
  - id: D1
    description: "generateKeyPackage requires signer, has no proof-less path and no legacy accountProofSigner option; every leaf carries exactly one app_data_dictionary extension whose app_components list includes 0x8009 once, whose SafeAAD entry is empty, and whose 0x8009 entry is exactly 104 bytes, built by makeLeafAppComponentsExtension(proof)"
    requirement: "PROOF-03"
    verification:
      - kind: unit
        ref: "src/core/__tests__/key-package.test.ts#0x8009 leaf proof (PROOF-03, D-15) > carries exactly one app_data_dictionary extension with a verifiable 0x8009 proof and no legacy extension"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/key-package.test.ts#0x8009 leaf proof (PROOF-03, D-15) > validates a KeyPackage generated with an external-style signer (PROOF-03)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SUPPORTED_APP_COMPONENT_IDS and DEFAULT_GROUP_COMPONENT_IDS include 0x8009; ensureMarmotCapabilities and marmotRequiredCapabilitiesExtension stop advertising/requiring 0xf2f1 (CUT-01 emission half; export-removal half deferred to 07-07)"
    requirement: "CUT-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/capabilities.test.ts#ensureMarmotCapabilities > should work with empty extensions array and never advertise the legacy 0xf2f1 extension"
        status: pass
      - kind: unit
        ref: "src/core/__tests__/group.test.ts#group construction > createGroup seeds a decodable app_data_dictionary from components"
        status: pass
    human_judgment: false
  - id: D3
    description: "proposeInviteUser validates the invitee KeyPackage with its own ciphersuite (required to equal the group's), rejecting legacy, proof-less, forged, misplaced, and ciphersuite-mismatched invitees with typed AccountIdentityProofError reasons"
    requirement: "PROOF-04"
    verification:
      - kind: unit
        ref: "src/client/group/proposals/__tests__/invite-user.test.ts (6 tests: valid, invalid-proof, missing-data, legacy-extension-present, invalid-location, ciphersuite-mismatch)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A 0x8009 proof placed in a KeyPackage-level extensions dictionary (not the LeafNode's) is rejected with invalid-location"
    requirement: "PROOF-05"
    verification:
      - kind: unit
        ref: "src/client/group/proposals/__tests__/invite-user.test.ts#rejects an invitee with a KeyPackage-level 0x8009 dictionary (invalid-location)"
        status: pass
    human_judgment: false
  - id: D5
    description: "joinFromWelcome requires the current profile and validates every member leaf before adopting state; a mixed-profile group or an invalid member proof is rejected with nothing persisted"
    requirement: "PROOF-06"
    verification:
      - kind: unit
        ref: "src/client/__tests__/join-account-identity-proof.test.ts (3 tests: current-profile join, mixed-profile rejection with empty groupStateStore, invalid-member-proof rejection with empty groupStateStore)"
        status: pass
    human_judgment: false
  - id: D6
    description: "The admin-policy Add gate validates any Add whose leaf carries proof material (0x8009 or legacy 0xf2f1) via validateKeyPackageAccountIdentityProof and rejects on failure; legacy-only material is no longer skipped"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/engine/admin-policy.ts (KNOWN GAP (D-06) comment marks the still-skipped no-proof-material case; hasAccountIdentityProofMaterial now covers 0x8009 and 0xf2f1)"
        status: pass
      - kind: other
        ref: "pnpm vitest run (full suite, 100 files / 1108 tests, including engine/__tests__/commit-authorization-seams.test.ts and commit-legality-seams.test.ts which exercise this callback)"
        status: pass
    human_judgment: false

# Metrics
duration: 30min
completed: 2026-09-14
status: complete
---

# Phase 7 Plan 6: Atomic Wire Cut to 0x8009 Summary

**`generateKeyPackage` now requires a signer and emits a single 0x8009 leaf proof by construction; new groups require 0x8009 and nothing advertises or requires the legacy 0xf2f1 extension; invite, admin-policy, and join-via-Welcome all validate through the class validators with explicit ciphersuites.**

## Performance

- **Duration:** ~30 min
- **Completed:** 2026-09-14
- **Tasks:** 3
- **Files modified:** 15 (1 created, 14 modified)

## Accomplishments

- `src/core/key-package.ts`: removed the legacy `accountProofSigner` option and the proof-less `MLSGenerateKeyPackage` path entirely. `signer: AuthorizationProofSigner` is now required; `createdAt?: number` (core-only, D-03) was added. `generateKeyPackage` always keygens the leaf signature key, calls `produceAccountIdentityProof`, and builds the leaf extensions with `makeLeafAppComponentsExtension(proof)` before calling `generateKeyPackageWithKey`.
- `src/core/components/dictionary.ts`: `makeLeafAppComponentsExtension` now requires a 104-byte `proof` argument (throws `UsageError` otherwise) and builds exactly three dictionary entries — the `app_components` list (always including `0x8009` once, regardless of `supportedIds`), an empty SafeAAD, and the `0x8009` proof data — correct by construction.
- `src/core/components/ids.ts`: `SUPPORTED_APP_COMPONENT_IDS` and `DEFAULT_GROUP_COMPONENT_IDS` both gained `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` (0x8009), so every leaf advertises it and every new group requires it.
- `src/core/capabilities.ts`: `ensureMarmotCapabilities` no longer pushes the legacy `0xf2f1` extension type; `marmotRequiredCapabilitiesExtension` now requires only `0x0006` (`app_data_dictionary`), matching MDK's `CURRENT_PROFILE_REQUIRED_GROUP_CONTEXT_EXTENSIONS`.
- `src/engine/admin-policy.ts`: the Add-proposal loop now uses `hasAccountIdentityProofMaterial` (covers both `0x8009` and legacy `0xf2f1`) to decide whether to validate at all, and `validateKeyPackageAccountIdentityProof(keyPackage, ciphersuiteId)` to validate — rejecting on any failure. A proof-less Add is still skipped, marked `KNOWN GAP (D-06)` and transferred to Phase 8.
- `src/client/group/proposals/invite-user.ts`: `proposeInviteUser` now calls `validateKeyPackageAccountIdentityProof(keyPackage, ciphersuite.id)` instead of the legacy verifier.
- `src/client/groups-manager.ts`: `joinFromWelcome` now calls `assertCurrentGroupAccountIdentityProofProfile(clientState.groupContext.extensions)` and `validateGroupMemberAccountIdentityProofs(clientState, clientState.groupContext.cipherSuite)` before `adoptClientState`, so a rejecting group persists nothing.
- Rewrote all seven format-bound unit test files for the current profile (103 tests), plus one new test file (`join-account-identity-proof.test.ts`, 3 tests) proving `joinFromWelcome` accepts a current-profile group and rejects mixed-profile and invalid-member-proof groups without persisting anything.
- Full suite green: `pnpm compile`, root `tsc --noEmit`, `pnpm vitest run` (100 files / 1108 tests), `pnpm conformance:extended`, `pnpm build` + opentui example typecheck, Bun and Deno smoke on `key-package.test.ts` + `join-account-identity-proof.test.ts`, and `prettier --check` on all 15 `files_modified` all pass.
- `grep -rlni "f2f1" src --include="*.ts" | grep -v "__tests__/"` now prints exactly `src/core/account-identity-proof.ts` and `src/core/components/account-identity-proof.ts` — the only two remaining production references to the legacy hex id, both inside the legacy module itself (plan 07-07 deletes it).

## Task Commits

1. **Task 1 + Task 2: Atomic production cut (signer required, 0x8009 leaf, D-05 requirement, capabilities, three proof seams) + format-bound unit test rewrite** - `2b051ec` (feat) — committed together per the plan's explicit sequencing note (neither compiles nor passes tests alone)
2. **Task 3: Join-via-Welcome wiring test and full cross-runtime gates** - `5de97fe` (test)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `src/core/key-package.ts` - Required-signer `generateKeyPackage`, `createdAt` option, always emits the 0x8009 leaf proof
- `src/core/components/dictionary.ts` - `makeLeafAppComponentsExtension(proof, supportedIds?)`, correct-by-construction three-entry dictionary
- `src/core/components/ids.ts` - `0x8009` added to `SUPPORTED_APP_COMPONENT_IDS` and `DEFAULT_GROUP_COMPONENT_IDS`
- `src/core/capabilities.ts` - `ensureMarmotCapabilities`/`marmotRequiredCapabilitiesExtension` drop the legacy `0xf2f1` requirement
- `src/engine/admin-policy.ts` - Add gate validates via `hasAccountIdentityProofMaterial` + `validateKeyPackageAccountIdentityProof`
- `src/client/group/proposals/invite-user.ts` - `proposeInviteUser` validates via `validateKeyPackageAccountIdentityProof(keyPackage, ciphersuite.id)`
- `src/client/groups-manager.ts` - `joinFromWelcome` requires the current profile and validates every member leaf before adopting state
- `src/core/__tests__/key-package.test.ts` - Rewritten 0x8009 leaf-proof behavior (happy path, external signer, createdAt, returned-pubkey-mismatch)
- `src/core/__tests__/capabilities.test.ts` - Asserts `0x0006`-only required extensions, no `0xf2f1`
- `src/core/__tests__/group.test.ts` - `getAppComponents` now includes `0x8009`; group classifies as `"current"`
- `src/core/components/__tests__/dictionary.test.ts` - Rewritten `makeLeafAppComponentsExtension` tests (proof-length guard, dedup, real-KeyPackage projection pin)
- `src/core/__tests__/key-package-tag-parity.test.ts` - Production tags now include `0x8009` (fixture-projection helper)
- `src/core/__tests__/darkmatter-invite-compat.test.ts` - Rewritten for the current profile; legacy Rust-fixture describe block removed
- `src/client/group/proposals/__tests__/invite-user.test.ts` - Six typed-rejection tests (valid, invalid-proof, missing-data, legacy-extension-present, invalid-location, ciphersuite-mismatch)
- `src/client/__tests__/join-account-identity-proof.test.ts` - New: `joinFromWelcome` current/mixed/invalid-member-proof coverage

## Decisions Made

- PROOF-03 was already marked Complete by plan 07-04 (premature per that plan's own SUMMARY). Re-verified it against the actual 0x8009 leaf format built here and left it Complete — it is now genuinely true (both raw-key and external signers validated in `key-package.test.ts`).
- CUT-01 stays Pending: its text requires both "never emits 0xf2f1" (now true) **and** "the legacy proof exports are removed" (still false — `src/core/account-identity-proof.ts` and its `src/core/index.ts` re-export are untouched by design; plan 07-07 deletes them). Marking it Complete now would misstate current capability.
- Marked PROOF-04, PROOF-05, PROOF-06, and CUT-02 Complete, per the orchestrator's instruction to mark based on what this plan actually delivers: every wire-seam behavior each requirement describes is now reachable from production code and covered by a passing test.
- admin-policy's Add gate is a like-for-like swap only (per the plan's explicit instruction): `hasAccountIdentityProofMaterial` still gates whether a leaf is validated at all, so a proof-less Add is still skipped (`KNOWN GAP (D-06)`, unchanged scope). Legacy-only material is no longer skipped — it is now validated and rejected (CUT-02).
- The Task 1 acceptance-criteria greps for the two `joinFromWelcome` call lines (`assertCurrentGroupAccountIdentityProofProfile(clientState.groupContext.extensions)` and `validateGroupMemberAccountIdentityProofs(clientState, clientState.groupContext.cipherSuite)` as single lines) do not match after Prettier wraps them across multiple lines (both exceed the 80-column print width). The calls are present with the exact arguments the plan specifies; only the literal single-line grep fails due to formatting, not a functional gap. Kept Prettier's wrapped formatting since `pnpm exec prettier --check` on all 15 `files_modified` is itself an explicit verification gate.

## Deviations from Plan

None - plan executed exactly as written, including the "Grep note" above which is a documented resolution of a spec-vs-formatter tension, not a functional deviation. All three tasks' tests passed on first run with no auto-fixes needed.

## Issues Encountered

None.

## Known Stubs

None - every changed function is a complete implementation; no placeholder data or unwired paths were introduced.

## Threat Flags

None beyond what this plan's own `<threat_model>` already covers (T-07-26..T-07-33, all disposition `mitigate` or documented `transfer`/`accept`). See Deferred / Known Gaps below for the two `transfer`-dispositioned items (T-07-30, T-07-31).

## Deferred / Known Gaps

1. **D-06 (admin-policy skip):** `createAdminCommitPolicyCallback`'s Add loop still skips validation entirely for an Add whose leaf carries no account-identity-proof material at all (`hasAccountIdentityProofMaterial` returns `false`) — marked `KNOWN GAP (D-06)` in `src/engine/admin-policy.ts`. Phase 8 (GRP-02/GRP-04) must close this so a proof-less Add is rejected, not merely allowed to pass through unvalidated.
2. **D-10 (stored legacy groups):** Stored v1.0 groups requiring the legacy `0xf2f1` extension continue to load and operate locally untouched — `GroupRegistry.load`, hydration, and `adoptClientState` were deliberately not touched by this plan (`git diff --quiet HEAD -- src/client/group-registry.ts src/client/group/marmot-group.ts` confirmed empty). Phase 8's legality seams must reject them going forward.
3. **Send/ingest/pool-replay/convergence seams:** the profile classifier and leaf validators built here are wired at invite, admin-policy Add, and join-via-Welcome only. The send, ingest, pool-replay, and convergence seams do not yet call them — Phase 8 (GRP-02) is the seam that closes this.
4. **CUT-01 export removal:** the legacy `src/core/account-identity-proof.ts` module (and its `src/core/index.ts` barrel re-export) remains fully in place, byte-unchanged, as designed. Plan 07-07 deletes it, at which point CUT-01 can flip to Complete.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 07-07 has a clean, fully-isolated target: the legacy module (`src/core/account-identity-proof.ts`) and its test file have no remaining production importers anywhere in `src/` — the standing grep gate (`grep -rlni "f2f1" src --include="*.ts" | grep -v "__tests__/"`) confirms only the legacy module and its 0x8009-neighbor file mention the hex id, and the latter's mentions are all in constant/comment form documenting the legacy id for detection, never importing from the legacy module.
- Full suite, extended conformance, build, example typecheck, and Bun/Deno smoke all green — no regression risk carried forward.
- REQUIREMENTS.md: PROOF-03 through PROOF-06 and CUT-02 are Complete; CUT-01 stays Pending until 07-07's deletion.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

All 15 `files_modified` (14 modified, 1 created) verified present on disk; both task commit hashes (`2b051ec`, `5de97fe`) verified in `git log`.
