# Shelved: Blocker & Security Closure (was Phase 2 of milestone v1.0)

**Shelved:** 2026-07-21 — moved to backlog when milestone v1.0 was reset in favor of a different milestone.
**Original position:** Phase 2 of 4 (dark-matter single-device wire-complete).
**Depends on:** 999.3 (Exhaustive Gap Audit).
**Requirements:** MEDIA-01, MEDIA-02, CONV-01, CONV-02, SEC-01, SEC-02, API-01

## Goal

Every confirmed single-device blocker and security hardening gap is closed — media decrypts across
epochs, convergence is correctly gated and arrival-order-free, messages are authenticated before
decryption, and public API classifiers match the actual wire format.

## Success Criteria

1. Media sent at epoch N decrypts correctly after the group has advanced to epoch N+2 (cross-epoch
   test sends media, advances state twice via commits, then decrypts and plaintext matches).
2. An inbound commit that arrives during PendingPublish is returned as `deferred`, not applied; the
   canonical tip does not advance until the local commit is acknowledged.
3. Two peers that receive the same competing commits in opposite relay-delivery order select the same
   canonical branch (dual-ordering test with two in-memory instances).
4. A kind-445 event with an invalid Nostr event signature is routed to `invalid_signature` disposition
   before any ChaCha20-Poly1305 decryption is attempted.
5. A Welcome not addressed to the local account pubkey is rejected before `joinGroup()` is called;
   `isCommitMessage` and `isProposalMessage` return `true` for real PublicMessage engine output.

## To resume

`/gsd-review-backlog` to promote back into an active milestone, or `/gsd-discuss-phase 999.4`.
