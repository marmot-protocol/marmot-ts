# Requirements: marmot-ts — v2.0 Account identity proof v2

**Defined:** 2026-09-12
**Core Value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte,
with any spec-conformant peer (including the Rust MDK reference) — correctly, across every supported runtime.

Milestone goal: clean cut from the legacy `0xf2f1` proof extension to the adopted
`marmot.member.account-identity-proof.v2` app component `0x8009` (104-byte `MarmotAuthorizationProof`), so marmot-ts
interoperates with MDK's default Current-profile groups. Sources: `refs/marmot/app-components/account-identity-proof-v2.md`,
`refs/marmot/foundation/authorization-proofs.md`, `refs/marmot/protocol-core/{group-setup,joining}.md`, MDK
`refs/mdk/crates/cgka-engine/src/{account_identity_proof,app_components,group_lifecycle,self_update}.rs`. Research:
`.planning/research/SUMMARY.md`.

REQ-ID numbering continues from v1.0 (`PROOF-01`, `QA-01`, `QA-02` are archived in
`.planning/milestones/v1.0-REQUIREMENTS.md`).

## v2.0 Requirements

### Authorization proof envelope (AUTHZ)

Shared `src/core` primitive per `foundation/authorization-proofs.md`; the account identity proof is its first proof class.

- [x] **AUTHZ-01**: Developer can encode and decode a `MarmotAuthorizationProof` as exactly 104 bytes; truncated or trailing input is rejected
- [x] **AUTHZ-02**: A proof whose `created_at` is 0 or greater than 2^53−1 is rejected on decode and refused on produce
- [x] **AUTHZ-03**: A proof whose `signer_pubkey` is not a valid x-only secp256k1 public key is rejected
- [x] **AUTHZ-04**: Verifier reconstructs the NIP-01 event id from the envelope plus the proof-class context and accepts only a valid BIP-340 signature over it
- [x] **AUTHZ-05**: An external signer's returned event is accepted only if its pubkey, `created_at`, kind, tags, and content exactly equal the request, its id recomputes, and its signature verifies

### Account identity proof component (PROOF)

