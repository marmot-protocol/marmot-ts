---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
verified: 2026-09-14T20:25:50Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 7: Account Identity Proof Component (0x8009) / Legacy Clean Cut Verification Report

**Phase Goal:** KeyPackages and member leaves carry the adopted `0x8009` account identity proof component byte-exact
with the spec's signing test vector, and the legacy `0xf2f1` proof is fully removed from publish, verify,
capabilities, and admin policy with no fallback path.
**Verified:** 2026-09-14T20:25:50Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Building the kind-450 proof event from the spec's signing test vector reproduces its exact event id, signature, and 104-byte component byte-for-byte | ✓ VERIFIED | `src/core/components/account-identity-proof.ts` `accountIdentityProofTemplate` + `produceAccountIdentityProof`; independently cross-checked the vector against `refs/marmot/app-components/account-identity-proof-v2.md` "Signing test vector" (event id `b7e9a15d...`, component `f9308a01...bbdfb5d`) and `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs::current_proof_matches_the_adopted_signing_vector` (same literals) — not a self-generated fixture. `pnpm vitest run src/core/components/__tests__/account-identity-proof.test.ts` → 61/61 pass, including the exact byte-for-byte assertion |
| 2 | A generated KeyPackage/leaf — via both raw-key and external signers — advertises `0x8009` in `app_components` and carries exactly one `0x8009` entry in its single `app_data_dictionary` | ✓ VERIFIED | `src/core/key-package.ts::generateKeyPackage` always builds the leaf via `produceAccountIdentityProof` + `makeLeafAppComponentsExtension(proof)` (`src/core/components/dictionary.ts`, exactly 3 entries: app_components list, empty SafeAAD, one 104-byte 0x8009 entry; throws `UsageError` on any other proof length). `src/core/__tests__/key-package.test.ts` exercises both a `testAccount(slot)` raw-key `PrivateKeyAccount` signer and a hand-rolled `{ signEvent }` external-style signer, both asserting `advertised` includes 0x8009 exactly once and the leaf's single `0x8009` entry is 104 bytes; `pnpm vitest run` confirms pass |
| 3 | A KeyPackage or leaf is rejected when `0x8009` support/data is missing, signer/ciphersuite/scheme/signature-key mismatches, or signature fails to verify; a misplaced `0x8009` entry (KeyPackage-level extensions, GroupContext, GroupInfo, SafeAAD) is also rejected | ✓ VERIFIED | `validateLeafAccountIdentityProof`/`validateKeyPackageAccountIdentityProof`/`assertNoAccountIdentityProofComponent` implement all 14 reject reasons in the documented order; `account-identity-proof.test.ts` has one test per reason including `missing-support`, `missing-data`, `duplicate-data`, `ciphersuite-mismatch`, `signature-key-mismatch`, `identity-mismatch`, `invalid-proof` (tampered signature, substituted key, substituted ciphersuite, bad length, bad created_at), and `invalid-location` for KeyPackage-level, SafeAAD, and GroupContext placement. `AppEphemeral`/GroupInfo have no production consumer in ts-mls (documented gap, pure guard only — see Gaps below, non-blocking) |
| 4 | marmot-ts never emits `0xf2f1` anywhere (leaves, `Capabilities.extensions`, required capabilities), and legacy proof exports no longer exist in the package | ✓ VERIFIED | `grep -rlni "f2f1" src examples/opentui/src \| grep -v "__tests__/"` → exactly `src/core/components/account-identity-proof.ts` (a private, unexported detection-only constant). `src/core/capabilities.ts` no longer pushes/requires `0xf2f1`. `src/core/account-identity-proof.ts` (legacy module) confirmed deleted from disk; its `src/core/index.ts` barrel line removed; `src/__tests__/exports.test.ts` confirmed to contain none of the 15 legacy symbol names and all 13 new `0x8009` symbol names. `pnpm build` and `pnpm compile` both exit 0 |
| 5 | Any KeyPackage, leaf, or group still carrying or requiring `0xf2f1` is rejected outright | ✓ VERIFIED | `validateLeafAccountIdentityProof` step 2 rejects any leaf carrying the legacy extension type (legacy-only or mixed) with `legacy-extension-present`; `validateKeyPackageAccountIdentityProof` rejects KeyPackage-level `0xf2f1`; `classifyGroupAccountIdentityProofProfile`/`assertCurrentGroupAccountIdentityProofProfile` reject `legacy`/`mixed` GroupContext profiles. Wired at all three production seams this phase owns: invite (`src/client/group/proposals/invite-user.ts`), admin-policy Add gate (`src/engine/admin-policy.ts`, now validates legacy-only material instead of skipping it), and join-via-Welcome (`src/client/groups-manager.ts::joinFromWelcome`, checked before `adoptClientState` so nothing persists on rejection). `src/client/__tests__/join-account-identity-proof.test.ts` proves a mixed-profile group is rejected with an empty `groupStateStore` afterward; `src/engine/__tests__/group-engine.test.ts` proves the admin-policy gate rejects a legacy-only Add |

