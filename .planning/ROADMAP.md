# Roadmap: marmot-ts

## Milestones

- ✅ **v1.0 Catchup** - Phases 1-5, incl. 03.1 and 04.1 (shipped 2026-09-11) — [archive](milestones/v1.0-ROADMAP.md)
- 🚧 **v2.0 Account identity proof v2** - Phases 6-11 (in progress, started 2026-09-12)

## Phases

<details>
<summary>✅ v1.0 Catchup (Phases 1-5, incl. 03.1, 04.1) — SHIPPED 2026-09-11</summary>

Resync to the post-split marmot spec + MDK Rust reference. 7 phases, 53 plans, 16/16 requirements
satisfied. Full detail: `milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`, phase
artifacts in `milestones/v1.0-phases/`.

</details>

### 🚧 v2.0 Account identity proof v2 (In Progress)

**Milestone Goal:** Replace the legacy `0xf2f1` proof extension with the adopted
`marmot.member.account-identity-proof.v2` app component `0x8009` (104-byte `MarmotAuthorizationProof`)
so marmot-ts interoperates with MDK's default Current-profile groups.

**Phase Numbering:**

- Integer phases: Planned milestone work
- Decimal phases (N.1, N.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 6: Shared Authorization-Proof Envelope Primitive** - Pure 104-byte `MarmotAuthorizationProof` codec, `created_at` range check, and BIP-340/external-signer verification, independent of any proof class (completed 2026-09-12)
- [x] **Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut** - Kind-450 proof-class module, KeyPackage/leaf negotiation, and full removal of the legacy `0xf2f1` extension with no fallback (completed 2026-09-14)
- [ ] **Phase 8: GroupContext Profile Requirement & Legality-Seam Extension** - `0x8009` required on every group and enforced identically across create, invite, join, inbound, and convergence seams
- [ ] **Phase 9: Self-Update / Replacement-Leaf Identity Binding** - Leaf replacement preserves account identity and keeps the proof bound to the new signature key
- [ ] **Phase 10: Founding Group Creation via Welcome** - Current-profile group creation merges the founding Add locally and delivers membership via independently-retryable Welcomes only
- [ ] **Phase 11: Interop Fixtures, Exports Snapshot & QA Gate** - Rust-signed fixture verification, exports snapshot, and a green six-runtime suite

## Phase Details

### Phase 6: Shared Authorization-Proof Envelope Primitive

**Goal**: A shared, reusable `src/core` primitive can encode, decode, and verify the 104-byte
`MarmotAuthorizationProof` envelope defined in `foundation/authorization-proofs.md`, independent of
any specific proof class — the cheapest possible correctness gate and a hard blocker for every
other phase in this milestone.
**Depends on**: Nothing (first phase of v2.0; builds on the shipped v1.0 baseline)
**Requirements**: AUTHZ-01, AUTHZ-02, AUTHZ-03, AUTHZ-04, AUTHZ-05
**Success Criteria** (what must be TRUE):

1. Encoding a valid envelope produces exactly 104 bytes, and decoding rejects any input that is truncated or carries trailing bytes.
2. Decoding a proof whose `created_at` is 0 or greater than 2^53−1 throws, and producing a proof refuses the same out-of-range values before signing.
3. Decoding a proof whose `signer_pubkey` is not a valid x-only secp256k1 public key is rejected.
4. Verification reconstructs the exact NIP-01 event id from the envelope plus proof-class context and accepts only a valid BIP-340 signature over it.
5. An external signer's returned event is accepted only when its pubkey, `created_at`, kind, tags, and content exactly equal the request, its id recomputes, and its signature verifies — any mismatch is rejected.

**Plans**: 1/1 plans complete

Plans:

- [x] 06-01-PLAN.md — 104-byte `MarmotAuthorizationProof` codec, BIP-340 verify, strict external-signer produce, spec-vector test, core barrel + exports snapshot

### Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut

**Goal**: KeyPackages and member leaves carry the adopted `0x8009` account identity proof
component byte-exact with the spec's signing test vector, and the legacy `0xf2f1` proof is fully
removed from publish, verify, capabilities, and admin policy with no fallback path.
**Depends on**: Phase 6
**Requirements**: PROOF-02, PROOF-03, PROOF-04, PROOF-05, PROOF-06, CUT-01, CUT-02
**Success Criteria** (what must be TRUE):

1. Building the kind-450 proof event from the spec's signing test vector reproduces its exact event id, signature, and 104-byte component byte-for-byte.
2. A generated KeyPackage/leaf — via both raw-key and external signers — advertises `0x8009` in its `app_components` support list and carries exactly one `0x8009` entry in its single `app_data_dictionary` extension.
3. A KeyPackage or leaf is rejected when `0x8009` support or data is missing, the signer/ciphersuite/scheme/signature-key mismatches, or the signature fails to verify; a `0x8009` entry placed in the wrong container (KeyPackage-level `extensions`, GroupContext, GroupInfo, `AppEphemeral`, or SafeAAD) is also rejected.
4. marmot-ts never emits `0xf2f1` anywhere — not in leaves, `Capabilities.extensions`, or required capabilities — and the legacy proof exports no longer exist in the package.
5. Any KeyPackage, leaf, or group still carrying or requiring `0xf2f1` is rejected outright.

**Plans**: 8/8 plans complete

Plans:
**Wave 1**

- [x] 07-01-PLAN.md — `0x8009` proof-class module: kind-450 template/producer (spec vector), leaf/KeyPackage/tree validators, GroupContext profile classifier, container guards (wave 1)
- [x] 07-02-PLAN.md — Remove the separate proof-signer option from the client; core `signer` option; delete raw-key helpers; ordered test-account helper (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 07-03-PLAN.md — Engine tests pass real signers (wave 2)
- [x] 07-04-PLAN.md — Core and client unit tests pass real signers (wave 2)
- [x] 07-05-PLAN.md — Integration and conformance tests pass real signers (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 07-06-PLAN.md — Atomic wire cut: required signer + `0x8009` leaf, groups require `0x8009`, `0xf2f1` dropped, invite/admin/join seams validate (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 07-07-PLAN.md — Delete legacy module, tests, fixture, and proof-v2-probe; exports snapshot; grep audit (wave 4)
- [x] 07-08-PLAN.md — Skip non-current stored KeyPackages (D-09); major changeset and docs migration (wave 4)

### Phase 8: GroupContext Profile Requirement & Legality-Seam Extension

**Goal**: Every group requires the `0x8009` profile in its GroupContext, and that requirement is
enforced identically across group creation, invite, join, inbound ingest, and convergence — closing
this codebase's recurring seam-asymmetry defect class before any seam-local work begins.
**Depends on**: Phase 7
**Requirements**: GRP-01, GRP-02, GRP-03, GRP-04
**Note**: Research flags this phase as the primary defense point against seam asymmetry (the
"mdk#707" pattern); budget a review-fix cycle here specifically, centralizing the check in the
shared `validateCommitLegality` adapter before any seam-local swap.
**Success Criteria** (what must be TRUE):

1. A newly created group's GroupContext required-component list includes `0x8009`, with no GroupContext-level state stored for it.
2. A commit that drops the `0x8009` requirement, or results in a member leaf without valid `0x8009` support and proof, is rejected identically whether it arrives via send, inbound ingest, pool-replay/fork-recovery, or tree-fed convergence.
3. Joining via Welcome fails when the group does not require `0x8009` or any current member's proof is invalid.
4. Inviting a user, and admin-policy admission of a standalone Add proposal, both validate the invitee's `0x8009` proof before the proposal is created or queued.

**Plans**: TBD

Plans:

- [ ] TBD

### Phase 9: Self-Update / Replacement-Leaf Identity Binding

**Goal**: Replacing a member's leaf — via self-update or a committer's update-path — preserves the
member's account identity and keeps the `0x8009` proof correctly bound to the leaf's resulting
signature key, on every legality seam. Validation-only this milestone; no new key-rotation API.
**Depends on**: Phase 8
**Requirements**: UPD-01, UPD-02, UPD-03, UPD-04
**Success Criteria** (what must be TRUE):

1. An Update proposal or committer update-path leaf whose `BasicCredential` identity differs from the member's prior account identity is rejected on every seam.
2. A replacement leaf whose `0x8009` proof does not bind that leaf's resulting signature key (a stale or reused proof) is rejected.
3. A commit that removes `0x8009` support or data from a non-blank member leaf is rejected.
4. A standalone Update proposal is re-checked for proof validity and identity equality at admission, before it is queued.

**Plans**: TBD

Plans:

- [ ] TBD

### Phase 10: Founding Group Creation via Welcome

**Goal**: Creating a Current-profile group with initial invitees publishes no founding commit;
the founding Add is merged locally to epoch 1, the group reaches `Stable` immediately, and each
invitee joins via an independently-retryable Welcome.
**Depends on**: Phase 9
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05
**Note**: Highest-complexity, most architecturally novel phase in the milestone — no existing
marmot-ts precedent for a welcome-only publish path. Research recommends a dedicated research pass
during planning (`/gsd-plan-phase --research-phase 10`).
**Success Criteria** (what must be TRUE):

1. Creating a group with initial invitees merges the founding Add locally to epoch 1 and publishes no kind-445 group event for it.
2. The founding Add passes the same proof and group-profile validation as an ordinary commit before it is merged.
3. Immediately after founding creation the group's lifecycle state is `Stable`, with no `PendingPublish` window.
4. Each invitee's Welcome is delivered independently; a failed delivery is retryable per invitee and never rolls back the group.
5. An invitee who receives their Welcome joins at epoch 1 and can exchange messages with the creator.

**Plans**: TBD

Plans:

- [ ] TBD

### Phase 11: Interop Fixtures, Exports Snapshot & QA Gate

**Goal**: The `0x8009` cutover is verified against a Rust-signed MDK fixture and the full
cross-runtime suite, and the public export surface reflects the removed legacy proof exports and
the added envelope/component exports — the milestone is shippable.
**Depends on**: Phase 10
**Requirements**: QA-03, QA-04, QA-05
**Success Criteria** (what must be TRUE):

1. A pinned Rust-signed MDK Current-profile KeyPackage fixture carrying a `0x8009` proof verifies successfully in marmot-ts.
2. The full Vitest suite is green on Node 20, Node 22, Node 24, Deno 2, and Bun latest/1.1.
3. The public exports snapshot (`src/__tests__/exports.test.ts`) reflects the removed legacy proof exports and the added envelope/component exports, with no stale `0xf2f1` references remaining.

**Plans**: TBD

Plans:

- [ ] TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 3.1 → 4 → 4.1 → 5 → 6 → 7 → 8 → 9 → 10 → 11

| Phase                                                    | Milestone | Plans Complete | Status      | Completed  |
| --------------------------------------------------------- | --------- | --------------- | ----------- | ---------- |
| 1. Proof v2                                                | v1.0      | 2/2             | Complete    | 2026-07-21 |
| 2. Inbound Trust & Wire Boundary                           | v1.0      | 4/4             | Complete    | 2026-07-22 |
| 3. Commit Integrity & Convergence Parity                   | v1.0      | 11/11           | Complete    | 2026-09-01 |
| 3.1. Phase 3 Review Closure                                | v1.0      | 15/15           | Complete    | 2026-09-02 |
| 4. Feature Parity & Conformance Vectors                    | v1.0      | 7/7             | Complete    | 2026-09-05 |
| 4.1. Terminal Group Disbanding                             | v1.0      | 6/6             | Complete    | 2026-09-06 |
| 5. Quality Gate                                            | v1.0      | 8/8             | Complete    | 2026-09-06 |
| 6. Shared Authorization-Proof Envelope Primitive           | v2.0      | 1/1 | Complete    | 2026-09-12 |
| 7. Account Identity Proof Component (0x8009) + Clean Cut   | v2.0      | 8/8 | Complete    | 2026-09-14 |
| 8. GroupContext Profile Requirement & Legality-Seam Ext.   | v2.0      | 0/TBD           | Not started | -          |
| 9. Self-Update / Replacement-Leaf Identity Binding         | v2.0      | 0/TBD           | Not started | -          |
| 10. Founding Group Creation via Welcome                    | v2.0      | 0/TBD           | Not started | -          |
| 11. Interop Fixtures, Exports Snapshot & QA Gate           | v2.0      | 0/TBD           | Not started | -          |

## Backlog

### Phase 999.1: Group image support — check and add so downstream apps can show and update the group image (BACKLOG)

**Goal:** [Captured for future planning] — verify group image (avatar) support end-to-end so downstream apps can read/display and update a group's image. Likely touches the group image/avatar-url (0x8007) extension and the group metadata surface.
**Requirements:** TBD
**Plans:** 8/8 plans complete

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.2: Documentation review & update for current library state ahead of next release (BACKLOG)

**Goal:** [Captured for future planning] — review and update the docs (VitePress `docs/` + TypeDoc reference) to match the current state of the library in preparation for the next release.
**Requirements:** TBD
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.3: Exhaustive Gap Audit (shelved from milestone v1.0 Phase 1) (BACKLOG)

**Goal:** A rewritten, verified SPEC_GAP_REVIEW.md supersedes the stale June 2026 snapshot and becomes the authoritative closure backlog. Context gathered + discussion completed; no plans written. Depends on nothing; 999.4/999.5/999.6 depend on this. Full detail + prior work in `999.3-exhaustive-gap-audit/` (SHELVED.md, 01-CONTEXT.md, 01-DISCUSSION-LOG.md).
**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.4: Blocker & Security Closure (shelved from milestone v1.0 Phase 2) (BACKLOG)

**Goal:** Close every confirmed single-device blocker and security hardening gap — cross-epoch media decryption, convergence apply-gating, arrival-order-free branch selection, authenticate-before-decrypt, and public API classifiers matching the wire format. Depends on 999.3. Full detail in `999.4-blocker-and-security-closure/SHELVED.md`.
**Requirements:** MEDIA-01, MEDIA-02, CONV-01, CONV-02, SEC-01, SEC-02, API-01
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.5: Wire / Conformance & Docs (shelved from milestone v1.0 Phase 3) (BACKLOG)

**Goal:** Close remaining wire-format, codec, and API conformance gaps confirmed by the audit; document unsupported features (QUIC VarInt canonicality, duplicate-tag rejection, blossom-image 0x8002 unsupported, WIRE-03/04 disposition, URL-normalization vectors). Depends on 999.4. Full detail in `999.5-wire-conformance-and-docs/SHELVED.md`.
**Requirements:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, CONF-01, DOC-01
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.6: Quality Gate (shelved from milestone v1.0 Phase 4) (BACKLOG)

**Goal:** Green Vitest suite on Node 20/22/24, Deno 2, Bun latest/1.1, plus byte-exact Rust reference verification for every closure change. Depends on 999.5. Full detail in `999.6-quality-gate/SHELVED.md`.
**Requirements:** QA-01, QA-02
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.7: Optional key package identifier — invite-only client mode (BACKLOG)

**Goal:** [Captured for future planning] — `MarmotClient` should be constructible without a client identifier for its key package. Without an identifier the client cannot publish a key package, so it operates in "invite-only" mode: it can create groups and invite other clients, but it cannot itself be invited into a group. Touches client construction/options typing, the key package manager (publish path must be disabled rather than throwing at an awkward point), and whatever surface reports the client's capabilities so downstream apps can tell the two modes apart.
**Requirements:** TBD
**Plans:** 0 plans

Plans:

- [ ] TBD (promote with /gsd-review-backlog when ready)
