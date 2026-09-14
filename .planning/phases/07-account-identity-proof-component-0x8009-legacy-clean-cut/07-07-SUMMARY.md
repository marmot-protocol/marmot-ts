---
phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut
plan: 07
subsystem: auth
tags: [mls, key-package, account-identity-proof, app-components, ts-mls, group]

# Dependency graph
requires:
  - phase: 07-06
    provides: "Atomic wire cut to 0x8009: generateKeyPackage requires a signer and always emits the 0x8009 leaf proof; invite, admin-policy, and join-via-Welcome all validate through the 0x8009 class validators; admin-policy's Add gate treats legacy-only material as reject, not skip (CUT-02)"
provides:
  - "The legacy marmot.account-identity-proof.v2 0xf2f1 custom LeafNode extension module (src/core/account-identity-proof.ts) is deleted outright, along with its unit test, the proof-v2 conformance parity test, the Rust-signed legacy fixture, and the tools/quality-gate/proof-v2-probe/ Rust generator"
  - "The package root no longer exports any of the 15 legacy runtime proof symbols (exports.test.ts snapshot: 0 insertions, 15 deletions)"
  - "Admin-policy's Add gate is proven by test to reject a tampered 0x8009 proof and a legacy-only 0xf2f1 leaf; a proof-less Add is proven by test to skip the gate entirely (D-06 known gap, pinned for Phase 8)"