**Score:** 5/5 ROADMAP success criteria verified, 0 behavior-unverified.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src/core/components/account-identity-proof.ts` | 0x8009 proof class: template, producer, validators, classifier, guards | ✓ VERIFIED | 683 lines; all 15 exported symbols present (`AccountIdentityProofError`, `accountIdentityProofTemplate`, `produceAccountIdentityProof`, `validateLeafAccountIdentityProof`, `validateKeyPackageAccountIdentityProof`, `validateGroupMemberAccountIdentityProofs`, `classifyGroupAccountIdentityProofProfile`, `assertCurrentGroupAccountIdentityProofProfile`, `assertNoAccountIdentityProofComponent`, `hasAccountIdentityProofMaterial`, `mlsSignatureSchemeForCiphersuite`, plus types); read in full, matches spec and MDK reference byte-for-byte |
| `src/core/components/ids.ts` | `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID = 0x8009` in both `SUPPORTED_APP_COMPONENT_IDS` and `DEFAULT_GROUP_COMPONENT_IDS` | ✓ VERIFIED | Confirmed present exactly once in each list |
| `src/core/key-package.ts` | Required-signer KeyPackage generation with 0x8009 leaf proof, no legacy option | ✓ VERIFIED | `signer: AuthorizationProofSigner` required, no legacy `accountProofSigner` import, no proof-less path, `createdAt?: number` core-only option present |
| `src/core/components/dictionary.ts` | `makeLeafAppComponentsExtension(proof, supportedIds?)` correct-by-construction builder | ✓ VERIFIED | Requires exactly 104-byte proof (`UsageError` otherwise); builds exactly 3 entries |
| `src/core/capabilities.ts` | No `0xf2f1` advertised or required | ✓ VERIFIED | `grep -ci f2f1` → 0; required extensions is `[0x0006]` only |
| `src/engine/admin-policy.ts` | Add gate validates via 0x8009 class validator | ✓ VERIFIED | Imports `hasAccountIdentityProofMaterial`/`validateKeyPackageAccountIdentityProof`; `KNOWN GAP (D-06)` comment documents the one deferred item (see Gaps) |
| `src/client/group/proposals/invite-user.ts` | Invitee validated via `validateKeyPackageAccountIdentityProof(keyPackage, ciphersuite.id)` | ✓ VERIFIED | Confirmed, no legacy import |
| `src/client/groups-manager.ts` | `joinFromWelcome` requires current profile + validates every member leaf before adopting state | ✓ VERIFIED | `assertCurrentGroupAccountIdentityProofProfile` + `validateGroupMemberAccountIdentityProofs` called before `adoptClientState`; `git diff --quiet HEAD -- src/client/group-registry.ts src/client/group/marmot-group.ts` confirms load path untouched (D-10, deferred to Phase 8 by design) |
| `src/__tests__/exports.test.ts` | Root export snapshot: 15 legacy symbols gone, 13 new symbols present | ✓ VERIFIED | Both checked directly against the file; `pnpm vitest run src/__tests__/exports.test.ts` passes |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `src/core/key-package.ts` | `src/core/components/account-identity-proof.ts` | `produceAccountIdentityProof(...)` | ✓ WIRED | Called before leaf-key generation completes; result feeds `makeLeafAppComponentsExtension` |
| `src/core/key-package.ts` | `src/core/components/dictionary.ts` | `makeLeafAppComponentsExtension(proof)` | ✓ WIRED | Confirmed in source |
| `src/client/group/proposals/invite-user.ts` | `src/core/components/account-identity-proof.ts` | `validateKeyPackageAccountIdentityProof(keyPackage, ciphersuite.id)` | ✓ WIRED | Confirmed, explicit ciphersuite passed (D-16) |
| `src/engine/admin-policy.ts` | `src/core/components/account-identity-proof.ts` | `hasAccountIdentityProofMaterial` + `validateKeyPackageAccountIdentityProof` | ✓ WIRED | Confirmed; legacy-only material is now validated-and-rejected, not skipped |
| `src/client/groups-manager.ts` | `src/core/components/account-identity-proof.ts` | `assertCurrentGroupAccountIdentityProofProfile` + `validateGroupMemberAccountIdentityProofs` | ✓ WIRED | Called in `joinFromWelcome` before state adoption |
| `src/core/index.ts` | `src/core/components/index.ts` | account-identity-proof surface only via components barrel | ✓ WIRED | Legacy barrel line removed; only the current module's barrel line remains |

### Behavioral Spot-Checks / Test Execution

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| Full build | `pnpm build` | ts-mls fork build, tsc build, vendor copy all succeed | ✓ PASS |
| Full test suite | `pnpm vitest run` | 98 files / 1097 tests, all pass | ✓ PASS |
| Extended conformance | `pnpm conformance:extended` | 1/1 pass | ✓ PASS |
| Spec vector byte-exact reproduction | `pnpm vitest run src/core/components/__tests__/account-identity-proof.test.ts` | 61/61 pass | ✓ PASS |
| Invite/admin-policy/join seam rejections | `pnpm vitest run src/client/__tests__/join-account-identity-proof.test.ts src/client/group/proposals/__tests__/invite-user.test.ts src/engine/__tests__/group-engine.test.ts` | 19/19 pass | ✓ PASS |
| No production `0xf2f1` emission surface | `grep -rlni "f2f1" src examples/opentui/src \| grep -v "__tests__/"` | exactly 1 file, the private detection-only constant | ✓ PASS |
| No legacy symbol survives | `grep -rnE "\b(signAccountIdentityProof\|verifyLeafAccountIdentityProof\|verifyAllLeafAccountIdentityProofs\|buildAccountIdentityProofExtension\|makeAccountIdentityProofExtension\|AccountIdentityProofSigner\|AccountIdentityProofRequest\|accountProofSigner)\b" src examples/opentui/src` | no output | ✓ PASS |
| No debt markers in phase-touched production files | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` across 13 touched production files | no output | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| PROOF-02 | 07-01 | Kind-450 event byte-exact to spec vector | ✓ SATISFIED | See Truth #1 |
| PROOF-03 | 07-01, 07-02, 07-06 | Leaf advertises 0x8009, one entry, raw-key + external signers | ✓ SATISFIED | See Truth #2; independently re-verified per orchestrator note, not taken on SUMMARY claim alone |
| PROOF-04 | 07-01, 07-06 | Missing/mismatched/invalid proof rejected | ✓ SATISFIED | See Truth #3 |
| PROOF-05 | 07-01, 07-06 | KeyPackage-level `0x8009` rejected | ✓ SATISFIED | `invalid-location` test in `invite-user.test.ts` and `account-identity-proof.test.ts` |
| PROOF-06 | 07-01, 07-06 | GroupContext/SafeAAD/GroupInfo rejection | ✓ SATISFIED | See Truth #3; GroupInfo/AppEphemeral gap documented as no ts-mls production consumer exists (non-blocking, matches plan's explicit design) |
| CUT-01 | 07-02, 07-06, 07-07, 07-08 | No `0xf2f1` emission; legacy exports removed | ✓ SATISFIED | See Truths #4, #5 |
| CUT-02 | 07-01, 07-06, 07-07 | Legacy-carrying KeyPackage/leaf/group rejected | ✓ SATISFIED | See Truth #5 |

