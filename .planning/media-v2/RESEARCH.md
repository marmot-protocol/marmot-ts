# Encrypted media v2: implementation research

Historical pre-implementation research. Implementation is now complete; see
IMPLEMENTATION.md for the delivered behavior, deviations and executed checks.

Status: researched; public API migration direction accepted by the user. This
is focused feature research; see CONTEXT.md and PLAN.md for the implementation
contract. No GSD project/roadmap initialization is implied.
Date: 2026-10-22. Working branch: v0.8.
Starting commit: 967473d9 (MDK Welcome admission and compatibility review).

## Intended outcome

A marmot-ts user can join a current White Noise media-enabled group, exchange
kind-9 messages containing encrypted-media-v2 attachments in both directions,
and fetch/decrypt a delayed attachment using its authenticated source state.
New KeyPackages honestly advertise 0x800b only when that support is complete.
Malformed or unavailable attachments do not suppress captions or valid siblings.

The scope includes policy codecs and validation, attachment types and imeta,
key derivation and encryption, source-epoch handling, client transfer APIs,
existing OpenTUI send/receive integration, documentation and real Rust tests.
New attachment UI, transcoding, streaming/resumable transfer, new locator
backends, and changes to group avatars/profile-image crypto are outside this
initial feature. Existing example attachment UI should use the new APIs.

## Verified references

Both reference repositories were fetched again at the start of this planning
work. Their default branches still match the checked-out revisions; no reference
pointer updates are needed.

- Marmot: d181ce1c4661ca985e8fb12a48a962dbe76fec6c.
- Latest MDK: c2284b314736562bbeb7f2bcb63256a0dd1cc9e0.
- Stable MDK: v0.13.0, 891ab34980ee9dc2ef45bf690733a6e31d3e6778.
- White Noise Android source pin: 8c214fee07466b0b7b63f8dfa39877cce1f63573,
  MarmotKit 0.14.0-nightly.20261021. This does not identify an installed APK.

Normative documents:

- refs/marmot/features/encrypted-media.md
- refs/marmot/app-components/group-encrypted-media-v2.md
- refs/marmot/features/encrypted-media-v1.md (frozen historical format)
- refs/marmot/foundation/canonical-encoding.md, Media type canonicalization
- refs/marmot/implementation-model.md, Network destination safety

Implementation references:

- refs/mdk/crates/traits/src/app_components/encrypted_media_v2.rs
- refs/mdk/crates/marmot-app/src/media/crypto.rs
- refs/mdk/crates/marmot-app/src/media/mod.rs
- refs/mdk/crates/marmot-app/src/media/outgoing.rs
- refs/mdk/crates/marmot-app/src/media/file_transfer.rs
- refs/mdk/crates/marmot-app/src/media/blossom.rs
- refs/mdk/crates/traits/src/engine.rs, SendIntent::AppMessage.expected_epoch

See docs/guide/mdk-compatibility.md for the executed initial compatibility
matrix: six simple/base exchanges pass; all three media profiles fail with
MissingRequiredCapabilities because 0x800b is absent.

## Existing implementation and required changes

| Area | Existing files | Required work |
| --- | --- | --- |
| Policy | src/core/components/encrypted-media.ts, ids.ts, dictionary.ts | Add a distinct 0x800b codec, format constant, dictionary accessors and projection; retain explicit meaning of 0x8008 |
| Membership | src/core/key-package.ts, key-package-event-encode.ts, welcome-join.ts, components/integrity.ts | Advertise v2 only after support exists; strictly validate optional as well as required v2 state at join and every commit seam |
| Media wire/crypto | src/core/media/{types,canonical,imeta,crypto,locator}.ts, src/core/media.ts | Versioned types, exact v2 label/AAD/info, strict received metadata, correct fallback URLs |
| Group creation/update | src/core/group.ts, client groups-manager and group proposals | Explicit v2 media-policy configuration; authorized atomic policy updates/removal; no surprise contact with a hard-coded server |
| Send lifecycle | src/engine/types.ts, group-engine.ts, src/client/session/{group-effects,group-session}.ts | Carry an expected source state through preparation, upload, queuing and final encryption; refuse stale preparation before publication |
| Receive/retention | src/client/group/group-media-service.ts, group-media-store.ts, group-session.ts, history delivery metadata | Associate each attachment with the authenticated message epoch/branch; retrieve bounded retained media secrets; preserve cleanup and tombstone behavior |
| Blob I/O | src/client/group/group-image-transport.ts, examples/opentui/src/marmot/blossom.ts | Reuse transport patterns behind a media-specific client interface; bounded requests, cancellation and ordered fallback |
| Example | examples/opentui/src/marmot/controller.ts, blossom.ts, GroupInfoModal.tsx | Replace v1 policy/send/decrypt assumptions; preserve existing captions, replies and attachment UI |
| Interop | scripts/mdk-interop/{main.rs,run.mjs} | Add actual media-bearing app messages and blob crypto verification; existing Welcome-only passes are insufficient |
| Public surface | src/core/index.ts, client exports, src/__tests__/exports.test.ts, docs and CHANGELOG.md | Document API migration, versioned legacy readers and the exact supported profile |