affects: [08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Test fixtures that need a malformed/legacy leaf build it with makeCustomExtension({ extensionType: 0xf2f1, ... }) directly, never by importing the deleted legacy module"

key-files:
  created: []
  modified:
    - src/engine/__tests__/group-engine.test.ts
    - src/client/group/__tests__/marmot-group.test.ts
    - src/core/components/__tests__/safe-aad-parity.test.ts
    - src/core/index.ts
    - src/__tests__/exports.test.ts
    - AGENTS.md
  deleted:
    - src/core/account-identity-proof.ts
    - src/core/__tests__/account-identity-proof.test.ts
    - src/__tests__/conformance/proof-v2-parity.test.ts
    - src/__tests__/fixtures/proof-v2-rust.json
    - tools/quality-gate/proof-v2-probe/Cargo.toml
    - tools/quality-gate/proof-v2-probe/Cargo.lock
    - tools/quality-gate/proof-v2-probe/src/main.rs

key-decisions:
  - "proof-v2-probe (the Rust 0xf2f1 fixture generator) is retired in this phase rather than Phase 11, per the plan's explicit instruction and RESEARCH Pitfall 2 -- leaving the legacy-shape generator around risked a future copy-paste of the deprecated wire shape when Phase 11 needs a new Rust-signed 0x8009 fixture"
  - "CUT-01 is marked Complete: both of its clauses are now true -- marmot-ts never emits 0xf2f1 (closed by 07-06) and the legacy proof exports are removed (closed by this plan's Task 2)"
  - "The Task 2 acceptance-criteria grep for surviving legacy-module import paths (`grep -rn 'account-identity-proof.js\"' ... | grep -v 'components/account-identity-proof.js\"'`) still prints two lines after the delete: src/core/components/index.ts's own `./account-identity-proof.js` barrel re-export and src/core/components/__tests__/account-identity-proof.test.ts's own `../account-identity-proof.js` relative import. Both are same-directory-relative references to the CURRENT 0x8009 module (src/core/components/account-identity-proof.ts), not the deleted legacy module -- the literal grep's `components/` substring filter has a blind spot for same-directory relative imports, which never embed a `components/` path segment. Verified substantively: every remaining `account-identity-proof.js\"` import in the codebase resolves to the current module (confirmed by listing all 8 occurrences); zero reference the deleted src/core/account-identity-proof.ts. Documented per the 07-06 precedent for a spec-grep-vs-actual-code tension, not a functional gap."

patterns-established: []

requirements-completed: [CUT-01]

coverage:
  - id: D1
    description: "src/core/account-identity-proof.ts (the legacy 0xf2f1 module) is deleted outright -- not renamed or ported -- and its src/core/index.ts barrel export-star line is removed; pnpm compile and the root tsc --noEmit typecheck both pass with no surviving importer"
    requirement: "CUT-01"
    verification:
      - kind: other
        ref: "test ! -e src/core/account-identity-proof.ts && test ! -e src/core/__tests__/account-identity-proof.test.ts"
        status: pass
      - kind: other
        ref: "pnpm compile && pnpm exec tsc -p tsconfig.json --noEmit"
        status: pass
    human_judgment: false
  - id: D2
    description: "The package root exports.test.ts snapshot loses exactly the 15 legacy runtime exports (ACCOUNT_IDENTITY_PROOF_EVENT_KIND, ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE, accountIdentityProofEventId, accountIdentityProofEventJson, accountIdentityProofSignatureFromSignedEvent, accountIdentityProofSigningDigest, buildAccountIdentityProofEvent, buildAccountIdentityProofExtension, decodeAccountIdentityProof, encodeAccountIdentityProof, makeAccountIdentityProofExtension, mlsSignatureScheme, signAccountIdentityProof, verifyAllLeafAccountIdentityProofs, verifyLeafAccountIdentityProof) and gains none"
    requirement: "CUT-01"
    verification:
      - kind: unit
        ref: "src/__tests__/exports.test.ts (regenerated snapshot)"
        status: pass
      - kind: other
        ref: "git diff --numstat HEAD -- src/__tests__/exports.test.ts -> 0 insertions, 15 deletions"
        status: pass
    human_judgment: false
  - id: D3
    description: "tools/quality-gate/proof-v2-probe/ (the Rust legacy-fixture generator), src/__tests__/fixtures/proof-v2-rust.json, and src/__tests__/conformance/proof-v2-parity.test.ts are deleted, so no generator or consumer of the legacy 0xf2f1 shape remains"
    requirement: "CUT-01"
    verification:
      - kind: other
        ref: "test ! -d tools/quality-gate/proof-v2-probe && test ! -e src/__tests__/fixtures/proof-v2-rust.json && test ! -e src/__tests__/conformance/proof-v2-parity.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Admin-policy commit callback tests: rejects an Add whose 0x8009 proof signature is tampered, rejects an Add whose leaf carries only legacy 0xf2f1 material, and an Add whose leaf carries no proof material skips the gate entirely (throws 'unverifiable commit sender' rather than returning reject) -- pinning the D-06 known gap by name for Phase 8"
    requirement: "CUT-02"
    verification:
      - kind: unit
        ref: "src/engine/__tests__/group-engine.test.ts#admin commit policy account identity proof gate > rejects an Add whose 0x8009 proof signature is tampered"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/group-engine.test.ts#admin commit policy account identity proof gate > rejects an Add whose leaf carries only legacy 0xf2f1 material"
        status: pass
      - kind: unit
        ref: "src/engine/__tests__/group-engine.test.ts#admin commit policy account identity proof gate > D-06 known gap (Phase 8 GRP-02/GRP-04): an Add with no proof material skips the proof gate"
        status: pass
      - kind: unit
        ref: "src/client/group/__tests__/marmot-group.test.ts#rejects a commit that adds a leaf with a forged account identity proof"
        status: pass
    human_judgment: false
  - id: D5
    description: "safe-aad-parity confirms both the pinned MDK current-profile fixture and a marmot-ts-generated KeyPackage advertise 0x8009 in their app_components list"
    requirement: "CUT-01"
    verification:
      - kind: unit
        ref: "src/core/components/__tests__/safe-aad-parity.test.ts#matches the dictionary extracted from a genuine MDK KeyPackage"
        status: pass
    human_judgment: false
  - id: D6
    description: "Grep audit: production code under src/ and examples/opentui/src mentions f2f1 only in the private legacy constant inside src/core/components/account-identity-proof.ts (the current 0x8009 module, which detects/rejects the legacy shape); every test file still mentioning f2f1 does so only to build a rejection fixture or assert absence; no legacy proof symbol or legacy module import survives anywhere"
    requirement: "CUT-01"
    verification:
      - kind: other
        ref: "grep -rlni f2f1 src examples/opentui/src | grep -v __tests__/ -> src/core/components/account-identity-proof.ts (exactly one match)"
        status: pass
      - kind: other
        ref: "grep -rnE legacy-proof-symbol-list src examples/opentui/src -> no matches"
        status: pass
    human_judgment: false

# Metrics
duration: 15min
completed: 2026-09-14
status: complete
---

# Phase 7 Plan 7: Legacy 0xf2f1 Clean Cut Summary

**The legacy `marmot.account-identity-proof.v2` (`0xf2f1`) module, its tests, Rust fixture, and probe generator are deleted outright; the package root no longer exports any of the 15 legacy proof symbols; and the admin-policy gate is proven by test to reject both a tampered `0x8009` proof and a legacy-only `0xf2f1` leaf, while the D-06 skip gap for a proof-less Add is pinned by name for Phase 8.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-09-14
- **Tasks:** 2
- **Files modified:** 6 modified, 7 deleted

## Accomplishments

- **Task 1** rewrote the two admin-policy tests that hand-built legacy `0xf2f1` proofs via the doomed-for-deletion legacy module. `src/engine/__tests__/group-engine.test.ts` gained a three-case `describe("admin commit policy account identity proof gate")` block: (a) a tampered-signature `0x8009` proof is rejected, (b) a leaf carrying only the legacy `0xf2f1` extension is rejected, (c) a leaf with no proof material at all is not rejected by the proof loop -- the callback falls through to the sender lookup and throws `"unverifiable commit sender"` (proving the skip, not a rejection), a test named with `D-06 known gap` so it is unmistakably the transferred item for Phase 8 (GRP-02/GRP-04). `src/client/group/__tests__/marmot-group.test.ts` keeps a single tampered-signature test under the real ciphersuite impl. `src/core/components/__tests__/safe-aad-parity.test.ts` added `0x8009` to the `commonComponent` parity loop, so both the pinned MDK fixture and a live marmot-ts `KeyPackage` must advertise it.
- **Task 2** deleted `src/core/account-identity-proof.ts` (the legacy module), `src/core/__tests__/account-identity-proof.test.ts`, `src/__tests__/conformance/proof-v2-parity.test.ts`, `src/__tests__/fixtures/proof-v2-rust.json`, and the entire `tools/quality-gate/proof-v2-probe/` Rust crate (`Cargo.toml`, `Cargo.lock`, `src/main.rs`) via `git rm`. Removed the legacy `export * from "./account-identity-proof.js"` barrel line from `src/core/index.ts`. `pnpm compile` and the root `tsc -p tsconfig.json --noEmit` both pass with zero surviving importers of the deleted module (Task 1 had already cleared the only two test importers). Regenerated `src/__tests__/exports.test.ts`'s inline snapshot with `pnpm vitest run src/__tests__/exports.test.ts -u`: the diff is exactly 0 insertions and 15 deletions, matching the 15 legacy symbols named in the plan verbatim. Updated `AGENTS.md`'s helper-naming example from the now-deleted `account-proof.ts` to `test-accounts.ts`.
- Marked `CUT-01` Complete in `REQUIREMENTS.md` -- both of its clauses are now true (never emits `0xf2f1`, closed by 07-06; legacy proof exports removed, closed here).

## Task Commits

1. **Task 1: Rewrite the legacy-built admin-policy tests to 0x8009 and pin the D-06 gap; add 0x8009 to SafeAAD parity (CUT-02, D-06)** - `852a0e2` (test)
2. **Task 2: Delete the legacy module, tests, fixture, and probe; regenerate exports; grep audit (D-12, CUT-01)** - `ef756c8` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `src/engine/__tests__/group-engine.test.ts` - Three-case `describe` block replacing the single forged-proof test; pins the D-06 known gap by name
- `src/client/group/__tests__/marmot-group.test.ts` - Tampered-`0x8009`-signature test under the real ciphersuite impl, no legacy import
- `src/core/components/__tests__/safe-aad-parity.test.ts` - `0x8009` added to the `commonComponent` parity assertion
- `src/core/index.ts` - Legacy `./account-identity-proof.js` barrel export-star line removed
- `src/__tests__/exports.test.ts` - Regenerated snapshot, 15 legacy symbols removed, none added
- `AGENTS.md` - Naming example now cites `test-accounts.ts` instead of the deleted `account-proof.ts`
- `src/core/account-identity-proof.ts` - **Deleted** (the legacy `0xf2f1` module)
- `src/core/__tests__/account-identity-proof.test.ts` - **Deleted**
- `src/__tests__/conformance/proof-v2-parity.test.ts` - **Deleted**
- `src/__tests__/fixtures/proof-v2-rust.json` - **Deleted**
- `tools/quality-gate/proof-v2-probe/Cargo.toml`, `Cargo.lock`, `src/main.rs` - **Deleted** (the whole crate)

## Decisions Made

- Retired `proof-v2-probe` (the Rust legacy-fixture generator) in this plan rather than deferring to Phase 11, per the plan's explicit instruction and RESEARCH Pitfall 2: leaving the generator around risked a future copy-paste of the deprecated `0xf2f1` shape when Phase 11 builds a new Rust-signed `0x8009` conformance fixture.
- Marked `CUT-01` Complete: both of its clauses (no `0xf2f1` emission, no legacy exports) are now true.
- Documented a grep-precision tension in the Task 2 acceptance criterion for surviving legacy-module import paths (see "CUT-01/CUT-02 grep audit" below) -- the literal grep as written flags two same-directory-relative imports of the *current* `0x8009` module as false positives, following the same-shape precedent 07-06 set for a spec-grep-vs-code tension.

## CUT-01/CUT-02 grep audit

Per Task 2's action, the full four-part audit and its results:

**(1) Production files under `src/` and `examples/opentui/src` mentioning `f2f1` case-insensitively:**

```
$ grep -rlni "f2f1" src examples/opentui/src | grep -v "__tests__/"
src/core/components/account-identity-proof.ts
```

Exactly one file: the private `LEGACY_ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE = 0xf2f1` constant inside the *current* `0x8009` module, used only to detect and reject the legacy shape (never exported, per that module's own doc comment). No other production file mentions `f2f1`.

**(2) Any import path ending in the legacy module path outside `components/`:**

```
$ grep -rn 'account-identity-proof.js"' src examples/opentui/src | grep -v 'components/account-identity-proof.js"'
src/core/components/index.ts:3:export * from "./account-identity-proof.js";
src/core/components/__tests__/account-identity-proof.test.ts:70:} from "../account-identity-proof.js";
```

Both of these are same-directory-relative references to the CURRENT `0x8009` module (`src/core/components/account-identity-proof.ts`) -- the barrel's own re-export and the co-located unit test's own import. Neither embeds a `components/` path segment because both files already live inside that directory, which is exactly why the substring filter misses them; it is not evidence of a legacy-module import. Verified substantively by listing every occurrence of `account-identity-proof.js"` in the tree (8 total, all resolving to `src/core/components/account-identity-proof.ts`) -- zero resolve to the deleted `src/core/account-identity-proof.ts`.

**(3) Any legacy proof symbol name from the removed-exports list, or the removed client option name, anywhere in `src` or `examples/opentui/src`:**

```
$ grep -rnE "\b(signAccountIdentityProof|verifyLeafAccountIdentityProof|verifyAllLeafAccountIdentityProofs|buildAccountIdentityProofExtension|makeAccountIdentityProofExtension|AccountIdentityProofSigner|AccountIdentityProofRequest|accountProofSigner)\b" src examples/opentui/src
(no output)
```

Zero matches -- no legacy symbol name survives anywhere.

**(4) Every test file still mentioning `f2f1`, with a one-line note confirming rejection/absence assertions:**

| Test file | Occurrences confirm |
|---|---|
| `src/core/__tests__/key-package.test.ts` | Local `0xf2f1` literal built only to reference the legacy hex id in a comment/constant, not imported from the deleted module |
| `src/engine/__tests__/group-engine.test.ts` | Builds a legacy-only leaf via `makeCustomExtension({ extensionType: 0xf2f1, ... })` and asserts the admin-policy callback returns `"reject"` |
| `src/core/components/__tests__/account-identity-proof.test.ts` | Builds legacy `0xf2f1` fixtures and asserts `legacy-extension-present` rejection at every seam (leaf, KeyPackage-level, mixed) |
| `src/client/__tests__/join-account-identity-proof.test.ts` | Builds a mixed-profile group requiring both `0xf2f1` and `0x8009` and asserts it is rejected without persisting anything |
| `src/client/group/proposals/__tests__/invite-user.test.ts` | Builds a legacy-only invitee leaf and asserts `legacy-extension-present` rejection |
| `src/core/__tests__/capabilities.test.ts` | Asserts the legacy `0xf2f1` extension is never advertised in `Capabilities.extensions` or required capabilities |
| `src/core/__tests__/darkmatter-invite-compat.test.ts` | Asserts the leaf never carries the legacy `0xf2f1` extension |

Every occurrence in every test file asserts rejection or absence of the legacy shape -- none builds it as a happy-path input.

## Deviations from Plan

None -- plan executed exactly as written. The Task 2 grep-precision note above (item 2 in the audit) is a documented resolution of a filter-pattern blind spot in the literal acceptance-criteria command, not a functional deviation: the substantive claim the grep was written to check (no surviving import of the deleted legacy module) holds, verified by direct enumeration of every `account-identity-proof.js"` import in the tree.

## Issues Encountered

None.

## Known Stubs

None -- every deletion is a complete removal with no placeholder left behind.

## Threat Flags

None. This plan's own `<threat_model>` (T-07-22..T-07-25) covers every trust boundary touched; no new surface was introduced (Task 2 is pure deletion plus a barrel-line removal, Task 1 is test-only).

## Deferred / Known Gaps

1. **D-06 (admin-policy skip), transferred to Phase 8 GRP-02/GRP-04:** `createAdminCommitPolicyCallback`'s Add loop still skips validation entirely for an Add whose leaf carries no account-identity-proof material at all (`hasAccountIdentityProofMaterial` returns `false`). This plan's Task 1 pins the gap with a test named `D-06 known gap (Phase 8 GRP-02/GRP-04): an Add with no proof material skips the proof gate`, proving the callback throws `"unverifiable commit sender"` (a skip through to the sender lookup) rather than returning `"reject"`. Phase 8 must close this so a proof-less Add is rejected outright.
2. Every other known gap from 07-06's SUMMARY (D-10 stored legacy groups; send/ingest/pool-replay/convergence seams not yet calling the validators) is unchanged by this plan -- it touched only test fixtures and dead-code removal, not any legality seam.

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `CUT-01` and `CUT-02` are both Complete in `REQUIREMENTS.md`. The legacy `0xf2f1` proof profile has no production module, no exported symbol, and no fixture generator left anywhere in the tree.
- Full suite (98 files / 1092 tests), extended conformance, build, example typecheck, and Bun/Deno exports smoke all green -- no regression risk carried forward.
- Plan 07-08 (key-package-store `nonCurrent` flag, changeset, docs) has a clean target: no file this plan touched overlaps its declared scope.
- D-06 remains the one open item this phase deliberately defers to Phase 8, now pinned by an explicit named test rather than only a code comment.

---
*Phase: 07-account-identity-proof-component-0x8009-legacy-clean-cut*
*Completed: 2026-09-14*

## Self-Check: PASSED

SUMMARY.md verified present on disk; both task commit hashes (`852a0e2`, `ef756c8`) verified in `git log`.