No orphaned requirements: all 7 phase requirement IDs (PROOF-02..06, CUT-01, CUT-02) are declared across the 8 plans' `requirements:` frontmatter and all are checked `[x]` and "Complete" in `.planning/REQUIREMENTS.md`'s traceability table. GRP-*, UPD-*, FOUND-*, QA-* requirements are correctly out of this phase's scope (mapped to Phases 8–11 in REQUIREMENTS.md traceability).

### Anti-Patterns Found

None in phase-touched production files (`src/core/key-package.ts`, `src/core/components/{dictionary,ids,account-identity-proof}.ts`, `src/core/capabilities.ts`, `src/engine/admin-policy.ts`, `src/client/{group/proposals/invite-user,groups-manager,key-package-store,key-package-manager,key-package-publisher,group-factory,marmot-client}.ts`).

**Non-blocking documentation drift (per orchestrator note, confirmed):** three comments in `src/core/components/account-identity-proof.ts` and three test-file comments (`capabilities.test.ts`, `key-package.test.ts`, `darkmatter-invite-compat.test.ts`) still cite the now-deleted `../account-identity-proof.js` path when referring to the legacy module. These are prose references inside comments only — no import statement resolves to the deleted path (confirmed: the one real `import ... from "../account-identity-proof.js"` at `src/core/components/__tests__/account-identity-proof.test.ts:70` is a same-directory-relative import of the *current* `src/core/components/account-identity-proof.ts` module, not the deleted one). Cosmetic only; does not affect build, tests, or the phase goal.

