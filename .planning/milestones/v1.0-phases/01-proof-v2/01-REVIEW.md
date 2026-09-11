---
phase: 01-proof-v2
reviewed: 2026-07-21T14:36:21Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/core/account-identity-proof.ts
  - src/client/key-package-manager.ts
  - src/core/__tests__/account-identity-proof.test.ts
  - src/core/__tests__/darkmatter-invite-compat.test.ts
  - src/__tests__/exports.test.ts
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
status: issues_found
---

# Phase 01-proof-v2: Code Review Report

**Reviewed:** 2026-07-21T14:36:21Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

This phase migrates the Marmot account-identity-proof from v1 to v2: the 64-byte
Schnorr signature now signs the NIP-01 event id of a canonical unsigned kind-450
Nostr event (built via `getEventHash`), the wire version byte bumps `1 → 2`, the
extension domain becomes `marmot.account-identity-proof.v2`, external Nostr-signer
parity builders were added (`buildAccountIdentityProofEvent`,
`accountIdentityProofEventJson`, `accountIdentityProofSignatureFromSignedEvent`),
and per-ciphersuite `signature_scheme` decimals are recorded.

**Correctness assessment — the core interop constraint holds.** I verified the
wire format, tag order/format, digest construction, and version-gate against the
Rust darkmatter reference and found no defect:

- The six-tag order (`d`, `extension`, `version`, `ciphersuite`,
  `signature_scheme`, `mls_signature_key`), the `0xf2f1` extension-tag format, the
  decimal `signature_scheme` string, and lowercase-hex fields are all confirmed
  byte-identical to Rust by a **pinned MDK fixture** (event id
  `29e15f6d…ec18` and a Rust-produced signature that verifies) plus an
  independent event-id reconstruction test.
- All seven ciphersuite → `signature_scheme` code points in
  `MLS_SIGNATURE_SCHEME_BY_CIPHERSUITE` match IANA TLS SignatureScheme
  (Ed25519 2055, secp256r1 1027, Ed448 2056, secp521r1 1539, secp384r1 1283).
- `decodeAccountIdentityProof` rejects version bytes ≠ 2 (v1 explicitly rejected),
  rejects trailing bytes (`reader.end()`), and round-trips the fixed 135-byte
  layout.
- `verifyLeafAccountIdentityProof` cross-checks account identity, leaf signature
  key, ciphersuite, and scheme before verifying the BIP-340 signature over the
  rebuilt digest — no trust in attacker-supplied `event.id`/`event.sig` (both are
  re-derived/verified).
- The signing path in `generateKeyPackage` binds the freshly generated leaf
  signature key into the proof before handing the same keypair to
  `MLSGenerateKeyPackageWithKey`, so leaf key and proof key always match.

All 24 tests across the three reviewed test files pass. The findings below are
migration-completeness and robustness issues; none block wire interop.

## Warnings

### WR-01: v1→v2 migration left stale `.v1` documentation on the code the reviewed KeyPackageManager delegates to

**File:** `src/client/key-package-manager.ts:128` (correctly updated to v2) — but its delegates are stale:

- `src/core/key-package.ts:78`
- `src/client/key-package-publisher.ts:32`
- `src/client/marmot-client.ts:93`
- `src/client/group/proposals/invite-user.ts:20`
- `src/client/groups-manager.ts:582`

**Issue:** `KeyPackageManagerOptions.accountProofSigner` was correctly re-documented
this phase to say key packages carry a `marmot.account-identity-proof.v2`
extension. However, the code it actually calls — `KeyPackagePublisher.generate` →
`generateKeyPackage` — still documents that it emits a
`marmot.account-identity-proof.v1` extension, and three other client modules still
cite the pre-v2 spec name `foundation/account-identity-proof-v1.md`. The runtime
constants are correct (`ACCOUNT_IDENTITY_PROOF_DOMAIN = "…v2"`,
`ACCOUNT_IDENTITY_PROOF_VERSION = 2`), so this is documentation-only, but the doc
now contradicts the shipped behavior and signals an incompletely propagated
migration. These files are outside the explicit 5-file review scope but sit
directly on this phase's migration surface.

**Fix:** Update the stale comments to `v2` / drop the `-v1` spec-doc suffix, e.g.
in `src/core/key-package.ts:78`:

```ts
   * carries a `marmot.account-identity-proof.v2` LeafNode extension binding the
```

and the analogous line in `src/client/key-package-publisher.ts:32`.

### WR-02: `hexToBytes32` silently coerces invalid hex to zero bytes and duplicates the already-imported validating `hexToBytes`

**File:** `src/core/account-identity-proof.ts:410-415` (used at `:346`)

**Issue:** The private helper

```ts
function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

uses `parseInt(..., 16)`, which returns `NaN` for non-hex or out-of-range slices;
assigning `NaN` into a `Uint8Array` coerces it to `0`. Malformed or short input
therefore yields a plausible-but-wrong 32-byte key **without throwing**, instead of
failing loudly. The call site is currently guarded (`getCredentialPubkey` validates
64-hex before this runs), so there is no live exploit — but the module already
imports `@noble/hashes`' length-validating `hexToBytes` (used at lines 3, 203, 235),
making this custom variant both redundant and strictly less safe.

**Fix:** Delete `hexToBytes32` and use the validating import:

```ts
const accountIdentityBytes = hexToBytes(accountIdentity);
```

## Info

### IN-01: New external-signer JSON helper `accountIdentityProofEventJson` is exported but has no test coverage

**File:** `src/core/account-identity-proof.ts:181-185` (exported; `src/__tests__/exports.test.ts:87`)

**Issue:** `accountIdentityProofEventJson` is part of the new v2 external-signer
interop surface and is a public export, but unlike its siblings
(`accountIdentityProofEventId`, `buildAccountIdentityProofEvent`,
`accountIdentityProofSignatureFromSignedEvent`) it is exercised by no test in the
reviewed suite. It is a thin `JSON.stringify(buildAccountIdentityProofEvent(...))`
wrapper (low risk), but the serialized-template path is an interop boundary a
downstream external signer will consume verbatim.

**Fix:** Add a small assertion that the JSON parses back to the canonical event
(matching `buildAccountIdentityProofEvent`) alongside the existing external-signer
tests in `src/core/__tests__/account-identity-proof.test.ts`.

---

_Reviewed: 2026-07-21T14:36:21Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
