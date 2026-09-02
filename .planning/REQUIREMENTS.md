# Requirements: marmot-ts — v1.0 catchup (resync to marmot spec + MDK Rust)

**Defined:** 2026-07-21
**Core Value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte, with any spec-conformant peer (incl. the Rust MDK reference), across every supported runtime.

Grounded in the catchup review — see `.planning/research/SUMMARY.md` (+ PROOF-V2 / SPEC-DELTAS / MDK-INTEROP). Upstream: `refs/marmot` (spec, post-split) and `refs/mdk` (`marmotkit-v0.9.4`). Per project constraint, the Rust reference is authoritative for wire format where it is ahead of spec.

## v1 Requirements

Requirements for catching marmot-ts up to feature parity + byte-for-byte interop with the current MDK Rust reference. Interop-breakers close first. Each maps to roadmap phases.

### Proof (account-identity-proof v2)

- [x] **PROOF-01**: account-identity-proof migrates v1→v2 — version byte `2`, and the 64-byte Schnorr signature signs the canonical Nostr **kind-450 event id** (not the old SHA-256 domain preimage); marmot-ts produces and verifies v2 byte-for-byte with MDK, and per-ciphersuite signature-scheme tag values match the Rust `signature_algorithm() as u16` decimals (interop-breaking; `src/core/account-identity-proof.ts`, mdk #755)

### Security / inbound trust

- [x] **SEC-01**: The inbound Nostr path verifies event id + Schnorr signature at the boundary BEFORE trusting `h`/`p` routing tags or attempting decryption; unverifiable events are rejected, not processed (interop-breaking/security; `groups-manager.ts` → `nostr-peeler.ts` → `group-message-crypto.ts`; `transports/nostr.md` #236, mdk #727)

### Wire / codec conformance

- [x] **WIRE-01**: Published KeyPackages cap the MLS Lifetime to the 84-day maximum (≤ 7,261,200 s), and inbound KeyPackages with an over-long or expired Lifetime are rejected (interop-breaking; `src/utils/timestamp.ts`, `key-package-event-decode.ts`, `key-package-eligibility.ts`; `foundation/key-packages.md` #236)
- [x] **WIRE-02**: Required-tag cardinality is enforced — events with repeated, empty, or duplicate required tags are rejected (445 `h`; 1059 `p`; 444 `e`/`relays`; 30443 `d`/`i`/`mls_protocol_version`) (interop-breaking; `src/utils/nostr.ts`, `key-package-event-decode.ts`, `welcome-event.ts`; `transports/nostr.md` #236)
- [x] **WIRE-03**: App-component integrity is validated on staged commits — a commit that drops the `app_data_dictionary`, drops a required component, or rewrites a required component's bytes outside a validated `AppDataUpdate` is rejected pre-merge (interop-breaking; `src/engine/ingest.ts` + send + convergence; mdk cgka-engine #704)
- [ ] **WIRE-04**: SafeAAD component (`0x0002`) is defined, `0x0001` is advertised in the leaf `app_components` list, and the empty safe_aad entry is emitted, so LeafNode/KeyPackage bytes match the reference (additive; `src/core/components/ids.ts`, `dictionary.ts`; mdk `b9ae3ce`)

### Convergence / membership parity

- [x] **CONV-01**: Admin/leaf coupling is enforced as a resulting-epoch invariant — every membership-changing commit is validated (send + inbound) so that admins ⊆ member leaves, matching MDK's legality decision for removal-without-policy-update commits (additive/convergence; `src/core/components/admin-policy.ts`, `src/engine/admin-policy.ts`; `admin-policy-v1.md`+`convergence.md` #171, mdk #701)
- [ ] **CONV-02**: SelfEvicted / Realizing removal is handled — on being removed, marmot-ts emits a self-removed notification, marks the group removed-inactive, and classifies later input as SelfEvicted/stale (additive; new; `member-departure.md` #171)
- [ ] **CONV-03**: Group-state-change notifications are attributed to their `commit_digest` and withdrawn when that commit is superseded on rewind, including clearing removal markers (additive; `src/engine/` convergence, cf. `delivered-payloads.ts`; `convergence.md` #171, mdk #724)
- [x] **CONV-04**: Own-confirmed-commit convergence protection is verified against MDK scenario vectors — a device's own published+confirmed commit is never rolled back for a same-epoch sibling; fixes are added only if marmot-ts diverges (verify-first; `src/engine/fork-recovery.ts`, `tree-convergence.ts`; mdk #706/#723/#702, #724)

### Conformance vectors

- [ ] **CONF-01**: MDK reference vectors are wired up as cross-impl tests — `nostr-routing-v1` byte-fixtures against `src/core/components/nostr-routing.ts` (incl. duplicate-relay reject), the convergence/admin-policy/fork-recovery scenario vectors as a parity harness, and a proof-v2 Rust-signed→TS-verified round-trip fixture

### Quality gate

- [ ] **QA-01**: Full test suite green across all supported runtimes (Node 20/22/24, Deno 2, Bun latest/1.1) at milestone end
- [ ] **QA-02**: Every catch-up change with a byte-exact MDK counterpart is cross-checked against the Rust reference output and the result recorded

## v2 Requirements

Deferred to future milestones. Cataloged by the review but not built now.

### Multi-device (MIP-06)

- **MDEV-01**: extension 0xf2f0, External-Commit carve-out, join-PSK exporter, pairing payload — deferred; orthogonal to single-device interop

### Push notifications (MIP-05)

- **PUSH-01**: owner-authenticated push-token gossip (BIP-340 sigs, tombstones, LWW ordering) per spec #725 — deferred

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature                                                                                                               | Reason                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Multi-device (MIP-06) / push (MIP-05) implementation                                                                  | Deferred to v2; orthogonal to single-device wire interop                  |
| QUIC data-plane / agent-stream runtime (broker, transport-quic-*)                                                     | Experimental; durable policy codec exists, data plane deliberately absent |
| App / tooling crates (marmot-app, cli, marmot-uniffi, marmot-forensics, incident-replay, fs-private, openclaw/hermes) | Not library scope                                                         |
| encrypted-media / Blossom image changes (mdk #852)                                                                    | Media wire format already shipped; catalogued, not in this milestone      |
| App-message NIP-40 expiry semantics                                                                                   | Cataloged as deferred by the review                                       |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase                                           | Status   |
| ----------- | ----------------------------------------------- | -------- |
| PROOF-01    | Phase 1 — Proof v2                              | Complete |
| SEC-01      | Phase 2 — Inbound Trust & Wire Boundary         | Complete |
| WIRE-01     | Phase 2 — Inbound Trust & Wire Boundary         | Complete |
| WIRE-02     | Phase 2 — Inbound Trust & Wire Boundary         | Complete |
| WIRE-03     | Phase 3 — Commit Integrity & Convergence Parity | Complete |
| CONV-01     | Phase 3 — Commit Integrity & Convergence Parity | Complete |
| CONV-02     | Phase 3 — Commit Integrity & Convergence Parity | Gaps Found |
| CONV-03     | Phase 3 — Commit Integrity & Convergence Parity | Gaps Found |
| CONV-04     | Phase 3 — Commit Integrity & Convergence Parity | Complete |
| WIRE-04     | Phase 4 — Feature Parity & Conformance Vectors  | Pending  |
| CONF-01     | Phase 4 — Feature Parity & Conformance Vectors  | Pending  |
| QA-01       | Phase 5 — Quality Gate                          | Pending  |
| QA-02       | Phase 5 — Quality Gate                          | Pending  |

**Coverage:**

- v1 requirements: 13 total (PROOF-01, SEC-01, WIRE-01..04, CONV-01..04, CONF-01, QA-01, QA-02 — corrected from the earlier "12 total" placeholder, which undercounted by one)
- Mapped to phases: 13/13
- Unmapped: 0

---

_Requirements defined: 2026-07-21_
_Last updated: 2026-07-21 after roadmap creation (traceability filled, coverage corrected to 13/13)_
