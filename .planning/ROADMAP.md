# Roadmap: marmot-ts — v1.0 catchup (resync to marmot spec + MDK Rust reference)

## Overview

The darkmatter repo split into `refs/marmot` (spec) and `refs/mdk` (Rust reference, now at
`marmotkit-v0.9.4`, far ahead of the `v0.2.0`-era baseline marmot-ts was last audited against).
The catchup review (`.planning/research/SUMMARY.md` + PROOF-V2/SPEC-DELTAS/MDK-INTEROP) found
5 interop-breaking gaps, 4 additive convergence/feature gaps, and 2 parity items needing a
targeted verify. This milestone closes them in strict severity order: Proof v2 first (the
headline known breaker, isolated because it touches identity/credential machinery), then the
inbound-trust and wire-boundary tightening, then commit-integrity and convergence parity, then
remaining feature parity plus wiring up MDK's own conformance vectors, and finally a green
cross-runtime quality gate. Multi-device (MIP-06), push (MIP-05), the QUIC data-plane, and
app/tooling crates are cataloged by the review but explicitly deferred.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Proof v2** - Migrate account-identity-proof v1→v2 to close the headline interop-breaker (completed 2026-07-21)
- [x] **Phase 2: Inbound Trust & Wire Boundary** - Verify-before-trust, KeyPackage lifetime cap, required-tag cardinality (completed 2026-07-22)
- [ ] **Phase 3: Commit Integrity & Convergence Parity** - App-component integrity, admin/leaf coupling, SelfEvicted, notification withdrawal, own-commit protection
- [ ] **Phase 4: Feature Parity & Conformance Vectors** - SafeAAD advertisement plus MDK's own test vectors wired up as cross-impl tests
- [ ] **Phase 5: Quality Gate** - Green suite on every supported runtime; byte-exact MDK cross-checks recorded

## Phase Details

### Phase 1: Proof v2

**Goal**: marmot-ts implements account-identity-proof v2 (version byte `2`, signing the
canonical Nostr kind-450 event id instead of the old SHA-256 domain preimage) so it
interoperates byte-for-byte with the MDK Rust reference — the headline interop-breaker closed
in isolation before any other wire-boundary work begins.
**Depends on**: Nothing (first phase)
**Requirements**: PROOF-01
**Success Criteria** (what must be TRUE):

1. marmot-ts emits and accepts only version byte `2` account-identity-proofs; a v1-only proof (version byte `1`) is now rejected.
2. A v2 proof produced by marmot-ts is accepted by MDK-equivalent verification logic, proven via a Rust-signed → TS-verified round-trip fixture (no shared byte fixture exists yet, so this is generated fresh).
3. Per-ciphersuite `signature_scheme` decimal tag values emitted by marmot-ts match the Rust `signature_algorithm() as u16` decimal for every supported ciphersuite.
4. The unpublished kind-450 proof event carries its six tags (`d`, `extension`, `version`, `ciphersuite`, `signature_scheme`, `mls_signature_key`) in the exact Rust order/format and is never published/relayed.
   **Plans**: 2/2 plans complete

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Migrate core account-identity-proof v1→v2 (version byte 2, kind-450 event-id signing digest, external-signer parity builders, signature_scheme parity, colocated v2 tests)

**Wave 2** _(blocked on Wave 1 completion)_

- [x] 01-02-PLAN.md — Thread widened signer contract through client, sweep proof-touching tests to v2, and pin a fresh Rust-signed → TS-verified round-trip fixture + never-published assertion

### Phase 2: Inbound Trust & Wire Boundary

**Goal**: The inbound Nostr path only trusts events after verifying their id and signature,
and published/consumed KeyPackages plus required tags conform to the tightened #236 wire
boundary — a conformant peer no longer silently accepts malformed input or forges trust in
unverified fields.
**Depends on**: Phase 1
**Requirements**: SEC-01, WIRE-01, WIRE-02
**Success Criteria** (what must be TRUE):

