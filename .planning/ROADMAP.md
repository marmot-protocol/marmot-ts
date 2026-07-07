# Roadmap: marmot-ts — dark-matter single-device wire-complete

## Overview

The library has completed its darkmatter migration baseline (B1–B7, M1–M8, encrypted-media wire
format). The darkmatter spec submodule has since advanced 59 commits and the June 2026 gap-analysis
document is stale. This milestone runs a fresh exhaustive audit of the TypeScript implementation
against the latest spec and Rust reference (Phase 1), then closes every confirmed single-device gap
in severity order — blockers and security first, wire-format conformance second — before verifying
the result against a green cross-runtime test suite (Phase 4). Multi-device (MIP-06) and push
(MIP-05) are cataloged during the audit and explicitly deferred.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Exhaustive Gap Audit** - Rewrite SPEC_GAP_REVIEW.md as a verified, classified closure backlog
- [ ] **Phase 2: Blocker & Security Closure** - Close every confirmed single-device blocker and security hardening gap
- [ ] **Phase 3: Wire / Conformance & Docs** - Close remaining wire-format, codec, and API conformance gaps; document unsupported features
- [ ] **Phase 4: Quality Gate** - Green suite on all runtimes; byte-exact Rust reference verification

## Phase Details

### Phase 1: Exhaustive Gap Audit
**Goal**: A rewritten, verified SPEC_GAP_REVIEW.md supersedes the stale June 2026 snapshot and becomes the authoritative closure backlog for Phase 2 and 3
**Depends on**: Nothing (first phase)
**Requirements**: AUDIT-01, AUDIT-02, AUDIT-03
**Success Criteria** (what must be TRUE):
  1. SPEC_GAP_REVIEW.md is rewritten with every confirmed gap pointing to source file:line and governing spec section (audit covers all seven spec areas in dependency order)
  2. Every finding carries a confirmed present-or-absent verdict in code plus a classification: BLOCKER / MAJOR / MINOR / deferred
  3. All seven candidate likely gaps (NIP-40 expiration, routing-rotation subscription, QUIC VarInt canonicality, convergence apply-gating, `isCommitMessage` wireformat, kind-30443 tag validation, kind-1210 attribution) are either confirmed with evidence or closed with code evidence
  4. Multi-device (MIP-06), push (MIP-05), and QUIC data-plane surface is cataloged in the document with explicit deferred disposition and the reason
**Plans**: TBD

### Phase 2: Blocker & Security Closure
**Goal**: Every confirmed single-device blocker and security hardening gap is closed — media decrypts across epochs, convergence is correctly gated and arrival-order-free, messages are authenticated before decryption, and public API classifiers match the actual wire format
**Depends on**: Phase 1
**Requirements**: MEDIA-01, MEDIA-02, CONV-01, CONV-02, SEC-01, SEC-02, API-01
**Success Criteria** (what must be TRUE):
  1. Media sent at epoch N decrypts correctly after the group has advanced to epoch N+2 (a cross-epoch test sends media, advances state twice via commits, then decrypts and the plaintext matches)
  2. An inbound commit that arrives during PendingPublish is returned as `deferred`, not applied; the canonical tip does not advance until the local commit is acknowledged
  3. Two peers that receive the same competing commits in opposite relay-delivery order select the same canonical branch (dual-ordering test with two in-memory instances)
  4. A kind-445 event with an invalid Nostr event signature is routed to `invalid_signature` disposition before any ChaCha20-Poly1305 decryption is attempted
  5. A Welcome not addressed to the local account pubkey is rejected before `joinGroup()` is called; `isCommitMessage` and `isProposalMessage` return `true` for real PublicMessage engine output
**Plans**: TBD

### Phase 3: Wire / Conformance & Docs
**Goal**: All remaining wire-format, codec-correctness, and API conformance gaps confirmed by Phase 1 are closed, and unsupported protocol features are formally documented
**Depends on**: Phase 2
**Requirements**: WIRE-01, WIRE-02, WIRE-03, WIRE-04, CONF-01, DOC-01
**Success Criteria** (what must be TRUE):
  1. A QUIC VarInt with a non-canonical (over-long) length prefix is rejected with an encoding error, not silently parsed (a test encodes an over-long VarInt and verifies the decoder throws)
  2. A kind-30443 KeyPackage event with duplicate required tag names is rejected by the decoder (test: event with two `mls_extensions` tags yields rejection)
  3. blossom-image (0x8002) is documented as unsupported in source and docs, with a comment pointing to avatar-url (0x8007) as the supported alternative
  4. WIRE-03 (NIP-40 expiration) and WIRE-04 (routing-rotation subscription) are either closed with a test verifying correct behavior or explicitly recorded as not-applicable per Phase 1 findings
  5. URL-normalization vectors for avatar-url (0x8007) and encrypted-media (0x8008) pass for exotic percent-encoding, IDNA/punycode round-trips, default-port elision, and trailing-slash serialization (CONF-01)
**Plans**: TBD

### Phase 4: Quality Gate
**Goal**: The full test suite passes on every supported runtime and every closure change with a byte-exact Rust reference vector is verified against it — the milestone is shippable
**Depends on**: Phase 3
**Requirements**: QA-01, QA-02
**Success Criteria** (what must be TRUE):
  1. `pnpm vitest run` exits 0 on Node 20, Node 22, and Node 24
  2. `deno run -A --node-modules-dir=auto npm:vitest run` exits 0 on Deno 2
  3. `bun run vitest run` exits 0 on Bun latest and Bun 1.1
  4. Every closure change that has a byte-exact counterpart in `darkmatter/crates/` is cross-checked against the Rust reference output and the result documented in SPEC_GAP_REVIEW.md
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Exhaustive Gap Audit | 0/TBD | Not started | - |
| 2. Blocker & Security Closure | 0/TBD | Not started | - |
| 3. Wire / Conformance & Docs | 0/TBD | Not started | - |
| 4. Quality Gate | 0/TBD | Not started | - |

## Backlog

### Phase 999.1: Group image support — check and add so downstream apps can show and update the group image (BACKLOG)

**Goal:** [Captured for future planning] — verify group image (avatar) support end-to-end so downstream apps can read/display and update a group's image. Likely touches the group image/avatar-url (0x8007) extension and the group metadata surface.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)

### Phase 999.2: Documentation review & update for current library state ahead of next release (BACKLOG)

**Goal:** [Captured for future planning] — review and update the docs (VitePress `docs/` + TypeDoc reference) to match the current state of the library in preparation for the next release.
**Requirements:** TBD
**Plans:** 0 plans

Plans:
- [ ] TBD (promote with /gsd-review-backlog when ready)