Dependencies must continue to flow utils -> core -> engine -> client. Core
crypto/parsers must not fetch URLs or publish Nostr events. Reuse Uint8Array and
cross-runtime APIs; do not introduce Buffer into the library.

## Wire and validation contract

- 0x800b means encrypted-media-v2. 0x8008 remains frozen v1 and is never
  reinterpreted, relabelled or repaired by transport tags.
- Policy list order is meaningful. Preserve it. Reject duplicate entries,
  malformed counts/lengths, invalid membership and noncanonical stored bytes.
- V2 policy endpoint URLs are canonical http/https URLs. Structural state
  validity must be independent of whether this machine may contact a host.
- References carry exactly one version, two SHA-256 hashes, one 12-byte nonce,
  canonical MIME type and filename; only locator repeats. Reject blurhash and
  duplicate singleton fields. Preserve valid explicit locator text exactly.
- Filename is 1..255 UTF-8 bytes, no NUL. Reject invalid Unicode instead of
  letting TextEncoder silently replace lone surrogates. No filename trimming,
  Unicode normalization or case folding is permitted.
- MIME canonicalization uses the exact five ASCII whitespace bytes from the
  spec, exactly one slash, HTTP-token segments and byte limits. Producers may
  canonicalize input; receivers must reject stored bytes that differ from the
  canonical result. Current .trim() plus permissive slash checks are inadequate.
- Derive the 32-byte media secret with MLS-Exporter("marmot", "encrypted-media",
  32) at the source epoch. Use it directly as the PRK for HKDF-Expand-SHA256.
  Use exact encrypted-media-v2 separators and labels for info/AAD.
- Sample an independent random 12-byte nonce on every encryption, including
  resends. Verify ciphertext hash, AEAD authentication and plaintext hash.
- Unknown/out-of-policy locator kinds are unavailable, not malformed. Apply
  destination policy at fetch time without altering authenticated validity.
- Invalid reference: skip that attachment. Failed fetch/decrypt: mark that
  attachment unavailable. Keep its caption and all valid sibling attachments.
- Blossom fallback is base_url with all trailing slashes removed, followed by
  '/' and ciphertext hash. Current new URL(hash, baseUrl) loses the last path
  segment for valid endpoints without a trailing slash; cover pathful endpoints.
- In MDK, the requirement that Blossom locator URLs embed the ciphertext hash is
  in the V1 branch of MediaAttachmentReference.validate. Do not accidentally
  impose it on V2; opaque-but-structurally-valid returned URLs are allowed.

## State and cache issues to resolve explicitly

Current GroupMediaService.encryptMedia captures the current state and returns
only ciphertext/reference. The OpenTUI example awaits a network upload and then
sends a normal applicationMessage with no expected epoch. A commit during upload
can put the reference in a different epoch than the one that derived its key.
MDK pins media app messages to expected_epoch; the TypeScript intent has no
matching field. Plan an internal preparation token tied to session.parentToken
or an equivalent exact state identity. Check it at the actual serialized send
boundary and after queued work resumes. Numeric epoch alone cannot distinguish
two branches at the same epoch. A stale preparation must not be published under
a new source state; surface a retry outcome and re-encrypt with a fresh nonce.

