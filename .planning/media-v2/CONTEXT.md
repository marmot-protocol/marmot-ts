# Media v2 implementation context

Date: 2026-10-22. Branch: v0.8. Baseline: 967473d9.
Status: implementation authorized and completed on feat/media-v2; see IMPLEMENTATION.md for evidence.

## Accepted user decision

For v0.8, unversioned media APIs default to encrypted-media-v2. Explicitly
versioned v1 helpers remain available for historical references and data.
The user accepted this recommendation with “lets go with your recomendation”.

The user subsequently authorized implementation. The v2 implementation follows
this migration direction; no package release or Android deployment is authorized
or performed.

## Scope and release contract

- Implement complete v2 policy, membership, metadata, crypto, source-state
  handling, client transfer and existing example integration.
- Core stays free of I/O; blob and Nostr work belongs in client/adapters.
- Preserve the exact v1 format and its historical data. Do not reinterpret
  0x8008 or v1 ciphertext as v2, and do not reopen unsupported legacy groups.
- V2 is 0x800b and encrypted-media-v2. Fresh current-profile sends use v2 only.
- Existing media creation defaults switch intentionally and require breaking
  change notes and an explicit migration guide for users of the old APIs.
- Media configuration is explicit. Supporting 0x800b does not require every
  plain chat group to enable media or contact a default third-party server.
- Upgrade KeyPackage publications to advertise completed v2 support while
  retaining private material still needed for pending Welcomes.
- Preserve captions and valid sibling attachments when one attachment fails.
- Existing attachment send/receive UI in OpenTUI should work with v2; do not
  expand into a UI redesign, transcoding, resumable uploads or new blob backends.
- Group profile-image crypto is separate and is not migrated to this format.

## Public API direction

Unversioned attachment types, version constants, policy accessors, crypto helpers
and imeta helpers represent v2 after the migration. Add explicit V1 types and
historical parser/decryption entrypoints where existing generic names carried v1.
Retain already-versioned V1 exports with their original semantics.

Give component IDs explicit V1 and V2 names. If an existing unversioned alias
becomes the V2 default, call out that source-level breaking change and show the
V1 replacement for historical consumers. Wire IDs and persisted values never
change meaning.

History readers may dispatch on one validated, explicit version discriminator
and return a discriminated union. A failed v2 parse/decrypt must not trigger a
speculative v1 fallback. High-level current-profile sending must not select v1.
Versioned low-level helpers are not a bypass for that send contract.

Exact new symbol names should follow the existing exports, with public-export
type tests. Do not silently widen the v2 crypto API to accept arbitrary versions.

## Source-state and availability contract

Prepared ciphertext is bound to the MLS state that supplied its media exporter.
It may be sent only under that state. Check the binding at the serialized send
boundary, including after queued work resumes. A same-epoch branch change also
invalidates preparation. A stale preparation returns a typed retry outcome;
retrying encryption samples a fresh nonce.

Receive-side decryption selects the authenticated message's source identity and
bounded retained media secret. Missing secret material is an attachment
availability outcome. Full private MLS states must not be retained without a
bound merely to preserve media access. Reuse the existing retention authority
and terminal cleanup boundaries.

## Evidence required for completion

Actual MDK media-enabled group joins, media-bearing application messages and
blob decryption must pass in both directions on latest MDK, stable v0.13.0 and
White Noise Android's pinned MDK. Welcome-only or locally mirrored capability
tests are insufficient. State the exact tested pins; Android UI and live-relay
verification remain separate evidence.

See RESEARCH.md for source paths, wire rules, current defects and scope limits.
