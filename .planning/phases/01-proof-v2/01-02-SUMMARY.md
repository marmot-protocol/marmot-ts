---
phase: 01-proof-v2
plan: 02
subsystem: auth
tags:
  [
    nostr,
    mls,
    account-identity-proof,
    bip-340,
    schnorr,
    external-signer,
    rust-interop,
    mdk,
  ]

# Dependency graph
requires:
  - phase: 01-proof-v2 plan 01
    provides: "account-identity-proof v2 wire format, kind-450 signing digest, external-signer parity builders, widened AccountIdentityProofSigner union type"
provides:
  - "widened AccountIdentityProofSigner union threaded through client/key-package-manager.ts and client/group-factory.ts with all call sites compiling"
  - "proof-touching test sweep verified: all 7 listed test files already used v2 vectors (no v1 strings/digests remained after 01-01's core migration)"
  - "Rust-signed proof-v2 round-trip fixture (generated from refs/mdk cgka-engine, pinned in darkmatter-invite-compat.test.ts) proving byte-for-byte kind-450 event id + signature interop"
  - "never-published assertion for ACCOUNT_IDENTITY_PROOF_EVENT_KIND (450) across src/client and src/engine"
affects:
  [
    "Phase 4 (CONF-01) — promote this pinned fixture into the permanent MDK conformance-vector harness",
    "client/key-package-manager",
    "client/group-factory",
  ]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cross-impl fixture generation: a throwaway #[test] added temporarily to the vendored Rust submodule (refs/mdk), run once with cargo test --nocapture to capture hex values, then reverted (git checkout --) so the submodule stays clean — no permanent Rust changes needed for a one-shot interop proof"

key-files:
  created: []
  modified:
    - src/client/key-package-manager.ts
    - src/core/__tests__/darkmatter-invite-compat.test.ts

key-decisions:
  - "Task 2 (test sweep) required zero code changes: grepping all 7 plan-listed test files for v1 domain strings, hardcoded v1 digests, or version-byte-1 assertions found none — they all call signAccountIdentityProof/verifyLeafAccountIdentityProof directly rather than hardcoding v1 byte vectors, so 01-01's core migration alone made them v2-correct. Verified by running the full 583-test baseline suite green before touching anything."
  - "Task 1 required only a doc-comment fix: both client files (key-package-manager.ts, group-factory.ts) already compiled against the widened AccountIdentityProofSigner union from 01-01 with zero code changes needed, because both only re-export/pass through the type opaquely rather than narrowing it. Only the accountProofSigner JSDoc in key-package-manager.ts still named the old .v1 domain and single-shape signer contract."
  - "Round-trip fixture lives in darkmatter-invite-compat.test.ts (the natural home per PROOF-V2.md, exercised via Claude's discretion per 01-CONTEXT.md) as a new top-level describe block, rather than a dedicated file, since the existing file already anchors darkmatter/MDK interop assertions."
  - "The Rust fixture generator (a #[test] fn in cgka-engine's account_identity_proof.rs) was added, run once via `cargo test -p cgka-engine --lib print_ts_proof_v2_fixture_vector -- --nocapture`, and reverted via `git checkout --` — refs/mdk is a git submodule and must stay clean; only the captured hex output was kept, pinned in the TS test."
  - "verifyLeafAccountIdentityProof's leaf-shaped test fixture uses a single `as unknown as LeafNode` cast (only credential/signaturePublicKey/extensions are read by the function under test) rather than constructing a fully-typed LeafNode literal, since satisfying the full discriminated LeafNode type (hpkePublicKey, capabilities, leafNodeSource-specific fields, signature) for a values-only proof check would add unrelated noise."

requirements-completed: [PROOF-01]

