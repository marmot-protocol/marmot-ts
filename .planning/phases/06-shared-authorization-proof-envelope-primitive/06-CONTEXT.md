# Phase 6: Shared Authorization-Proof Envelope Primitive - Context

**Gathered:** 2026-09-12
**Status:** Ready for planning

<domain>
## Phase Boundary

A pure, I/O-free `src/core` primitive that encodes, decodes, produces, and verifies the 104-byte
`MarmotAuthorizationProof` envelope (`signer_pubkey[32] ‖ created_at uint64 BE ‖ signature[64]`) defined in
`refs/marmot/foundation/authorization-proofs.md`. It is proof-class-agnostic: a proof class supplies the event
template (kind, ordered tags, content); the primitive owns the envelope bytes, `created_at` range rules, NIP-01
event-id reconstruction, BIP-340 verification, and strict external-signer return validation.

Covers AUTHZ-01..05. Explicitly NOT in this phase: the `0x8009` proof-class module, KeyPackage/leaf wiring, and any
change to or removal of the legacy `src/core/account-identity-proof.ts` (`0xf2f1`) — all Phase 7.

</domain>

<decisions>
## Implementation Decisions

### Proof-class plug-in shape
- **D-01:** The primitive takes a plain data template `{ kind, tags, content }` plus the envelope. No `ProofClass`
  descriptor interface. Each proof class (Phase 7+) exposes its own function that builds the template from its
  protocol values.
- **D-02:** The primitive performs only minimal structural sanity checks on the template: `kind` is an integer,
  `tags` is `string[][]`, `content` is a string. No kind registry; exact tag order/values are the proof class's
  responsibility and are covered by the event-id recompute.
- **D-03:** Single file: `src/core/authorization-proof.ts`.

### Rejection / error model
- **D-04:** Rejections are thrown as a typed error — `AuthorizationProofError extends Error` (sets `this.name`, like
  `BinaryDecodeError` in `src/core/binary.ts`) carrying a `reason` literal-union field. Later seams that need a
  `{ kind }` result (e.g. `validateCommitLegality` in Phase 8) catch and map `reason`.
- **D-05:** One reason per spec validation step, not coarse buckets. At minimum: invalid length (truncated/trailing),
  invalid signer pubkey (not a valid x-only secp256k1 point), `created_at` out of range / non-integer, malformed
  template, signature invalid; and on the produce path, one reason per substituted field of the external signer's
  returned event — pubkey, created_at, kind, tags, content — plus id mismatch and returned-signature invalid.

### `created_at` in the public API
- **D-06:** `createdAt` is a `number` on the public proof type. Decode reads it with `BinaryReader.uint64()` (bigint),
  range-checks `[1, 2^53−1]` **as a bigint**, then converts to `Number` (exact under that ceiling).
- **D-07:** Produce accepts an optional injected `createdAt` (or clock); default is `Math.floor(Date.now() / 1000)`.
  Tests/fixtures pass a fixed value for byte-stable output (Phase 5 precedent of injected time/randomness).
- **D-08:** Produce rejects a `createdAt` that is not `Number.isSafeInteger` (e.g. `1.5`, `NaN`) as well as
  out-of-range values, before asking the signer to sign. Never silently floor.

### Signer contract
- **D-09:** Signing goes through an event signer only — the produce function accepts
  `Pick<EventSigner, "signEvent">` (type from `applesauce-core`). **This deliberately reverses the v1.0 Phase 01
  decision** that kept a raw-key digest-function path alongside `{ signEvent }`: every signature now passes the same
  returned-event validation. A full applesauce `EventSigner` satisfies the type; raw-key callers pass a tiny
  hand-rolled `{ signEvent }` object. No new runtime dependency (`applesauce-signers` is not a library dependency).
- **D-10:** The signer must return a full `NostrEvent` (`id, pubkey, created_at, kind, tags, content, sig`). Produce
  compares each of pubkey/created_at/kind/tags/content against the request exactly, recomputes the NIP-01 id and
  compares it, and verifies the BIP-340 signature — per AUTHZ-05. The legacy `{ id, pubkey, sig }`-only shape
  (`SignedAccountIdentityProofEvent`) is not reused.
- **D-11:** Produce does NOT pre-flight `signer.getPublicKey()`. The caller supplies the expected signer pubkey
  explicitly (the proof class knows it), and the returned-event pubkey comparison catches mismatches — avoids an extra
  NIP-46 round-trip.

### Rollout & verification
- **D-12:** Export through the core barrel now (`export * from "./authorization-proof.js"` in `src/core/index.ts`) and
  update `src/__tests__/exports.test.ts` in this phase so the snapshot is not left stale for the new symbols.
- **D-13:** Phase 6 includes a byte-exact test against the spec signing vector in
  `refs/marmot/app-components/account-identity-proof-v2.md` using an inline, hand-built kind-450 v2 template (secret
  key `3`, all-zero aux randomness, `created_at = 1700000000`): assert the exact event id `b7e9a15d…af6b`, signature,
  and 104-byte component hex through the generic primitive. The test's hand-rolled `signEvent` calls
  `schnorr.sign(id, sk, zeroAux)` to reproduce the vector. Phase 7 reuses the vector through the real class builder.