1. An inbound event with an invalid Nostr event id or Schnorr signature is rejected before any `h`/`p` routing tag is trusted or any decryption is attempted.
2. Published KeyPackages cap their MLS Lifetime at ≤ 7,261,200 s (84 days); an inbound KeyPackage with an over-long or expired Lifetime is rejected rather than accepted for eligibility.
3. An event with a repeated, empty, or duplicate required tag (445 `h`; 1059 `p`; 444 `e`/`relays`; 30443 `d`/`i`/`mls_protocol_version`) is rejected, not silently resolved by taking the first match.
   **Plans**: 4/4 plans complete

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Shared trust-boundary primitives: RejectReason taxonomy + injectable verifier defaults (verify.ts), table-driven #236 tag-cardinality validator + strict getters (tag-cardinality.ts), and produce-side KeyPackage lifetime cap/backdate/rename + cap/grace helpers (timestamp.ts)

**Wave 2** _(depends on Wave 1)_

- [x] 02-02-PLAN.md — Inject the pluggable VerifyEventMethod through MarmotClient; gate the 445 drain and 1059 ingest on verify-before-trust with typed `rejected` emits; migrate 444 `e`/`relays` reads to the strict getters

**Wave 3** _(depends on Wave 2)_

- [x] 02-03-PLAN.md — Close the 30443 KeyPackage boundary on both consumption paths (track()/addPublished and createInviteIntent): outer-event verify, `d`/`i`/`mls_protocol_version` cardinality, and inbound Lifetime cap/current rejection, plus the eligibility Lifetime reason

**Gap closure** _(from 02-VERIFICATION.md)_

- [x] 02-04-PLAN.md — Close the three verified defects: enforce 1059 `p`-tag cardinality in InviteManager.ingestEvent (GAP 1/WIRE-02), reorder the 445 #connectGroup drain so only verified events occupy the dedup slot — fixing the WR-01 same-id forgery censorship (GAP 2/SEC-01), and make createWelcomeRumor reject duplicate relay URLs to match its own strict consumer (GAP 3/WIRE-02)

### Phase 3: Commit Integrity & Convergence Parity

**Goal**: Staged commits and membership/convergence handling match MDK's legality and rewind
semantics so the two implementations never silently fork on a component-mutating or
membership-changing commit.
**Depends on**: Phase 2
**Requirements**: WIRE-03, CONV-01, CONV-02, CONV-03, CONV-04
**Success Criteria** (what must be TRUE):

1. A staged commit that drops the `app_data_dictionary`, drops a required component, or rewrites a required component's bytes outside a validated `AppDataUpdate` is rejected pre-merge, identically on the send, inbound, and convergence/replay paths.
2. Every membership-changing commit results in admin ⊆ member-leaves in the resulting epoch; a removal-without-policy-update commit that MDK deems illegal is rejected identically by marmot-ts.
3. On being removed from a group, marmot-ts emits a self-removed notification, marks the group removed-inactive with no further outbound, and classifies subsequent input for that group as SelfEvicted/stale.
4. Group-state-change notifications are attributed to their originating `commit_digest` and are withdrawn — including clearing removal markers — when that commit is superseded on rewind.
5. Run against MDK's own-confirmed-commit scenario vectors (#706/#723/#702/#724): a device's own published+confirmed commit is never rolled back in favor of a same-epoch sibling; a clean pass requires no code change, and any divergence found is fixed before this phase closes (verify-first).
   **Plans**: 5/7 plans executed

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Pure core validators: app-component integrity (MDK attribution rule), admin/leaf coupling (resulting-epoch invariant), and the shared `validateCommitLegality` seam adapter
- [x] 03-02-PLAN.md — Inbound result vocabulary widening (rejection `reason`, `self-evicted` skip, `SelfEvicted` outcome, `stateInvalidated`) plus the `StateNotification` model and its bounded commit-digest ledger
- [x] 03-03-PLAN.md — CONV-04 verify-first: native Vitest tests for own-confirmed-commit protection and dual-ordering determinism, with conditional minimal remediation

**Wave 2** _(depends on Wave 1)_