coverage:
  - id: D1
    description: "Widened AccountIdentityProofSigner threads through client/key-package-manager.ts and client/group-factory.ts with every call site compiling; .v1 doc reference corrected to .v2"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "pnpm compile (tsc -b tsconfig.build.json) — exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "All 7 plan-listed proof-touching test files verified already v2-correct (no v1 domain strings, hardcoded v1 digests, or version-byte-1 assertions) — full 587-test suite green"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "pnpm vitest run — 65 files / 587 tests pass"
        status: pass
    human_judgment: false
  - id: D3
    description: "Rust-signed proof-v2 round-trip fixture: marmot-ts reproduces the identical kind-450 event id Rust computed from the same fixed inputs"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/darkmatter-invite-compat.test.ts#Rust MDK proof-v2 round-trip fixture (generated once, pinned) > reproduces the identical kind-450 event id Rust computed from the same inputs"
        status: pass
    human_judgment: false
  - id: D4
    description: "marmot-ts accepts (verifies) the pinned Rust-produced 64-byte Schnorr signature, both directly and via the full leaf-proof decode/verify path"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/darkmatter-invite-compat.test.ts#Rust MDK proof-v2 round-trip fixture (generated once, pinned) > accepts (verifies) the pinned Rust-produced 64-byte Schnorr signature"
        status: pass
    human_judgment: false
  - id: D5
    description: "Encoded proof payload round-trips the pinned account-identity/mls-key/version/ciphersuite/signature_scheme fields through encode/decode unchanged"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "src/core/__tests__/darkmatter-invite-compat.test.ts#Rust MDK proof-v2 round-trip fixture (generated once, pinned) > round-trips the pinned account-identity/mls-key/version fields through encode/decode"
        status: pass
    human_judgment: false
  - id: D6
    description: "ACCOUNT_IDENTITY_PROOF_EVENT_KIND (450) is never wired into a publish/relay/network path in src/client or src/engine"
    requirement: "PROOF-01"
    verification:
      - kind: unit
        ref: "grep -rn ACCOUNT_IDENTITY_PROOF_EVENT_KIND|450 src/client src/engine --include='*.ts' | grep -iv test | grep -ci 'publish|relay|network|emit(' — returns 0"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-21
status: complete
---

# Phase 01 Plan 02: Client Signer Threading + Rust Round-Trip Interop Summary

**Verified the widened v2 account-identity-proof signer contract already compiles through client/key-package-manager.ts and client/group-factory.ts unchanged, confirmed all 7 proof-touching test files were already v2-correct, and pinned a fresh Rust-signed (MDK cgka-engine) → TS-verified kind-450 round-trip fixture proving real byte-for-byte cross-implementation interop.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-21T14:14:00Z
- **Completed:** 2026-07-21T14:28:21Z
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments

- Confirmed (via `pnpm compile` and a baseline full-suite run) that plan 01-01's widened `AccountIdentityProofSigner` union type already flows through `src/client/key-package-manager.ts` and `src/client/group-factory.ts` with zero code changes required — both consume the type opaquely (pass-through option field), so no narrowing or `any`-casts were ever needed.
- Updated the last remaining `.v1` doc reference: `key-package-manager.ts`'s `accountProofSigner` JSDoc named the old `marmot.account-identity-proof.v1` domain and a single-shape (raw-key-only) signer; corrected to `.v2` and documented both accepted signer shapes (raw-key digest signer or external `{ signEvent }` Nostr signer).
- Swept all 7 plan-listed proof-touching test files (`darkmatter-invite-compat`, `welcome`, `capabilities`, `key-package`, `invite-user`, `group-engine`, `marmot-group`) for v1 domain strings, hardcoded v1 signing digests, and version-byte-1 assertions — found none. They call `signAccountIdentityProof`/`verifyLeafAccountIdentityProof` directly rather than pinning v1 byte vectors, so plan 01-01's core migration alone made every one of them v2-correct. Verified via a green 583-test baseline run before making any changes.
- Generated a fresh Rust-signed account-identity-proof v2 fixture from the vendored MDK reference (`refs/mdk`, `marmotkit-v0.9.4-14-g3628ccc`): added a throwaway `#[test] fn print_ts_proof_v2_fixture_vector` to `crates/cgka-engine/src/account_identity_proof.rs`'s existing `#[cfg(test)] mod tests`, ran it once with `cargo test -p cgka-engine --lib print_ts_proof_v2_fixture_vector -- --nocapture`, captured the printed hex values, then reverted the change (`git checkout --`) so the `refs/mdk` submodule stays clean.
- Pinned the captured fixture in a new `describe("Rust MDK proof-v2 round-trip fixture (generated once, pinned)")` block in `src/core/__tests__/darkmatter-invite-compat.test.ts` with 4 new tests: (1) marmot-ts's `accountIdentityProofEventId`/`accountIdentityProofSigningDigest` reproduce the identical kind-450 event id Rust computed for the same fixed inputs; (2) the pinned Rust 64-byte Schnorr signature verifies both directly (`schnorr.verify`) and through the full `verifyLeafAccountIdentityProof` leaf-proof path; (3) the encoded proof payload's version/ciphersuite/signature_scheme/account-identity/mls-key fields round-trip through `encodeAccountIdentityProof`/`decodeAccountIdentityProof` unchanged; (4) `ACCOUNT_IDENTITY_PROOF_EVENT_KIND` is confirmed 450 and grep-verified never wired into a publish/relay/network path.
- Full Vitest suite: 65 files / 587 tests pass (up from 583 baseline — the 4 new round-trip tests).

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread widened signer contract through client + fix .v1 comment** - `c4284ac` (docs)
2. **Task 2: Sweep proof-touching tests/fixtures from v1 to v2** - no commit (verification-only; no code changes required — see Deviations)
3. **Task 3: Rust-signed round-trip fixture + never-published assertion** - `cecc387` (test)