### Claude's Discretion
- Exact exported symbol names (e.g. `encodeAuthorizationProof` / `decodeAuthorizationProof` /
  `produceAuthorizationProof` / `verifyAuthorizationProof`, `AuthorizationProofTemplate`), reason string spelling
  (follow codebase literal-union conventions), and whether verify takes the decoded proof or raw bytes (or both).
- Whether x-only validity is checked via `schnorr.utils.lift_x` explicitly or relied on inside verify — but the
  distinct `invalid signer pubkey` reason (D-05) must be reachable on decode, independent of signature verification.
- JSDoc depth; cite spec paths (`foundation/authorization-proofs.md`), not `MIP-NN`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Envelope spec (normative)
- `refs/marmot/foundation/authorization-proofs.md` — envelope struct, 104-byte encoding, `created_at` range, event-id
  reconstruction, producer external-signer rules, verifier steps 1–6, no receiver wall-clock rule
- `refs/marmot/foundation/canonical-encoding.md` — Marmot binary profile and "Nostr-shaped values" (NIP-01
  serialization/event-id rules)
- `refs/marmot/app-components/account-identity-proof-v2.md` §"Signing test vector" — the byte-exact vector used by D-13
  (first proof class; the class itself is Phase 7)

### Rust reference
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs` — `CURRENT_PROOF_LEN`, `MAX_NIP01_TIMESTAMP`,
  `validate_current_timestamp`, `account_identity_proof_component` (encode), `validate_current_proof` (decode),
  `signature_from_signed_event`, test `current_proof_matches_the_adopted_signing_vector`. MDK has no generic envelope
  layer — the generic split (D-01) is marmot-ts design.

### Planning / research
- `.planning/REQUIREMENTS.md` — AUTHZ-01..05
- `.planning/research/SUMMARY.md` — Phase 6 rationale, stack confirmation (no new deps)
- `.planning/research/PITFALLS.md` — Pitfall 2 (created_at precision), 4 (strict 104-byte decode), 5 (x-only
  validity), 6 (external-signer substitution), 17 (cross-runtime BigInt/DataView)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/core/binary.ts` — `BinaryWriter.uint64` / `BinaryReader.uint64()` (DataView big-endian bigint), `bytes(n)`,
  `reader.end()` for trailing-byte rejection, `BinaryDecodeError` as the typed-error pattern to mirror.
- `applesauce-core/helpers/event` `getEventHash` — exact NIP-01 event id (already used by the legacy proof module).
- `@noble/curves/secp256k1.js` `schnorr.verify` / `schnorr.utils.lift_x`; `@noble/hashes/utils.js`
  `bytesToHex` / `hexToBytes`.
- `applesauce-core` `EventSigner` type (`getPublicKey` + `signEvent(draft) => NostrEvent`), already used across
  `src/client`.

### Established Patterns
- `src/core/account-identity-proof.ts` `accountIdentityProofSignatureFromSignedEvent` — prior external-signer
  re-verification (pubkey + id + sig only); the new primitive strengthens it to full per-field comparison (D-10).
  Leave the legacy file untouched this phase.
- `src/client/verify.ts` `safeVerifyEvent` — applesauce `verifyEvent` can throw on malformed events; the primitive's
  own id/sig checks should not assume non-throwing helpers.
- Named exports only, `.js` relative import extensions, `Uint8Array` for binary, no `Buffer`.

### Integration Points
- `src/core/index.ts` barrel (D-12) and `src/__tests__/exports.test.ts` snapshot. Note STATE.md records the exports
  snapshot as already stale from earlier work — planner should check whether updating it here also absorbs that
  pre-existing drift.
- Tests colocated under `src/core/__tests__/authorization-proof.test.ts`; must pass on Node 20/22/24, Deno 2, Bun.
- Consumers (later phases): Phase 7 `0x8009` class in `src/core/components/`; Phase 8 `validateCommitLegality`.

</code_context>

<specifics>
## Specific Ideas

- The spec vector (secret key 3, zero aux, `created_at` 1700000000, 104-byte hex
  `f9308a01…36f9 000000006553f100 c5315d3c…fb5d`) must reproduce byte-for-byte through the generic primitive in
  Phase 6, not only in Phase 7.
- Negative tests should cover each D-05 reason individually, including `created_at` = 0, = 2^53 (one past the ceiling),
  max-u64 on the wire, a non-point x-only pubkey, 103/105-byte inputs, and each substituted returned-event field.

</specifics>

<deferred>
## Deferred Ideas

- Phase 7 consequence of D-09: the legacy `AccountIdentityProofSigner` digest-function shape and
  `SignedAccountIdentityProofEvent` go away with the `0xf2f1` clean cut; KeyPackage generation call sites
  (`src/client/key-package-manager.ts`, `group-factory.ts`, etc.) must move to `{ signEvent }` signers.
- Kind-registry enforcement of "different authority classes MUST use different kinds" — rejected for Phase 6 (D-02);
  revisit if multi-device/push proof classes land.

</deferred>

---

*Phase: 06-shared-authorization-proof-envelope-primitive*
*Context gathered: 2026-09-12*
