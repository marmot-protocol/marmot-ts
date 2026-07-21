# Shelved: Wire / Conformance & Docs (was Phase 3 of milestone v1.0)

**Shelved:** 2026-07-21 — moved to backlog when milestone v1.0 was reset in favor of a different milestone.
**Original position:** Phase 3 of 4 (dark-matter single-device wire-complete).
**Depends on:** 999.4 (Blocker & Security Closure).
**Requirements:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, CONF-01, DOC-01

## Goal

All remaining wire-format, codec-correctness, and API conformance gaps confirmed by the audit are
closed, and unsupported protocol features are formally documented.

## Success Criteria

1. A QUIC VarInt with a non-canonical (over-long) length prefix is rejected with an encoding error,
   not silently parsed (test encodes an over-long VarInt and verifies the decoder throws).
2. A kind-30443 KeyPackage event with duplicate required tag names is rejected by the decoder (test:
   event with two `mls_extensions` tags yields rejection).
3. blossom-image (0x8002) is documented as unsupported in source and docs, with a comment pointing to
   avatar-url (0x8007) as the supported alternative.
4. WIRE-03 (NIP-40 expiration) and WIRE-04 (routing-rotation subscription) are either closed with a
   test verifying correct behavior or explicitly recorded as not-applicable per audit findings.
5. URL-normalization vectors for avatar-url (0x8007) and encrypted-media (0x8008) pass for exotic
   percent-encoding, IDNA/punycode round-trips, default-port elision, and trailing-slash serialization
   (CONF-01).

## To resume

`/gsd-review-backlog` to promote back into an active milestone, or `/gsd-discuss-phase 999.5`.