- [x] 03-04-PLAN.md — Receive-side seams: proposal-capture side channel, inbound commit rejection gate, and dropped candidate edges in fork recovery
- [x] 03-05-PLAN.md — Engine-side seams: admin-policy auto-coupling + `AdminDepletionError` on send, the pre-wrap legality throw, and winner-chain validation on tree-fed re-convergence

**Wave 3** _(depends on Wave 2)_

- [ ] 03-06-PLAN.md — CONV-02: `SelfEvicted` classification before peel, engine-level outbound block, persisted removed-inactive marker with load-time realization, plus the folded `rejectedEvents` DoS todo

**Wave 4** _(depends on Wave 3)_

- [ ] 03-07-PLAN.md — CONV-03: commit-digest-attributed state notifications, rewind-scoped withdrawal via the ledger, and removal-marker clearing on supersession

### Phase 4: Feature Parity & Conformance Vectors

**Goal**: marmot-ts's LeafNode/KeyPackage bytes match the reference's SafeAAD advertisement,
and MDK's own conformance-simulator test vectors run as automated cross-impl checks rather
than manual spot-checks.
**Depends on**: Phase 3
**Requirements**: WIRE-04, CONF-01
**Success Criteria** (what must be TRUE):

1. Leaf/KeyPackage `app_components` advertise `0x0001` and an empty SafeAAD (`0x0002`) entry, matching MDK's leaf dictionary byte-for-byte; safe_aad is still rejected as group-component state.
2. The `nostr-routing-v1-*` byte fixtures (`valid-state`, `valid-update`, `invalid-duplicate-relay`) pass as automated tests against `src/core/components/nostr-routing.ts` encode/decode, including the duplicate-relay reject case.
3. The convergence/admin-policy/fork-recovery scenario vectors (`convergence-committer-selected`, `convergence-witness-selected`, `admin-policy-update`, `group-data-update`, `group-data-fork-recovery`, `concurrent-invite-fork-recovery`, and related manifest entries) run as an automated parity harness against `src/engine/fork-recovery.ts` and related convergence code.
4. The Phase 1 proof-v2 Rust-signed → TS-verified round-trip is wired up as a permanent, repeatable automated test rather than a one-off manual check.
   **Plans**: TBD

### Phase 5: Quality Gate

**Goal**: The full test suite is green on every supported runtime, and every catch-up change
with a byte-exact MDK counterpart has been cross-checked against the Rust reference output —
the milestone is shippable.
**Depends on**: Phase 4
**Requirements**: QA-01, QA-02
**Success Criteria** (what must be TRUE):

1. `pnpm vitest run` exits 0 on Node 20, Node 22, and Node 24.
2. `deno run -A --node-modules-dir=auto npm:vitest run` exits 0 on Deno 2.
3. `bun run vitest run` exits 0 on Bun latest and Bun 1.1.
4. Every catch-up change with a byte-exact MDK counterpart (proof v2, KeyPackage lifetime, tag cardinality, SafeAAD dictionary bytes) has been cross-checked against the Rust reference output and the result recorded.
   **Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase                                    | Plans Complete | Status      | Completed  |
| ---------------------------------------- | -------------- | ----------- | ---------- |
| 1. Proof v2                              | 2/2            | Complete    | 2026-07-21 |
| 2. Inbound Trust & Wire Boundary         | 4/4            | Complete    | 2026-07-22 |
| 3. Commit Integrity & Convergence Parity | 5/7 | In Progress|  |
| 4. Feature Parity & Conformance Vectors  | 0/TBD          | Not started | -          |
| 5. Quality Gate                          | 0/TBD          | Not started | -          |

## Backlog

### Phase 999.1: Group image support — check and add so downstream apps can show and update the group image (BACKLOG)

**Goal:** [Captured for future planning] — verify group image (avatar) support end-to-end so downstream apps can read/display and update a group's image. Likely touches the group image/avatar-url (0x8007) extension and the group metadata surface.
**Requirements:** TBD
**Plans:** 4/4 plans complete

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
