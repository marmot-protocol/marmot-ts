# Phase 1: Proof v2 - Context

**Gathered:** 2026-07-21
**Status:** Ready for planning
**Source:** plan-phase gate decisions (existing research reused; no discuss-phase run)

<domain>
## Phase Boundary

Migrate `marmot.account-identity-proof` from **v1 to v2** in
`src/core/account-identity-proof.ts` so marmot-ts interoperates byte-for-byte
with the MDK Rust reference (`marmotkit-v0.9.4`, mdk #755 / commit cf780a1).

**In scope:** version byte `1 → 2`; replacing the signing input (old SHA-256
domain preimage → canonical Nostr **kind-450 event id**); per-ciphersuite
`signature_scheme` decimal-tag parity; **full external-signer parity** (reshape
the signer contract to a "sign this Nostr event" path); rejecting v1 proofs;
updating all `.v1` comments/strings; updating v1 test vectors; and a fresh
Rust-signed → TS-verified round-trip fixture (generated, since none exists).

**Out of scope:** any other wire-boundary work (that is Phase 2+). The kind-450
event is a **local signing template only** — it is never published or relayed.
No multi-device (MIP-06) or push (MIP-05) work.

**Primary research:** `.planning/research/PROOF-V2.md` (exhaustive: exact v2 wire
layout, tag order/format, Rust source refs, per-file/line change list, and the
open questions resolved below). Treat it as the phase's RESEARCH.md — the
planner MUST read it.
</domain>

<decisions>
## Implementation Decisions

### Source of truth

- The **Rust MDK reference is authoritative** for the v2 wire format; `refs/marmot`
  spec still documents only v1 and is behind. Track Rust v2; note the spec lag but
  do not wait on it. (Per project constraint: Rust is authoritative for wire format.)

### v2 wire / signing (LOCKED — from PROOF-V2.md)

- Bump `ACCOUNT_IDENTITY_PROOF_VERSION` to `2` and domain to
  `marmot.account-identity-proof.v2`. Add `ACCOUNT_IDENTITY_PROOF_EVENT_KIND = 450`.
- The extension byte layout is **byte-identical** to v1 — only the version-byte
  value and the _meaning of the signature_ change. Do not alter field order/widths.
- The 64-byte BIP-340 Schnorr signature signs the **NIP-01 event id** of a
  canonical, unsigned kind-450 event:
  `SHA-256([0, pubkey_hex, created_at, kind, tags, content])` with
  `pubkey` = x-only account identity (hex), `kind` = 450, `created_at` = 0,
  `content` = `""`, and tags in this **exact order/format**:
  1. `["d", "marmot.account-identity-proof.v2"]`
  2. `["extension", "0xf2f1"]`
  3. `["version", "2"]`
  4. `["ciphersuite", "<decimal>"]`
  5. `["signature_scheme", "<decimal>"]`
  6. `["mls_signature_key", "<lowercase hex>"]`
- Reuse `getEventHash` from `applesauce-core/helpers/event` for the event id
  (already used in `src/core/application-rumor.ts`), rather than hand-rolling the
  NIP-01 serialization.
- Delete `canonicalMessage()`; `accountIdentityProofSigningDigest()` becomes the
  kind-450 event id builder. `signAccountIdentityProof()` /
  `verifyLeafAccountIdentityProof()` sign/verify against that event id.

### v1 rejection

- Only version byte `2` is emitted and accepted. `decodeAccountIdentityProof()`
  rejects any version != 2 (a v1 proof, version byte `1`, is now rejected).

### signature_scheme parity (LOCKED — resolves PROOF-V2.md open question)

- `signature_scheme` is emitted as the **decimal string of the u16** (Rust
  `self.signature_scheme.to_string()`, e.g. `0x0807 → "2055"`).
- Verify marmot-ts's `mlsSignatureScheme()` values equal the Rust
  `ciphersuite.signature_algorithm() as u16` for **every supported ciphersuite**
  (1–7), so the decimal tag string matches byte-for-byte. If any value diverges,
  the marmot-ts table is corrected to the Rust value.

### External-signer parity (LOCKED — full parity chosen at plan gate)

- Reshape the account-identity-proof signer to a **"sign this Nostr event"** path,
  mirroring Rust `proof_event` / `proof_event_json` / `signature_from_signed_event`.
  This is v2's raison d'être: NIP-07 / NIP-46 remote signers and hardware signers
  can produce the proof via a normal `signEvent` path.
- Expose builders so a caller can (a) obtain the canonical unsigned kind-450 event
  (or its JSON / event id), hand it to an external Nostr signer, and (b) extract the
  64-byte Schnorr signature from the returned signed event.
- Thread the widened signer contract through consumers:
  `src/client/key-package-manager.ts` and `src/client/group-factory.ts`
  (re-exporters of `AccountIdentityProofSigner`). Keep a direct-secret-key signing
  path available for callers that hold the raw key.

### Never published

- The kind-450 event is a local signing template (registries.md:94 — "not
  relayed"). Ensure no code path publishes or relays it.

### Claude's Discretion

- Exact new function/type names and the precise shape of the widened signer
  interface, provided the two capabilities above (external event-signing path +
  raw-key path) are both supported and existing call sites keep compiling.
- Whether the round-trip fixture lives in `darkmatter-invite-compat.test.ts`
  (the natural home per research) or a dedicated proof interop test file.
- Test restructuring details, as long as v1 vectors are replaced with v2 and the
  full suite passes.

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase research (authoritative for this phase)

- `.planning/research/PROOF-V2.md` — full v2 interop audit: wire layout, exact tag
  order/format, per-file/line change list, Rust source refs, open questions.

### marmot-ts source to change

- `src/core/account-identity-proof.ts` — the module being migrated (version,
  domain, signing digest, encode/decode, verify, signer contract).
- `src/core/application-rumor.ts` — existing `getEventHash` usage pattern to reuse.
- `src/client/key-package-manager.ts` — `.v1` comment (:127) + signer re-export.
- `src/client/group-factory.ts` — `AccountIdentityProofSigner` re-export.

### Rust reference (source of truth for v2 wire)

- `refs/mdk` `crates/cgka-engine/src/account_identity_proof.rs`
  — `VERSION=2`, `proof_event()` (tag order), `signature_from_signed_event()`,
  `validate_leaf_account_identity_proof()`, `encode_proof`/`decode_proof`.
- `refs/mdk` `crates/marmot-uniffi/src/external_signer.rs`,
  `crates/cgka-conformance-simulator/src/client.rs` — external-signer wiring parity.

### Spec (behind — v1 only; note the lag)

- `refs/marmot` `foundation/account-identity-proof-v1.md`,
  `foundation/registries.md` (0xf2f1 = v1; kind 450 registered as non-relayed).

</canonical_refs>

<specifics>
## Specific Ideas

- Success criteria to satisfy (from ROADMAP Phase 1):
  1. Emit/accept only version byte `2`; reject version byte `1`.
  2. A marmot-ts v2 proof is accepted by MDK-equivalent verification, proven via a
     Rust-signed → TS-verified round-trip fixture (generated fresh).
  3. Per-ciphersuite `signature_scheme` decimal tag values match Rust
     `signature_algorithm() as u16` for every supported ciphersuite.
  4. The kind-450 proof event carries its six tags in exact Rust order/format and
     is never published/relayed.
- No usable shared byte fixture exists for the proof; the round-trip fixture must
  be generated from the Rust `proof_event`/`encode_proof` (or a Rust-signed proof
  captured and pinned) and checked into the TS test suite.

</specifics>

<deferred>
## Deferred Ideas

- Wiring the proof-v2 round-trip as a permanent parity-harness entry alongside the
  other MDK conformance vectors is **CONF-01 / Phase 4** — this phase only needs the
  round-trip proven once (generated fixture is acceptable here).
- Any spec (`refs/marmot`) update to publish an `account-identity-proof-v2.md` is
  upstream, not marmot-ts scope.

</deferred>

---

_Phase: 01-proof-v2_
_Context gathered: 2026-07-21 via plan-phase gate decisions (research reused, full external-signer parity chosen)_
