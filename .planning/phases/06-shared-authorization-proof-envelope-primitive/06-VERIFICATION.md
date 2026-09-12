---
phase: 06-shared-authorization-proof-envelope-primitive
verified: 2026-09-12T22:09:40Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 6: Shared Authorization-Proof Envelope Primitive Verification Report

**Phase Goal:** A shared, reusable `src/core` primitive can encode, decode, and verify the 104-byte `MarmotAuthorizationProof` envelope defined in `foundation/authorization-proofs.md`, independent of any specific proof class — the cheapest possible correctness gate and a hard blocker for every other phase in this milestone.
**Verified:** 2026-09-12T22:09:40Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Encoding a valid envelope produces exactly 104 bytes; decode rejects truncated/trailing input | ✓ VERIFIED | `encodeAuthorizationProof` (src/core/authorization-proof.ts:128-144) writes via `BinaryWriter().bytes(32).uint64().bytes(64).build()` = 104 bytes; `decodeAuthorizationProof` (153-175) pre-checks `data.length !== 104` before constructing a reader, throwing `invalid-length`, and `reader.end()` catches trailing bytes. Tests: "encodes the vector fields to exactly the 104-byte hex", "rejects a 0-byte/103-byte/105-byte input with invalid-length" — all pass (69/69 tests, `pnpm vitest run src/core/__tests__/authorization-proof.test.ts`) |
| 2 | Decode rejects `created_at` 0 or > 2^53-1; produce refuses the same before signing | ✓ VERIFIED | `decodeAuthorizationProof` range-checks `createdAtBig` as a bigint against `[1n, MAX_CREATED_AT_BIGINT]` before `Number()` conversion (167-172). `assertCreatedAt` (110-121) is called by `buildAuthorizationProofEvent` before the signer is invoked in `produceAuthorizationProof` (370-374, signer called at line 381). Tests confirm wire values `0000000000000000`, `0020000000000000` (2^53), `ffffffffffffffff` rejected; `0000000000000001`→1 and `001fffffffffffff`→9007199254740991 accepted; produce rejects 0/-1/2^53/1.5/NaN with zero signEvent calls (`expect(signEvent).not.toHaveBeenCalled()`) |
| 3 | Decode rejects a non-point x-only `signer_pubkey` | ✓ VERIFIED | `assertSignerPubkey` (90-104) checks length then calls `schnorr.utils.lift_x(bytesToNumberBE(bytes))` in try/catch, rethrowing as `invalid-signer-pubkey`. Tests reject 32 zero bytes, 32×0xff, and x=5, independent of signature validity |
| 4 | Verification reconstructs the exact NIP-01 event id and accepts only a valid BIP-340 signature over it | ✓ VERIFIED | `verifyAuthorizationProof` (305-346) computes `id = authorizationProofEventId(template, ...)` (which calls `getEventHash` on the reconstructed `UnsignedEvent`) and calls `schnorr.verify(signature, hexToBytes(id), signerPubkey)`. Spec vector reproduces exactly: `authorizationProofEventId` → `b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b`; altered content/tags/kind/created_at/signature/wrong-pubkey all yield `invalid-signature` |
| 5 | External signer's returned event accepted only on exact pubkey/created_at/kind/tags/content equality, id recompute, and signature verify | ✓ VERIFIED | `produceAuthorizationProof` (365-446) validates in fixed order: pubkey, created_at, kind, tags (structural, not JSON-string), content, id, signature-hex-format, signature-verify — each with its own `returned-*` reason. Substitution regression tests (pubkey swap, uppercase pubkey, created_at+1, kind change, extra tag, reordered tags, altered content, id swap, wrong-message signature, uppercase sig, truncated sig, null return, in-place draft mutation, dual pubkey+content substitution) all pass with the expected distinct reason |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/core/authorization-proof.ts` | Proof-class-agnostic 104-byte codec, NIP-01 reconstruction, BIP-340 verify, strict produce, typed error | ✓ VERIFIED | File exists, 447 lines, exports exactly the 14 symbols listed in the plan; `class AuthorizationProofError extends Error` present once, `this.name = "AuthorizationProofError"` present once; no `ts-mls`, `Buffer`, or `MIP-` references; `src/core/account-identity-proof.ts` byte-unchanged (`git diff --quiet master..HEAD` exits 0) |
| `src/core/__tests__/authorization-proof.test.ts` | Byte-exact spec-vector test + one negative test per reject reason | ✓ VERIFIED | 69 tests, all pass; contains the spec vector id `b7e9a15dd85990fb0f49c33db3cc9875f73986207b038404ceb6b7fec4e0af6b`; all 14 reject-reason literals exercised in the source (grep check: zero missing) |
| `src/core/index.ts` | Core barrel re-export | ✓ VERIFIED | Line 2: `export * from "./authorization-proof.js";`, inserted directly after the account-identity-proof line as specified |
| `src/__tests__/exports.test.ts` | Root export-surface snapshot including new symbols | ✓ VERIFIED | `git diff --numstat master..HEAD` shows exactly 9 insertions, 0 deletions; all 9 runtime symbols (`AUTHORIZATION_PROOF_LENGTH`, `AUTHORIZATION_PROOF_MAX_CREATED_AT`, `AuthorizationProofError`, `authorizationProofEventId`, `buildAuthorizationProofEvent`, `decodeAuthorizationProof`, `encodeAuthorizationProof`, `produceAuthorizationProof`, `verifyAuthorizationProof`) present in the snapshot |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `src/core/authorization-proof.ts` | `src/core/binary.ts` | `BinaryReader.uint64()` bigint read / `BinaryWriter.uint64` BE write | ✓ WIRED | `reader.uint64()` returns `bigint` (binary.ts:299), `writer.uint64(BigInt(createdAt))` accepts `number \| bigint` (binary.ts:174) — confirmed by reading both files |
| `src/core/authorization-proof.ts` | `@noble/curves/secp256k1.js` | `schnorr.utils.lift_x` / `schnorr.verify` | ✓ WIRED | Both calls present and exercised by passing tests |
| `src/core/authorization-proof.ts` | `applesauce-core/helpers/event` | `getEventHash` computes NIP-01 id | ✓ WIRED | Imported and used in `authorizationProofEventId` and `produceAuthorizationProof`; spec vector id reproduces exactly |
| `src/core/index.ts` | `src/core/authorization-proof.ts` | barrel export star | ✓ WIRED | Confirmed on line 2 of `src/core/index.ts` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| AUTHZ-01 | 06-01 | Encode/decode exactly 104 bytes; truncated/trailing rejected | ✓ SATISFIED | Codec tests pass; REQUIREMENTS.md marked Complete |
| AUTHZ-02 | 06-01 | `created_at` 0 or >2^53-1 rejected on decode, refused on produce | ✓ SATISFIED | Range tests + zero-signer-call tests pass |
| AUTHZ-03 | 06-01 | Invalid x-only `signer_pubkey` rejected | ✓ SATISFIED | `lift_x`-based rejection tests pass |
| AUTHZ-04 | 06-01 | NIP-01 id reconstruction + BIP-340 verify | ✓ SATISFIED | Spec-vector id + signature reproduce exactly; negative tests pass |
| AUTHZ-05 | 06-01 | External-signer returned-event exact-equality validation | ✓ SATISFIED | Full substitution regression suite passes |

