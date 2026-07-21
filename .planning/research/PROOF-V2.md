# Account Identity Proof v1 → v2 — Interop Audit

Investigation only. No source changed.

## Summary verdict

**YES — interop-breaking.** The Rust darkmatter reference moved
`marmot.account-identity-proof` from **v1 to v2**. marmot-ts still implements v1.
A v1 proof produced by marmot-ts will be **rejected** by any current darkmatter
peer (and vice versa) for two independent reasons:

1. **Version-byte mismatch.** The extension payload's first byte is `2` in the
   Rust `decode_proof`, which hard-fails on any other value
   (`unsupported proof version {version}`). marmot-ts emits/accepts only `1`.
2. **Different signing input.** Even setting the version byte aside, the 64-byte
   Schnorr signature now signs a completely different message (a canonical Nostr
   kind-450 event id, not the old SHA-256 domain preimage), so signatures do not
   cross-verify.

## What actually changed (and what did NOT)

The **extension wire layout is byte-identical** between v1 and v2 — same fields,
same order, same fixed-width big-endian encoding. Only the version byte value
and the _meaning of the signature_ changed.

```
uint8  version          // v1 = 1   →   v2 = 2      (ONLY structural change)
uint16 ciphersuite      // BE, unchanged
uint16 signature_scheme // BE, unchanged
opaque account_identity[32]         // unchanged, no length prefix
uint16 mls_signature_public_key_len // BE, unchanged
opaque mls_signature_public_key[len]// unchanged
opaque schnorr_signature[64]        // 64 bytes, but signs a DIFFERENT message
```

### v1 signing input (what marmot-ts does today)

BIP-340 Schnorr over `SHA-256(preimage)`, where the preimage is a standalone,
domain-separated byte string (NOT a Nostr event):

```
ASCII "marmot.account-identity-proof.v1"
uint8  0
uint16 extension_type = 0xf2f1
uint8  version = 1
uint16 ciphersuite
uint16 signature_scheme
uint16 account_identity_len = 32
opaque account_identity[32]
uint16 mls_signature_public_key_len
opaque mls_signature_public_key[len]
```

Ref: marmot-ts `src/core/account-identity-proof.ts:92-112` (`canonicalMessage`,
`accountIdentityProofSigningDigest`); spec `foundation/account-identity-proof-v1.md:44-67`.

### v2 signing input (what darkmatter does now)

The signature IS a **Nostr event signature over a canonical, unpublished
kind-450 event**. The signed 32-byte message is the NIP-01 event id =
`SHA-256([0, pubkey_hex, created_at, kind, tags, content])`.

- `pubkey` = the 32-byte x-only account identity (event author)
- `kind` = `450`
- `created_at` = `0` (Timestamp::zero())
- `content` = `""`
- `tags`, in this exact order:
  1. `["d", "marmot.account-identity-proof.v2"]`
  2. `["extension", "0xf2f1"]`
  3. `["version", "2"]`
  4. `["ciphersuite", "<decimal>"]` (e.g. `"1"`)
  5. `["signature_scheme", "<decimal>"]` (e.g. `"2055"` for 0x0807)
  6. `["mls_signature_key", "<lowercase hex>"]`

The signature is BIP-340 Schnorr over that event id, verified with
`account_identity`. Note the fields are now carried as **decimal/hex strings in
Nostr tags**, not fixed-width integers in a preimage; `account_identity` is the
event `pubkey`, not an explicit tag.

Ref: Rust `crates/cgka-engine/src/account_identity_proof.rs:67-102`
(`proof_event`), `:115-130` (`signature_from_signed_event`), `:214-227` (verify
via `proof_event().add_signature()`), `:39-40` (VERSION=2 / domain `.v2`).

### Why v2 exists (motivation)

