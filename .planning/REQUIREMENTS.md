# Requirements: marmot-ts (dark-matter → single-device wire-complete)

**Defined:** 2026-07-01
**Core Value:** A downstream client can join a Marmot group and exchange messages that interoperate, byte-for-byte, with any spec-conformant peer (incl. the Rust darkmatter reference), across every supported runtime.

## v1 Requirements

Requirements for finishing the dark-matter migration to single-device wire-complete. Each maps to roadmap phases. The Phase 1 audit is authoritative — it may confirm, split, or retire the AUDIT-flagged closure items below.

### Audit

- [ ] **AUDIT-01**: Exhaustive gap audit of the TS implementation vs the latest darkmatter spec + Rust reference, walking every spec area (foundation, protocol-core, app-components, transports, features) in dependency order
- [ ] **AUDIT-02**: Rewritten, verified `SPEC_GAP_REVIEW.md` that supersedes the stale 2026-06-19 snapshot and serves as the closure backlog (each gap named to file + governing spec section)
- [ ] **AUDIT-03**: Every audit finding classified (BLOCKER / MAJOR / MINOR / deferred) with confirmed present-or-absent status in code

### Media (source-epoch secrets)

- [ ] **MEDIA-01**: Engine exposes retained per-epoch exporter secrets (a `getRetainedStates()`/epoch→exporterSecret accessor) to the media service
- [ ] **MEDIA-02**: `GroupMediaService` decrypts media using the source-epoch secret, so media from an epoch older than the local tip decrypts correctly (closes M9)

### Convergence / retention

- [ ] **CONV-01**: Inbound apply is gated by `mayApplyRetainedInbound()` during `PendingPublish` so an inbound commit cannot advance canonical state under a staged local commit
- [ ] **CONV-02**: Convergence fork-choice comparator is verified free of transport-order leakage (canonical ordering only)

### Wire / codec conformance

- [ ] **WIRE-01**: QUIC VarInt (Marmot binary profile) decoders reject non-shortest-prefix (non-canonical) encodings across all component codecs
- [ ] **WIRE-02**: kind-30443 KeyPackage events enforce exactly-one required tag per spec
- [ ] **WIRE-03**: NIP-40 expiration tag emitted where the spec requires it (pending audit confirmation in the runtime)
- [ ] **WIRE-04**: Routing-rotation subscription to prior `nostr_group_id`s within the app-payload window (pending audit confirmation of the subscription model)

### Security / validation order

- [ ] **SEC-01**: kind-445 group-message path verifies the Nostr event id/signature BEFORE decrypting (sig-before-decrypt); failures routed to `unreadable` (closes m9)
- [ ] **SEC-02**: Welcome processing explicitly binds the recipient — rejects a welcome not addressed to this account identity, and validates the welcome author is an active admin (closes m8)

### Public API correctness

- [ ] **API-01**: `isCommitMessage` / `isProposalMessage` classify real engine output correctly (guard on the `mls_public_message` wireformat the engine actually emits)

### Conformance vectors

- [ ] **CONF-01**: URL-normalization parity vectors (avatar-url 0x8007 / encrypted-media 0x8008) covering exotic percent-encoding / IDNA, round-tripping against the Rust reference (closes m7)

### Documentation

- [ ] **DOC-01**: blossom-image (0x8002) formally documented as unsupported (Rust-parity: point groups at avatar-url 0x8007), including the "group requires 0x8002 → unjoinable" consequence (closes m3)

### Quality gate

- [ ] **QA-01**: Full test suite green across all supported runtimes (Node 20/22/24, Deno 2, Bun latest/1.1) at milestone end
- [ ] **QA-02**: Wire-interop coverage — closure changes are checked against the Rust darkmatter reference output where a byte-exact vector exists

## v2 Requirements

Deferred to future milestones. Cataloged by the audit but not built now.

### Multi-device (MIP-06)

- **MDEV-01**: extension 0xf2f0, External-Commit carve-out, join-PSK exporter, pairing payload — *spec bytes are currently non-normative ("MUST NOT implement for interop yet"); revisit when finalized*

### Push notifications (MIP-05)

- **PUSH-01**: owner-authenticated push-token gossip (BIP-340 sigs, tombstones, LWW ordering) per the post-June spec rewrite (#725)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| blossom-image (0x8002) codec implementation | Rust reference omits it and routes to avatar-url 0x8007; documenting unsupported instead (DOC-01) |
| QUIC transport runtime / broker (agent text streams) | Experimental live-preview-only; 0x8006 durable policy codec already done, data plane deliberately absent |
| App / tooling crates (marmot-app, cli, marmot-markdown, forensics, uniffi, concrete storage backends) | Not library scope |
| Multi-device / push implementation | Deferred to v2 (see above); orthogonal to single-device wire interop |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUDIT-01 | — | Pending |
| AUDIT-02 | — | Pending |
| AUDIT-03 | — | Pending |
| MEDIA-01 | — | Pending |
| MEDIA-02 | — | Pending |
| CONV-01 | — | Pending |
| CONV-02 | — | Pending |
| WIRE-01 | — | Pending |
| WIRE-02 | — | Pending |
| WIRE-03 | — | Pending |
| WIRE-04 | — | Pending |
| SEC-01 | — | Pending |
| SEC-02 | — | Pending |
| API-01 | — | Pending |
| CONF-01 | — | Pending |
| DOC-01 | — | Pending |
| QA-01 | — | Pending |
| QA-02 | — | Pending |

**Coverage:**
- v1 requirements: 18 total
- Mapped to phases: 0 (roadmap pending)
- Unmapped: 18 ⚠️

---
*Requirements defined: 2026-07-01*
*Last updated: 2026-07-01 after initial definition*