## Deferred Items

Item explicitly transferred to Phase 8, matching Phase 8's declared scope (GRP-02/GRP-04: "commit whose resulting epoch ... contains a member leaf without valid 0x8009 support and proof is rejected identically on the send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence seams" and "admin-policy admission of a standalone Add proposal validate the invitee's 0x8009 proof before it is proposed or queued"):

| # | Item | Addressed In | Evidence |
| --- | --- | --- | --- |
| 1 | Admin-policy Add gate skips validation entirely (does not reject) for an Add whose leaf carries **no** proof material at all (neither `0x8009` nor `0xf2f1`) — `hasAccountIdentityProofMaterial` returns `false` and the loop `continue`s | Phase 8 (GRP-02, GRP-04) | `src/engine/admin-policy.ts` `KNOWN GAP (D-06)` comment; pinned by a named test `src/engine/__tests__/group-engine.test.ts#"D-06 known gap (Phase 8 GRP-02/GRP-04): an Add with no proof material skips the proof gate"`, which asserts the callback falls through to the sender check (throws `"unverifiable commit sender"`) rather than rejecting. This does **not** violate ROADMAP success criterion 5 (which is scoped to a leaf/group *carrying or requiring* `0xf2f1`, not to a proof-less leaf), so it is not a phase-7 gap |
| 2 | Send, ingest, pool-replay, and convergence seams do not yet call the profile classifier or leaf validators (only invite, admin-policy Add, and join-via-Welcome do) | Phase 8 (GRP-02) | `07-06-SUMMARY.md` "Deferred / known gaps" item 3, matches Phase 8 ROADMAP goal text verbatim |
| 3 | Stored v1.0 groups requiring the legacy `0xf2f1` extension continue to load and operate locally untouched (`GroupRegistry.load`, hydration, `adoptClientState` deliberately unchanged, D-10) | Phase 8 | `07-06-SUMMARY.md` "Deferred / known gaps" item 2; `git diff --quiet HEAD -- src/client/group-registry.ts src/client/group/marmot-group.ts` confirms no change was made |

These deferred items do not affect the phase-7 status: the phase's own success criteria and requirements do not claim these seams, and REQUIREMENTS.md correctly maps GRP-01..04 to Phase 8 as Pending.

### Gaps Summary

No gaps found. All 5 ROADMAP success criteria, all 7 requirement IDs, and all must-haves declared across the phase's 8 plans are verified directly against the current codebase (not taken from SUMMARY claims): the spec signing vector reproduces byte-for-byte and was cross-checked against both the spec doc and the MDK Rust reference implementation (confirming it is the real adopted vector, not self-generated); KeyPackage/leaf generation via both raw-key and external signers emits exactly one 0x8009 entry; all 14 reject reasons are implemented and tested; the legacy `0xf2f1` module is deleted from disk with zero surviving production references (one private detection-only constant remains, correctly unexported); all three production legality seams this phase owns (invite, admin-policy Add, join-via-Welcome) reject legacy and malformed proofs. Build, full test suite (98/98 files, 1097/1097 tests), and extended conformance all pass. The single deferred item (D-06, proof-less Add skipped by admin-policy) is explicitly out of this phase's success-criteria scope and is correctly tracked as a Phase 8 item.

---

*Verified: 2026-09-14T20:25:50Z*
*Verifier: Claude (gsd-verifier)*