No orphaned requirements: REQUIREMENTS.md lists AUTHZ-01..05 mapped to Phase 6, all five appear in the plan's `requirements` frontmatter and are covered above.

### Anti-Patterns Found

None blocking. A single grep hit for the substring "placeholder" is in a test comment (`src/core/__tests__/authorization-proof.test.ts:621`) explaining a deliberate, documented test-fixture workaround (nostr-tools' `getEventHash`/`validateEvent` rejects non-lowercase-hex pubkeys before an id can be computed for that one substitution case) — not a stub or unimplemented code path. No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK` markers in either new file. No empty implementations, no hardcoded-empty return values feeding runtime behavior.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Focused test file passes | `pnpm vitest run src/core/__tests__/authorization-proof.test.ts` | 69/69 tests passed | ✓ PASS |
| Barrel + prettier formatting | `pnpm exec prettier --check` on the 4 touched files | All matched files use Prettier code style | ✓ PASS |
| Exports snapshot diff shape | `git diff --numstat master..HEAD -- src/__tests__/exports.test.ts` | `9  0` (pure insertions) | ✓ PASS |
| Legacy file / dependency isolation | `git diff --quiet master..HEAD -- src/core/account-identity-proof.ts package.json pnpm-lock.yaml` | exits 0 (no changes) | ✓ PASS |
| All 14 reject reasons present in source | grep loop over 14 literals against `authorization-proof.ts` | zero missing | ✓ PASS |
| Acceptance-criteria literal counts | `Math.floor(Date.now() / 1000)`=1, `getPublicKey`=0, `Pick<EventSigner, "signEvent">`=1, `toLowerCase`=0, `ts-mls`/`Buffer`/`MIP-`=0 | all match plan's exact expected counts | ✓ PASS |

Full-suite run (97 files / 1033 tests) and `pnpm build`/`pnpm lint` were already run by the orchestrator prior to this verification pass, per task instructions; not re-run here to avoid redundant full-suite execution.

### Probe Execution

Not applicable — this is a pure library primitive phase with no `scripts/*/tests/probe-*.sh` conventions and no probe references in the PLAN or SUMMARY.

### Human Verification Required

None. This phase is pure cryptographic/protocol logic with deterministic, fully testable behavior — no UI, no real-time behavior, no external service integration.

### Gaps Summary

No gaps found. All 5 ROADMAP success criteria are independently verified against the actual source (not just the SUMMARY's claims), all 5 requirement IDs are satisfied and traceable, the core barrel and root exports are correctly wired, the legacy `account-identity-proof.ts` file and `package.json`/`pnpm-lock.yaml` are provably untouched, and the spec signing vector (event id, signature, and 104-byte component hex) reproduces byte-for-byte through the generic primitive exactly as required by D-13. The phase goal is achieved: a shared, proof-class-agnostic primitive exists in `src/core` that encodes, decodes, and verifies the `MarmotAuthorizationProof` envelope with no MLS coupling and no kind registry, ready to be consumed by Phase 7's `0x8009` proof class and Phase 8's legality mapping.

---

_Verified: 2026-09-12T22:09:40Z_
_Verifier: Claude (gsd-verifier)_
