---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 01
subsystem: auth
tags: [mls, nostr, account-identity-proof, app-components, ts-mls]

# Dependency graph
requires:
  - phase: 06-shared-authorization-proof-envelope-primitive
    provides: "src/core/authorization-proof.ts — MarmotAuthorizationProof envelope codec, produce/verify, NIP-01 event-id reconstruction"
provides:
  - "marmot.member.account-identity-proof.v2 (0x8009) proof class: template, producer, leaf/KeyPackage/tree validators, GroupContext profile classifier, container location guards"
  - "ACCOUNT_IDENTITY_PROOF_COMPONENT_ID (0x8009) and ACCOUNT_IDENTITY_PROOF_COMPONENT id/name constants"
  - "GroupContext builder guard (makeAppComponentsExtension) and commit-integrity guard (validateAppComponentIntegrity) rejecting 0x8009 as group-level state"
affects: [07-02, 07-03, 07-04, 07-06, 07-07, 07-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Proof class over shared envelope primitive: a proof class supplies only { kind, tags, content } + validators; all envelope bytes/verification live in the Phase 6 primitive, never re-implemented"
    - "Raw dictionary parse (BinaryReader.vector, no getAppDataDictionary) to detect duplicate componentIds that a Map-collapsing decoder would silently hide"
    - "Explicit ciphersuite parameter on every validator (never inferred from the leaf/KeyPackage itself)"

key-files:
  created:
    - src/core/components/account-identity-proof.ts
    - src/core/components/__tests__/account-identity-proof.test.ts
  modified:
    - src/core/components/ids.ts
    - src/core/components/dictionary.ts
    - src/core/components/integrity.ts
    - src/core/components/index.ts
    - src/core/components/__tests__/integrity.test.ts
    - src/__tests__/exports.test.ts

key-decisions:
  - "Attached only PROOF-02 to requirements.mark-complete this plan; PROOF-04/05/06 and CUT-02 are also declared on 07-06's frontmatter (the seam-wiring plan) and stay Pending in REQUIREMENTS.md until the validators are actually wired into send/inbound/join seams"
  - "Legacy 0xf2f1 extension type kept private (not exported) per CUT-01, used only to detect and reject it"
  - "validateLeafAccountIdentityProof deliberately narrower than MDK: rejects legacy-only leaves outright (no ProtocolProfile::Legacy acceptance), per the milestone's clean-cut decision"

patterns-established:
  - "14-literal AccountIdentityProofRejectReason union declared up front (Task 1), all reasons thrown by Task 2's validators — matches Phase 6's AuthorizationProofError precedent"

requirements-completed: [PROOF-02]

coverage:
  - id: D1
    description: "accountIdentityProofTemplate + produceAccountIdentityProof reproduce the spec signing test vector byte-for-byte (event id, signature, 104-byte component)"
    requirement: "PROOF-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#produceAccountIdentityProof (spec signing test vector) > reproduces the exact 104-byte component for the spec vector"
        status: pass
    human_judgment: false
  - id: D2
    description: "validateLeafAccountIdentityProof rejects every PROOF-04/CUT-02 failure mode (missing support/data, mismatch, bad signature, legacy/mixed leaves) with a typed reason -- pure validator, not yet wired into a production seam"
    requirement: "PROOF-04"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#validateLeafAccountIdentityProof"
        status: pass
    human_judgment: true
    rationale: "Requirement text describes rejection at KeyPackage/leaf validation time; that seam wiring is plan 07-06's job. Verified here only as a pure function, not yet reachable from any production code path."
  - id: D3
    description: "validateKeyPackageAccountIdentityProof rejects 0x8009 in KeyPackage-level extensions (PROOF-05) -- pure validator, not yet wired"
    requirement: "PROOF-05"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#validateKeyPackageAccountIdentityProof"
        status: pass
    human_judgment: true
    rationale: "Same as D2 -- pure layer only; seam wiring is 07-06."
  - id: D4
    description: "GroupContext dictionary, KeyPackage-level, and GroupInfo placements of 0x8009 are rejected (PROOF-06); AppEphemeral documented as a gap (no ts-mls surface)"
    requirement: "PROOF-06"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#assertNoAccountIdentityProofComponent (PROOF-06, D-08)"
        status: pass
      - kind: unit
        ref: "src/core/components/__tests__/integrity.test.ts#validateAppComponentIntegrity leaf-only 0x8009 cases"
        status: pass
    human_judgment: true
    rationale: "GroupContext/KeyPackage/GroupInfo pure guards are complete and enforced at the builder (makeAppComponentsExtension) and commit-integrity layer; seam wiring for send/inbound/join is 07-06."
  - id: D5
    description: "classifyGroupAccountIdentityProofProfile / assertCurrentGroupAccountIdentityProofProfile reject legacy and mixed groups (CUT-02) -- pure helpers, not yet wired"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#classifyGroupAccountIdentityProofProfile"
        status: pass
      - kind: unit
        ref: "src/core/components/__tests__/account-identity-proof.test.ts#assertCurrentGroupAccountIdentityProofProfile"
        status: pass
    human_judgment: true
    rationale: "Same as D2/D3 -- pure layer only; seam wiring is 07-06."

# Metrics
duration: 25min
completed: 2026-09-14
status: complete
---

# Phase 7 Plan 1: Account Identity Proof v2 Component (0x8009) — Pure Layer Summary

**New `marmot.member.account-identity-proof.v2` (0x8009) proof class built entirely on the Phase 6 `MarmotAuthorizationProof` primitive — kind-450 template/producer byte-exact to the spec signing vector, full leaf/KeyPackage/tree validators, GroupContext profile classifier, and container location guards rejecting 0x8009 as GroupContext state — with no production seam wired yet and the legacy `0xf2f1` module untouched.**

## Performance

- **Duration:** 25 min
- **Completed:** 2026-09-14
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- `accountIdentityProofTemplate` + `produceAccountIdentityProof` reproduce the spec's signing test vector byte-for-byte: event id `b7e9a15dd8...`, signature `c5315d3c85...`, 104-byte component `f9308a01...bbdfb5d` — all through `produceAuthorizationProof`/`encodeAuthorizationProof` from `src/core/authorization-proof.ts`, no re-implemented hashing or signing.
- `validateLeafAccountIdentityProof` enforces the full 11-step spec validation order for a single LeafNode against an explicit ciphersuite (never inferred from the leaf): credential validity, legacy-extension rejection, exactly-one-dictionary/duplicate/ordering checks, independent support-list vs. data-entry checks, SafeAAD location guard, per-scheme signature-key length, then envelope decode/identity-match/verify.
- `validateKeyPackageAccountIdentityProof`, `validateGroupMemberAccountIdentityProofs`, `classifyGroupAccountIdentityProofProfile`, `assertCurrentGroupAccountIdentityProofProfile`, `assertNoAccountIdentityProofComponent`, and `hasAccountIdentityProofMaterial` round out the class: KeyPackage-level and whole-tree validation, the four-way (current/legacy/mixed/neither) group profile classifier, and container guards for GroupContext/KeyPackage/GroupInfo.
- `makeAppComponentsExtension` (dictionary.ts) and `validateAppComponentIntegrity` (integrity.ts) both now refuse `0x8009` as GroupContext state — at build time and at commit-integrity time — mirroring MDK's `CURRENT_PROFILE_LEAF_ONLY_APP_COMPONENTS`.
- All 13 new runtime symbols reach the package root through `src/core/components/index.ts`; `src/__tests__/exports.test.ts`'s inline snapshot updated with exactly 13 insertions, 0 deletions.
- 89 new/updated tests (61 in `account-identity-proof.test.ts` including a real ts-mls `KeyPackage` → `createSimpleGroup` round trip, 3 new in `integrity.test.ts`, plus the regenerated exports snapshot); full suite green on Node (98 files / 1097 tests) with Bun and Deno smoke passing.
- Legacy `src/core/account-identity-proof.ts` (`0xf2f1`) is byte-unchanged.

## Task Commits

1. **Task 1: Component constants, typed error, kind-450 template and producer** - `e43afc5` (feat)
2. **Task 2: Leaf, KeyPackage, and whole-tree validators, GroupContext profile classifier, and location guard** - `e4f3c83` (feat)
3. **Task 3: GroupContext and AppDataUpdate leaf-only guards, barrel export, exports snapshot, cross-runtime gates** - `e1af03e` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `src/core/components/account-identity-proof.ts` - New: the 0x8009 proof class (template, producer, all validators, classifier, guards)
- `src/core/components/__tests__/account-identity-proof.test.ts` - New: 61 tests covering the spec vector and one negative test per reject reason
- `src/core/components/ids.ts` - `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID` (0x8009) and `ACCOUNT_IDENTITY_PROOF_COMPONENT` name constants
- `src/core/components/dictionary.ts` - `makeAppComponentsExtension` rejects a 0x8009 data entry (UsageError), same shape as the existing SafeAAD guard
- `src/core/components/integrity.ts` - `validateAppComponentIntegrity` rejects AppDataUpdate ops and resulting entries targeting leaf-only 0x8009
- `src/core/components/index.ts` - Barrel re-exports `account-identity-proof.js`
- `src/core/components/__tests__/integrity.test.ts` - 3 new leaf-only-guard cases
- `src/__tests__/exports.test.ts` - Regenerated inline snapshot (+13 symbols)

## Decisions Made

- Attached only `PROOF-02` to `requirements mark-complete`. `PROOF-04`, `PROOF-05`, `PROOF-06`, and `CUT-02` are declared on both this plan's and plan 07-06's frontmatter — this plan builds and unit-tests the pure validators/classifier/guards, but no production seam (send/inbound/join/convergence) calls them yet. Marking those four requirements "Complete" in `REQUIREMENTS.md` before 07-06 wires the seams would misstate what a downstream client can actually rely on today. They remain "Pending" and will flip to "Complete" when 07-06 lands.
- Kept the legacy `0xf2f1` extension-type constant (`LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE`) private/unexported per CUT-01 — it exists only so validators can detect and reject it, never as a re-export.
- `validateLeafAccountIdentityProof` rejects a legacy-only leaf outright (no MDK-style `ProtocolProfile::Legacy` acceptance) — the milestone's deliberate, narrower clean-cut divergence from MDK's transitional dual-profile support (CUT-02, Pitfall 10).

## Deviations from Plan

None - plan executed exactly as written. All three tasks' tests passed on first run with no auto-fixes needed.

## Issues Encountered

None.

## Known Stubs

None - every exported function is a complete implementation; no placeholder data, hardcoded empty values, or unwired UI paths were introduced.

## Threat Flags

None - every new surface (leaf/KeyPackage/tree validators, GroupContext profile classifier, container location guards, dictionary/integrity guards) is already covered by this plan's own `<threat_model>` (T-07-01..T-07-08), all disposition `mitigate` and addressed by the corresponding validator + test, except T-07-07 (GroupInfo/AppEphemeral), which is `accept` and recorded below as a documented gap.

## Deferred / Known Gaps

1. **PROOF-06 GroupInfo/AppEphemeral (T-07-07, accept):** `assertNoAccountIdentityProofComponent` covers a GroupInfo extension list structurally (pure guard, unit-tested), but no production code path in `src/` currently reads Marmot component data from a `GroupInfo` (`grep -rn "AppEphemeral" ts-mls/src src` returns nothing) — there is no `ts-mls` `AppEphemeral` proposal surface at all. This is a documented gap in current wire-format coverage, not a known vulnerability; it should be re-evaluated if/when `ts-mls` gains an `AppEphemeral` surface or a GroupInfo-reading code path is added.
2. **Phase 6 review warnings WR-01/WR-02/WR-03 deferred to Phase 8**, per the planner's decision recorded in this plan's `<context>`: this class builds its template only through `accountIdentityProofTemplate` (integer `kind`, ASCII string tags), so WR-01/WR-02 (decimal-tag / non-integer-kind regressions) are unreachable through it, and every validator in this module converts any envelope-primitive throw into `invalid-proof`, so WR-03's untyped escapes cannot leak through them. Phase 8, which maps `AuthorizationProofError.reason` directly at a production seam, should re-evaluate all three.
3. **Seam wiring not yet done (PROOF-04, PROOF-05, PROOF-06, CUT-02):** the validators, classifier, and guards built in this plan are pure and unit-tested but not called from any production code path (send, inbound, join, convergence, capability negotiation). Plan 07-06 wires them at every legality seam per D-05/D-15/D-16. See "Decisions Made" above for why the corresponding `REQUIREMENTS.md` rows stay `Pending` until then.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The `0x8009` proof class's full public surface (`accountIdentityProofTemplate`, `produceAccountIdentityProof`, `validateLeafAccountIdentityProof`, `validateKeyPackageAccountIdentityProof`, `validateGroupMemberAccountIdentityProofs`, `classifyGroupAccountIdentityProofProfile`, `assertCurrentGroupAccountIdentityProofProfile`, `assertNoAccountIdentityProofComponent`, `hasAccountIdentityProofMaterial`, `mlsSignatureSchemeForCiphersuite`, `AccountIdentityProofError`) is ready for 07-06 to wire into every legality seam.
- `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID`/`ACCOUNT_IDENTITY_PROOF_COMPONENT` exist but `SUPPORTED_APP_COMPONENT_IDS` and `DEFAULT_GROUP_COMPONENT_IDS` are deliberately untouched (07-06 owns that per D-05/D-15) — no downstream plan should assume 0x8009 is yet negotiated or required by any group created through this codebase.
- No blockers. The legacy `0xf2f1` module (`src/core/account-identity-proof.ts`) stays fully in place and unedited, as planned, until plan 07-07's clean-cut removal.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

All 8 created/modified source files and this SUMMARY.md verified present on disk; all 3 task commit hashes (`e43afc5`, `e4f3c83`, `e1af03e`) verified in `git log`.