Landed in mdk commit **cf780a1 "Add external signer account support (#755)"**
(2026-07-07). v1 required signing a bespoke SHA-256 preimage, which external
Nostr signers (NIP-46 remote signers, hardware) cannot produce. v2 makes the
proof a normal (canonical, unpublished) Nostr event so any Nostr `sign_event`
path can produce it. See the module-level TODO(mdk#755) and
`crates/marmot-uniffi/src/external_signer.rs` (`proof_event_json` → foreign
`sign_event` → `signature_from_signed_event`).

## Where it's spec'd

**Rust-only, ahead of spec.** `refs/marmot` still documents **only v1**:

- `foundation/account-identity-proof-v1.md` (title "Account identity proof v1",
  version byte `0x01`, the old SHA-256 preimage).
- `foundation/registries.md:54` registers `0xf2f1` as
  `marmot.account-identity-proof.v1`.
- `identity.md`, `key-packages.md`, `mls-protocol.md`, `joining.md`,
  `transports/nostr.md:245` all still say `.v1`.
- No `account-identity-proof-v2.md` exists; spec git log shows no v2 commit.

Kind `450` is registered in `foundation/registries.md:94` as the "Multi-device
identity proof event (Local signing template, not relayed)" — consistent with
v2's unpublished kind-450 event, but the spec's proof doc has not been updated
to v2. The Rust reference is the source of truth for wire format here.

## Rust source refs (canonical v2)

- `crates/cgka-engine/src/account_identity_proof.rs`
  - `:36` ext type `0xF2F1`; `:37` `ACCOUNT_IDENTITY_PROOF_EVENT_KIND = 450`
  - `:39` `VERSION = 2`; `:40` domain `marmot.account-identity-proof.v2`
  - `:67-102` `proof_event()` — canonical kind-450 event + tag order
  - `:104-113` `proof_event_json()` / `proof_event_id()`
  - `:115-130` `signature_from_signed_event()`
  - `:173-228` `validate_leaf_account_identity_proof()` (decode + verify)
  - `:291-301` `encode_proof()`; `:303-334` `decode_proof()` (version==2 gate)
- Signer wiring / external-signer parity:
  `crates/cgka-conformance-simulator/src/client.rs:236-255`;
  `crates/marmot-uniffi/src/external_signer.rs:164-185`.

## marmot-ts current state (v1 — must change)

All in `src/core/account-identity-proof.ts`:

- `:38` `ACCOUNT_IDENTITY_PROOF_VERSION = 1`
- `:39` domain `"marmot.account-identity-proof.v1"`
- `:92-105` `canonicalMessage()` — the OLD v1 preimage (delete/replace)
- `:108-112` `accountIdentityProofSigningDigest()` — must become the kind-450
  event id
- `:115-120` `signAccountIdentityProof()` — signs the old digest
- `:123-140` `encodeAccountIdentityProof()` — writes version byte (bump to 2)
- `:143-167` `decodeAccountIdentityProof()` — rejects version != 1 (→ 2)
- `:208-242` `verifyLeafAccountIdentityProof()` — rebuilds/verifies old digest
- Doc comment `:26-35` describes v1 wire; error strings `:221` name `.v1`.

Consumers referencing `.v1` in comments:
`src/client/key-package-manager.ts:127`.
Signer type `AccountIdentityProofSigner` also re-exported via
`src/client/group-factory.ts` and `key-package-manager.ts`.

## Required changes in marmot-ts

1. **`src/core/account-identity-proof.ts` — version + domain**: bump
   `ACCOUNT_IDENTITY_PROOF_VERSION` to `2` and domain to
   `marmot.account-identity-proof.v2`. This alone changes the emitted/accepted
   version byte. Add `ACCOUNT_IDENTITY_PROOF_EVENT_KIND = 450`.
2. **`src/core/account-identity-proof.ts` — replace the signing digest**: delete
   `canonicalMessage()`; make `accountIdentityProofSigningDigest()` build the
   canonical kind-450 Nostr event id. Reuse the existing
   `getEventHash` from `applesauce-core/helpers/event` (already used in
   `src/core/application-rumor.ts:2,90` — it does the exact
   `[0, pubkey, created_at, kind, tags, content]` serialization). Build the
   unsigned event with pubkey = account-identity hex, kind 450, created_at 0,
   content "", and the six tags in the **exact Rust order/format** (decimal
   ciphersuite & signature_scheme, `"0xf2f1"` extension, hex mls key).
3. **`signAccountIdentityProof()` / `verifyLeafAccountIdentityProof()`**: sign /
   verify BIP-340 Schnorr against that event id (schnorr.sign/verify already in
   place — only the message bytes change).
4. **`encodeAccountIdentityProof()` / `decodeAccountIdentityProof()`**: no
   structural change beyond the version constant; confirm the version gate now
   accepts only `2`.
5. **External-signer parity (recommended, this is the reason v2 exists)**:
   expose helpers mirroring Rust `proof_event` / `proof_event_json` /
   `signature_from_signed_event` so a NIP-07/NIP-46 signer can sign the kind-450
   event via a normal `signEvent` path and marmot-ts can extract the 64-byte
   sig. Touch `src/core/account-identity-proof.ts` (add builders) and thread
   through `src/client/key-package-manager.ts` /
   `src/client/group-factory.ts` if the signer contract is widened.
6. **Comments / strings**: update all `.v1` mentions in
   `src/core/account-identity-proof.ts` (doc block :26-35, error msgs) and
   `src/client/key-package-manager.ts:127`.
7. **Tests** (v1 vectors baked in — will fail): update
   `src/core/__tests__/account-identity-proof.test.ts` and any proof-touching
   fixtures in `src/core/__tests__/{darkmatter-invite-compat,welcome,capabilities,key-package}.test.ts`,
   `src/client/group/proposals/__tests__/invite-user.test.ts`,
   `src/engine/__tests__/group-engine.test.ts`,
   `src/client/group/__tests__/marmot-group.test.ts`.

## Test vectors

**None usable for cross-checking the proof.** darkmatter's
`crates/cgka-conformance-simulator/vectors/byte-fixtures/` only contains
`nostr-routing-v1-*` fixtures + a schema; no proof/kind-450/`0xf2f1` byte
vector exists. The only reference "vectors" are in-code Rust unit tests
(`account_identity_proof.rs:363-417`), which sign live keys rather than pin
bytes. Cross-runtime confidence will require either (a) generating a shared
fixture from the Rust `proof_event`/`encode_proof` and checking marmot-ts
reproduces the same event id + payload bytes, or (b) a round-trip interop test
(Rust-signed proof verified by marmot-ts). The existing `darkmatter-invite-compat.test.ts`
is the natural home for such a cross-check.

## Open questions / ambiguities

- **Spec lag**: spec is still v1 while Rust ships v2. Confirm marmot-ts should
  track the Rust reference (per project constraint "Rust code + spec are the
  source of truth… Rust for wire format") — treat Rust v2 as authoritative and
  note the spec is behind.
- **`signature_scheme` tag encoding**: Rust emits it as a decimal string of the
  u16 (`self.signature_scheme.to_string()`), e.g. `0x0807` → `"2055"`. Confirm
  marmot-ts's `mlsSignatureScheme()` values match darkmatter's
  `ciphersuite.signature_algorithm() as u16` for every supported ciphersuite so
  the tag string matches byte-for-byte.
- **Signer contract shape**: v2's raison d'être is external Nostr signers. Decide
  whether marmot-ts's `AccountIdentityProofSigner` stays "sign this digest" or is
  reshaped to "sign this Nostr event" for true external-signer parity. Minimal
  interop needs only the digest change; feature parity wants the event path.
- **No published event**: the kind-450 event is a local signing template only
  (never relayed), consistent with registries.md:94 — ensure marmot-ts never
  publishes it.