- [x] **PROOF-02**: The kind-450 proof event uses the exact 5 ordered tags, `0x`-hex ciphersuite/signature-scheme values, the fixed content string, and a real `created_at`, matching the spec signing test vector byte-for-byte (event id, signature, 104-byte component)
- [x] **PROOF-03**: A generated KeyPackage leaf advertises `0x8009` in its `app_components` support list and carries exactly one `0x8009` entry inside its single LeafNode `app_data_dictionary` extension, via both raw-key and external signers
- [x] **PROOF-04**: A KeyPackage or member leaf is rejected when `0x8009` support or data is missing, the signer differs from the `BasicCredential` identity, the ciphersuite/scheme mismatches (KeyPackage validated with its own ciphersuite, member leaf with the group's), the signed MLS signature key differs from the leaf's, or the signature does not verify
- [x] **PROOF-05**: A `0x8009` proof placed in a KeyPackage-level `extensions` dictionary (instead of `keyPackage.leafNode.extensions`) is rejected
- [x] **PROOF-06**: `0x8009` data in a GroupContext dictionary, GroupInfo, `AppEphemeral` proposal, or SafeAAD item is rejected

### Legacy clean cut (CUT)

- [x] **CUT-01**: marmot-ts never emits `0xf2f1` — not in KeyPackage leaves, `Capabilities.extensions`, or required capabilities — and the legacy proof exports are removed
- [x] **CUT-02**: A KeyPackage or leaf carrying `0xf2f1` (alone or together with `0x8009`) is rejected, and a group requiring `0xf2f1` is rejected as outside the profile

### Group profile requirement (GRP)

- [x] **GRP-01**: A newly created group requires `0x8009` in its GroupContext `app_components` required-component list (not `required_capabilities`) and holds no GroupContext state for it
- [x] **GRP-02**: A commit whose resulting epoch drops the `0x8009` requirement or contains a member leaf without valid `0x8009` support and proof is rejected identically on the send, inbound ingest, pool-replay/fork-recovery, and tree-fed convergence seams
- [x] **GRP-03**: Joining via Welcome fails when the group does not require `0x8009` or any current member lacks a valid proof
- [x] **GRP-04**: Inviting a user and admin-policy admission of a standalone Add proposal validate the invitee's `0x8009` proof before it is proposed or queued

### Self-update binding (UPD)

Validation-only: ts-mls self-update carries the leaf signature key and proof forward; no key-rotation API this milestone.

- [x] **UPD-01**: An Update proposal or committer update-path leaf whose `BasicCredential` identity differs from the member's prior account identity is rejected on every seam
- [x] **UPD-02**: A replacement leaf whose `0x8009` proof does not bind that leaf's resulting signature key (stale or reused proof) is rejected
- [x] **UPD-03**: A commit that removes `0x8009` support or data from a non-blank member leaf is rejected
- [x] **UPD-04**: A standalone Update proposal is re-checked for proof validity and identity equality at admission, before it is queued

### Founding creation via Welcome (FOUND)

Per `protocol-core/joining.md` founding-creation exception and MDK `SendResult::FoundingGroupCreated`.

- [ ] **FOUND-01**: Developer can create a group with initial invitees; the founding Add is merged locally to epoch 1 and no kind-445 group event is published for it
- [ ] **FOUND-02**: The founding Add passes the same proof and group-profile validation as an ordinary commit before it is merged
- [ ] **FOUND-03**: After founding creation the group is `Stable` immediately, with no `PendingPublish` window
- [ ] **FOUND-04**: Each invitee's Welcome is delivered independently; a failed delivery is retryable per invitee and never rolls back the group
- [ ] **FOUND-05**: Initial invitees join at epoch 1 from their Welcome and can exchange messages with the creator

### Interop and quality (QA)

- [ ] **QA-03**: A Rust-signed MDK Current-profile KeyPackage carrying a `0x8009` proof verifies in marmot-ts as a pinned fixture
- [ ] **QA-04**: The full suite is green on Node 20/22/24, Deno 2, and Bun latest/1.1
- [ ] **QA-05**: The public exports snapshot reflects the removed legacy proof exports and the added envelope/component exports

## Future Requirements

Deferred. Tracked but not in the current roadmap.

### Quality

- **QA-F1**: Per-seam parity test matrix — each malformed input (missing, duplicate, `0xf2f1`, wrong ciphersuite, identity change) run through every seam asserting identical rejection
- **QA-F2**: QA-02-style byte-exact parity dossier for the `0x8009` component bound to one tested source SHA

### Identity

- **UPD-F1**: Self-update that installs a new MLS signature key and mints a fresh `0x8009` proof (may need ts-mls work)
- **KP-F1**: Published KeyPackage rotation/refresh to retire legacy KeyPackages
- **MIG-F1**: Legacy-group identity migration flow, if the spec later defines one

## Out of Scope

| Feature | Reason |
|---------|--------|
| Legacy `0xf2f1` compatibility (reading/joining Legacy-profile groups) | Spec forbids a v1/legacy fallback; user chose a clean cut, diverging from MDK's temporary explicit-legacy path |
| Receiver-side `created_at` freshness/expiry | Spec: proofs have no receiver-side age limit; validity must not depend on the local wall clock |
| Generic version field inside the 104-byte envelope | Spec: the component id is the major version |
| Treating an account-identity change as a self-update | Spec: requires remove + separately authorized new membership |
| Publishing a founding commit/group message | Spec and MDK explicitly avoid it; invitees arrive via Welcome |
| Multi-device (MDEV-01), push (PUSH-01) | Deferred milestones; they will reuse the `MarmotAuthorizationProof` primitive |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTHZ-01 | Phase 6 | Complete |
| AUTHZ-02 | Phase 6 | Complete |
| AUTHZ-03 | Phase 6 | Complete |
| AUTHZ-04 | Phase 6 | Complete |
| AUTHZ-05 | Phase 6 | Complete |
| PROOF-02 | Phase 7 | Complete |
| PROOF-03 | Phase 7 | Complete |
| PROOF-04 | Phase 7 | Complete |
| PROOF-05 | Phase 7 | Complete |
| PROOF-06 | Phase 7 | Complete |
| CUT-01 | Phase 7 | Complete |
| CUT-02 | Phase 7 | Complete |
| GRP-01 | Phase 8 | Complete |
| GRP-02 | Phase 8 | Complete |
| GRP-03 | Phase 8 | Complete |
| GRP-04 | Phase 8 | Complete |
| UPD-01 | Phase 9 | Complete |
| UPD-02 | Phase 9 | Complete |
| UPD-03 | Phase 9 | Complete |
| UPD-04 | Phase 9 | Complete |
| FOUND-01 | Phase 10 | Pending |
| FOUND-02 | Phase 10 | Pending |
| FOUND-03 | Phase 10 | Pending |
| FOUND-04 | Phase 10 | Pending |
| FOUND-05 | Phase 10 | Pending |
| QA-03 | Phase 11 | Pending |
| QA-04 | Phase 11 | Pending |
| QA-05 | Phase 11 | Pending |

**Coverage:**

- v2.0 requirements: 28 total
- Mapped to phases: 28
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-12*
*Last updated: 2026-09-12 after roadmap creation (Phases 6-11)*