Current decryption tries all retained canonical states and deduplicates by epoch.
That is insufficient as the sole source-state model for historical/fork media.
Thread the authenticated message's source identity to the media service and
choose the matching media secret. Reuse existing retention coordinators and
bounded stores; do not retain full private MLS states indefinitely merely to
keep a media file readable. Test restart, pruning and removal/disband cleanup.

Current plaintext cache and in-flight deduplication use ciphertext hash alone.
Validate the complete authenticated reference before returning cached data and
bind cached verification to version/source state/crypto fields. Changed filename,
MIME, plaintext hash or nonce must not gain acceptance because the blob hash was
seen before. Existing stored cache entries need an explicit compatibility rule.

## Recommended implementation sequence

1. Establish versioned v2 primitives and Rust fixtures. Verify policy encoding,
   strict imeta, MIME/filename handling, HKDF info, AAD and blob crypto against
   MDK's pinned implementation. Keep the media capability unadvertised while
   these pieces are incomplete.
2. Deliver one complete vertical slice: configure a v2 group, advertise a fresh
   KeyPackage, join an MDK media group, prepare/upload one file through an
   injected local test transport, send a media-bearing kind-9 message under the
   same source state, and decrypt on Rust. Repeat Rust -> TypeScript. Source
   state guards and minimum receive retention are part of this first slice.
3. Expand production transfer and lifecycle behavior: ordered endpoints,
   cancellation/bounds, multi-attachment captions, delayed/restarted fetches,
   current-policy fetch decisions and validated cache hits. Replace speculative
   epoch scanning as the default receive path and exercise fork/epoch races.
4. Integrate version migration and existing example callers. Make the selected
   public API policy explicit, retain historical v1 interpretation where chosen,
   and rotate existing local KeyPackages so peers can discover the v2 support.
   Policy activation/removal needs real authorization/capability tests. Do not
   promise automatic migration of unsupported legacy account-proof groups.
5. Finish independent compatibility and release checks. Require the formerly
   failing media profile to pass on latest MDK, stable v0.13.0 and Android's
   pinned revision, with media messages and bytes verified in both directions.
   Update the compatibility report, examples, docs/sidebar and migration notes.

This sequence is a recommendation, not authorization to begin implementation.
Do not treat a capability-only media-profile pass as completion of the feature.

## Acceptance and verification gates

- Rust-produced policy/reference/crypto fixtures match TypeScript bytes and vice
  versa; random-nonce behavior is tested separately from deterministic vectors.
- Add/join and all resulting-state validation paths accept valid required v2
  state and reject malformed optional v2 state. Policy update/removal is admin
  authorized and honors each resulting member's advertised support.
- Actual cross-language media chat succeeds both ways, with captions and at
  least two attachments, including one invalid/unavailable sibling case.
- Commit during upload, queued send after epoch advance and same-epoch branch
  replacement cannot publish a reference under the wrong key source.
- Delayed and restarted receive uses the authenticated source state. Missing
  retained material yields an attachment availability error, not wrong plaintext
  or loss of the message. Removal/disband and pruning tests remain satisfied.
- Noncanonical MIME, invalid Unicode/NUL/oversized filenames, duplicate fields,
  tampered hashes/nonce/AAD, wrong version and cache metadata changes fail.
- Unsupported kinds, valid http locators and locally forbidden hosts remain
  distinguishable from structurally invalid references; no forbidden contact
  occurs. URL fallback preserves pathful endpoint roots and configured order.
- Historical v1 fixtures remain v1, with no silent v2 fallback. Fresh
  current-profile sends emit only v2. Old KeyPackages are refreshed without
  deleting private material still needed by pending valid Welcomes.
- Focused core/client/integration Vitest tests plus public-export type coverage;
  pnpm check and pnpm docs:build before shipping. Mock transfer I/O for routine
  tests. Rust probe must consume actual message/blob outputs, not copied
  TypeScript assertions. Android-device/live-relay confirmation is reported
  separately from reproducible engine/SDK results.

## Accepted API decision

The user accepted the recommendation on 2026-10-22: unversioned media helpers
become v2 by default for v0.8, while explicitly versioned v1 helpers remain for
historical data. Preserve the meaning of every versioned constant and existing
stored reference; current-profile sending emits only v2. Record breaking API
changes and migration examples in the changelog and docs.

The accepted direction is captured in CONTEXT.md. PLAN.md decomposes the work;
this planning continuation does not itself change implementation behavior.