_Note: Task 2's own acceptance criteria were already satisfied by plan 01-01's core migration; grepping the 7 listed files plus a full green baseline suite run confirmed this before Task 1/3 work began, so no commit was needed for Task 2 itself._

## Files Created/Modified

- `src/client/key-package-manager.ts` - `accountProofSigner` JSDoc updated from the `.v1` domain string / single-shape signer description to `.v2` and the widened raw-key-or-external-signer contract
- `src/core/__tests__/darkmatter-invite-compat.test.ts` - new imports (`AccountIdentityProofRequest`, `ACCOUNT_IDENTITY_PROOF_EVENT_KIND`, `accountIdentityProofEventId`, `accountIdentityProofSigningDigest`, `decodeAccountIdentityProof`, `encodeAccountIdentityProof`, `hexToBytes`, `LeafNode`) plus a new `describe` block pinning the Rust-signed round-trip fixture (4 tests)

## Decisions Made

- Task 2 required zero code changes: all 7 plan-listed test files already build proofs through the (now-v2) `signAccountIdentityProof`/`verifyLeafAccountIdentityProof` helpers rather than hardcoding v1 byte vectors, so 01-01's core migration alone made them v2-correct — confirmed via a green baseline full-suite run before any Task 1/3 edits.
- Task 1 required only a JSDoc fix, not code changes: both client files re-export/pass through `AccountIdentityProofSigner` opaquely, so the widened union type from 01-01 compiled through them with zero changes; the test helper's `accountProofSignerFor` signature was already preserved (raw-key path).
- Round-trip fixture placed in `darkmatter-invite-compat.test.ts` (Claude's discretion per 01-CONTEXT.md; the natural home per PROOF-V2.md) as a new top-level `describe` block rather than a dedicated file.
- The Rust fixture-generating test was added to `refs/mdk`'s `cgka-engine` crate only temporarily and reverted via `git checkout --` immediately after capturing output, since `refs/mdk` is a git submodule and must not carry uncommitted changes.
- `verifyLeafAccountIdentityProof`'s test-fixture leaf object uses a single `as unknown as LeafNode` cast (only the 3 fields the function reads are populated) rather than a fully-typed `LeafNode` literal, since the full discriminated-union type carries unrelated fields (hpkePublicKey, capabilities, leafNodeSource-specific variants, signature) that add no value to this proof-only check.

## Rust Fixture Generation Record (for CONF-01 / Phase 4 promotion)

**Generation command:**

```sh
cd refs/mdk && cargo test -p cgka-engine --lib print_ts_proof_v2_fixture_vector -- --nocapture
```

**Fixed inputs** (deterministic, derived via SHA-256 of descriptive strings so anyone can regenerate identical bytes):

- Account secret key: `sha256("marmot-ts proof-v2 fixture account secret key")`
- MLS signature key: `sha256("marmot-ts proof-v2 fixture mls signature key")` → `9f228d14a7609599c4971bd0f65f43ae7d00b0a50ccfc021e95ca7fd825197ac`
- Ciphersuite: `1` (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`)
- Signature scheme: `2055` (`0x0807`, Ed25519)

**Rust-produced outputs** (pinned in `darkmatter-invite-compat.test.ts`):

- Account identity (x-only pubkey hex): `67d3ed702d55d4c049de6e43ead43a9b9cf1b4976f40a7357673b1acbf8f34b0`
- Kind-450 event id hex: `29e15f6d6dacb28ba1a806829ec7016709cad47cd998eb620558d7df0a39ec18`
- 64-byte Schnorr signature hex: `c0a3944043456dad09411928f77c317a4134d8ebbe8353b3cf07695d31159842b4a7a172790fe55f4b9653e999a29e3b0827a862bbd1a143f57d7a5f0f92e13f`

The Rust `#[test]` function used to generate these values (`print_ts_proof_v2_fixture_vector`) was **not** kept in `refs/mdk` — it was reverted via `git checkout --` after capturing output, per plan instruction ("small throwaway Rust test/example") and because `refs/mdk` is a git submodule that should not carry uncommitted local changes. To regenerate or extend this fixture for Phase 4's permanent conformance-vector harness, re-add an equivalent test to `crates/cgka-engine/src/account_identity_proof.rs`'s `#[cfg(test)] mod tests`, following the pattern of the existing `request()` helper and `proof_event_is_canonical_unpublished_kind_450` test in that file.

## Deviations from Plan

### Auto-fixed Issues

None — no Rule 1/2/3 auto-fixes were needed. Both "no changes required" outcomes below are verification findings, not deviations from correct behavior:

**1. Task 1: no code changes needed beyond the JSDoc fix**

- **Found during:** Task 1
- **Finding:** `pnpm compile` was already green before any Task 1 edit, and `src/client/key-package-manager.ts` / `src/client/group-factory.ts` already typechecked against the widened `AccountIdentityProofSigner` union from plan 01-01 with no narrowing or casts. Only the outdated `.v1` JSDoc needed fixing.
- **Files modified:** `src/client/key-package-manager.ts`
- **Verification:** `grep -c "account-identity-proof.v1" src/client/key-package-manager.ts` returns `0`; `pnpm compile` exits 0.
- **Committed in:** `c4284ac`

**2. Task 2: no code changes needed at all**

- **Found during:** Task 2
- **Finding:** A baseline `pnpm vitest run` (before any plan-02 edits) already passed 583/583 tests, and grepping all 7 plan-listed files for `account-identity-proof.v1`, hardcoded v1 digests, or version-byte-1 assertions found zero matches. Plan 01-01's core migration alone satisfied Task 2's acceptance criteria.
- **Files modified:** none
- **Verification:** `pnpm vitest run` (587/587 pass after Task 3's additions); `grep -rc "account-identity-proof.v1" src --include='*.test.ts' | grep -v ':0$' | wc -l` returns `0`.
- **Committed in:** n/a (no commit — verification only)

---

**Total deviations:** 0 (2 verification findings documented above, no fixes required)
**Impact on plan:** Both Task 1 and Task 2's heavy lifting had already been completed by plan 01-01's core migration; this plan's real work was confirming that end-to-end and closing PROOF-01 with the Rust round-trip proof (Task 3).

## Issues Encountered

None. The one operational care point was ensuring the throwaway Rust fixture-generator test left `refs/mdk` (a git submodule) clean afterward — confirmed via `git -C refs/mdk status --short` / `git -C refs/mdk diff --stat` returning empty after `git checkout --`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- PROOF-01 is now fully closed: v2 wire format + digest (01-01), client signer threading (this plan, Task 1), full proof-touching test suite on v2 vectors (this plan, Task 2, verification-only), and a real Rust-signed round-trip interop proof (this plan, Task 3).
- The pinned round-trip fixture (fixed inputs + Rust-produced event id / signature, documented above) is ready for CONF-01 / Phase 4 to promote into the permanent MDK conformance-vector harness alongside other cross-impl vectors.
- `pnpm compile` and `pnpm vitest run` (65 files / 587 tests) are green on Node. No blockers for Phase 2.

---

_Phase: 01-proof-v2_
_Completed: 2026-07-21_

## Self-Check: PASSED

- FOUND: `src/client/key-package-manager.ts`
- FOUND: `src/core/__tests__/darkmatter-invite-compat.test.ts`
- FOUND: `.planning/phases/01-proof-v2/01-02-SUMMARY.md`
- FOUND commit: `c4284ac`
- FOUND commit: `cecc387`
