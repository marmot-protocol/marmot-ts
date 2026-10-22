# Media v2 implementation plan

Status: implementation completed on feat/media-v2; verification evidence and deviations are recorded in IMPLEMENTATION.md.
Date: 2026-10-22. Branch at planning: v0.8. Baseline: 967473d9.
Prerequisites: read CONTEXT.md, RESEARCH.md and repository AGENTS.md.
This is a focused feature plan, not a claim of GSD plan-checker certification.

## Goal

A marmot-ts user joins a White Noise-compatible media group, sends a kind-9
caption plus encrypted-media-v2 attachment that Rust decrypts, and receives and
decrypts the equivalent Rust-produced message. Unversioned media APIs default to
v2; explicitly versioned v1 readers preserve historical interpretation.

## Execution discipline

At implementation start, fetch origin in refs/marmot and refs/mdk, inspect
HEAD..origin/HEAD and relevant diffs, and fast-forward when appropriate. Commit
reference pointer updates separately as chore(refs):. Reconcile this plan with
any changed media semantics before coding. Keep the reviewed Android/stable
revisions available as independent test checkouts.

Create a feature branch from v0.8 before implementation commits. Use focused
conventional commits after relevant checks. Add customer-facing Unreleased notes
for library behavior changes. Keep the first complete media exchange reviewable
before expanding transfer functionality; do not ship an intermediate KeyPackage
advertisement that claims support for unfinished media behavior.

## Milestone 1: one complete cross-language media exchange

Tasks 1A–1D form one production-quality vertical slice. Complete and verify the
whole slice before broadening behavior. Preparatory commits may exist, but the
capability becomes public only when the complete slice works.

### 1A. Establish the Rust media oracle and versioned primitives

Changes:

- Extend scripts/mdk-interop/main.rs and run.mjs to run MDK's actual public
  media implementation, in addition to its engine. Start with
  marmot-app's public parse_media_attachment, upload_media, download_media,
  send_media_attachments/send_tagged_media APIs as applicable.
- Establish the smallest real app fixture and local blob transport needed to
  exercise these APIs. Keep the existing raw-engine probe as a quick invite
  check. Do not replace private Rust media functions with a second handwritten
  Rust crypto implementation and present that as MDK evidence.
- Produce deterministic public test fixtures for policy bytes, valid/invalid
  references and fixed-input crypto through actual MDK calls/tests. Record
  upstream revision, generation command and provenance. Fixed fixture secrets
  are disposable test data; never expose real exporter material.
- Add a distinct v2 policy codec and explicitly versioned attachment/crypto
  types in src/core/components and src/core/media. Keep V1 exports frozen.
- Implement exact v2 MIME, Unicode/filename, HKDF-info, AAD, nonce and integrity
  rules. Share internals only where their behavior is identical for both versions.
- Define the unversioned public defaults as v2 according to CONTEXT.md, with
  explicit historical V1 entrypoints and compile-time export coverage.

Create or extend meaningful tests:

- src/core/components/__tests__/encrypted-media-v2.test.ts
- src/core/__tests__/media-v2.test.ts
- src/__tests__/fixtures/media-v2-rust.json, only with verified generation
- src/__tests__/exports.test.ts

Verification:

```sh
pnpm vitest run src/core/components/__tests__/encrypted-media-v2.test.ts src/core/__tests__/media-v2.test.ts src/__tests__/exports.test.ts
pnpm typecheck:tests
```

Gate: both implementations agree on policy/reference bytes and ciphertext
verification. Version, MIME, filename and hash/AAD tampering are rejected. V1
fixtures still decode only under their explicit frozen format. No fresh public
KeyPackage advertises v2 yet.

### 1B. Bind media preparation and receive metadata to the MLS source state

Changes:

- Extend applicationMessage intents through src/engine/types.ts,
  src/client/session/group-effects.ts and group-session.ts with an optional
  source-state expectation for media. Ordinary text intents retain their current
  behavior. Reuse the existing canonical parent identity rather than inventing
  a numeric-epoch-only check.
- Capture preparation state before deriving a media key. Include a serializable
  opaque expectation in prepared results; expose a typed stale-preparation
  outcome. Do not put exporter secrets or a full ClientState into public tokens.
- Enforce the expectation inside serialized admission and immediately before
  MLS application encryption, including queued/resumed sends and intervening
  awaits. Refuse changed epochs and changed branches at the same epoch.
- Thread the authenticated source identity of delivered media messages into
  GroupMediaService's receive path. Reuse existing history/delivery evidence
  rather than trusting a caller-supplied epoch from imeta.
- Establish the minimum bounded retained-secret mechanism needed for delayed
  media. Reuse the current lifecycle/retention coordinators and preserve
  removal/disband fences. A missing source secret produces unavailable media.
- Validate reference fields before cache lookup; bind verified cached entries
  to the version/source/crypto fields so a matching blob hash alone cannot
  validate different metadata.

Create tests:

- src/client/group/__tests__/media-v2-source-state.test.ts
- Extend group-media-service.test.ts and existing session/retention tests.

Verification:

```sh
pnpm vitest run src/client/group/__tests__/media-v2-source-state.test.ts src/client/group/__tests__/group-media-service.test.ts src/client/session/__tests__/group-session.test.ts
```

Gate: commit during upload, queued send after state advancement and same-epoch
fork replacement cannot publish misbound references. Delayed receive succeeds
using the correct source identity; missing material does not drop the message.
Cache hits cannot bypass metadata/source validation.

### 1C. Integrate group policy, membership and a minimal transfer path

Changes:

- Add 0x800b dictionary accessors, MarmotGroupView projection and component
  updates in src/core/components/dictionary.ts, client-state.ts and
  src/client/group/proposals/update-metadata.ts.
- Validate complete optional and required v2 policy state at Welcome, local
  commit, inbound commit and convergence/replay seams. Authorization and
  resulting-member capability checks must match MDK.
- Accept explicit media policy at group creation. Plain chat groups need not
  require media; media-enabled groups require 0x800b and valid policy state.
- Add the minimal injectable media blob adapter in client. Support the ordered
  Blossom upload/fetch operation needed for one file, retaining pure core code.
  Reuse group-image transport patterns without changing image cryptography.
- Integrate one group-level prepared attachment send and exact-source receive
  path. Ciphertext upload is independent of MLS canonical state; transfer
  failure does not advance or roll back the group.
- Finally advertise v2 support in generated KeyPackages, publication tags and
  evaluation. Permit valid MDK media Welcomes. Preserve the distinct frozen v1
  IDs; never permit v1 data in current-profile state by relabelling it.

Create/extend tests:

- src/client/group/__tests__/media-v2-transfer.test.ts
- src/__tests__/integration/media-v2-exchange.test.ts
- src/core/__tests__/mdk-welcome-compat.test.ts
- src/client/__tests__/join-account-identity-proof.test.ts
- Relevant existing key-package and component-integrity tests.

Gate: a required 0x800b group can be created, joined and updated; malformed
optional policy is rejected too. Non-admin changes and missing member support
fail before publication. One mocked transfer plus real MLS message works through
public library APIs, with v2 defaults and correct source binding.

### 1D. Prove the complete slice against latest MDK

- Run a real Rust media group requiring 0x800b with a TypeScript member.
- TypeScript -> Rust: prepare/encrypt, upload to local fixture blob storage,
  publish/process the real MLS app message, parse the imeta through MDK and
  download/decrypt the blob using MDK's actual media implementation.
- Rust -> TypeScript: use MDK's public media send/upload path, process its real
  message in the library and fetch/decrypt the blob via the public client path.
- Assert plaintext bytes, caption, filename, MIME and authenticated source state.
- Refresh docs/guide/mdk-compatibility.md only to claim what has actually passed.

Verification:

```sh
pnpm build
MDK_PROFILE=media node scripts/mdk-interop/run.mjs
pnpm vitest run src/__tests__/integration/media-v2-exchange.test.ts
```

Gate: the formerly failing media profile exits zero and proves media messages
and bytes in both directions. A Welcome-only success is a failure of this gate.

## Milestone 2: transfer, retention and availability coverage

Depends on Milestone 1.

- Complete bounded upload/download adapters: explicit URL preservation, ordered
  endpoints, deduplicated fallback, cancellation, byte limits and timeouts.
  Enforce local destination/redirect policy before contact. Treat valid http
  endpoints as structurally valid even when this installation refuses contact.
- Construct fallback URLs using root.rstrip('/') + '/' + ciphertext hash;
  include endpoints with path segments and no final slash in tests.
- Support captions, replies and multiple attachments through existing kind-9
  semantics. Invalid metadata is attachment-local; failed I/O/crypto is
  attachment-unavailable. Neither drops the caption or valid siblings.
- Judge fetchability using current policy, while crypto uses authenticated
  source state. Unknown/out-of-policy locator kinds do not invalidate messages.
- Persist/reload the minimal retained-secret and verified-cache metadata under
  existing retention rules. Keep plaintext caching optional and scoped by group.
  Handle old cache entries explicitly; do not assume they are verified v2 data.
- Exercise pruning, restart, removed member, removal recovery and disband
  cleanup. Preserve all existing secret-erasure and outbound-fencing guarantees.
- Retries following source-state changes must prepare new ciphertext with a
  fresh random nonce. Do not silently retag or resend stale prepared media.

Verification: focused transfer, source-state and integration tests, including
multi-attachment captions, changed metadata on cache hits, changed current
policy, lost source material, cancellation and restart. Run the existing
removal-recovery and disband suites when those paths are touched.

Gate: availability and lifecycle outcomes remain correct without unbounded
private-state retention or unexpected network contact.

## Milestone 3: API migration and existing app integration

Depends on Milestones 1–2; versioned primitives start in 1A.

- Migrate public unversioned policy/accessor, attachment and crypto defaults to
  v2. Preserve explicit V1 types/constants/readers/decryption for historical data.
- Provide an explicit version discriminator for history rendering. Reject
  duplicate/unknown versions; do not retry another format after a crypto error.
- Keep current-profile outbound send v2-only even when historical V1 helpers
  are present. Explain any moved/renamed symbols with before/after examples.
- Refresh local KeyPackage publications whose signed capability set lacks v2.
  Preserve pending-Welcome private material and existing installation signing
  identities. Republishing only tags does not upgrade signed MLS capabilities.
- Update examples/opentui/src/marmot/controller.ts and blossom.ts to use the
  source-bound send/receive path; retain reply tags, captions and existing
  attachment statuses. Update GroupInfoModal.tsx's media policy editing.
- Implement authorized activation/update/removal of v2 policy with complete
  resulting-state checks. Only offer atomic v1 -> v2 policy migration where the
  starting group is otherwise supported and the upstream profile permits it;
  do not promise migration of unsupported legacy account-proof groups.
- Add docs/core/media.md plus sidebar entry and migration guidance in the
  existing client/core pages. Call out the v0.8 defaults change in CHANGELOG.md.

Gate: public-export/type tests and migrated examples compile. Historical v1
fixtures/cache entries remain correctly versioned, while fresh sends and
published capabilities use v2. No profile-image behavior changes.

## Milestone 4: compatibility and release evidence

Depends on all previous milestones.

- Repeat actual bidirectional invite + media-message + blob exchange on latest
  MDK, stable v0.13.0 and the Android-pinned revision from RESEARCH.md.
- Include a delayed reference, a source-state change during upload and a
  multi-attachment caption with one unavailable sibling in the independent
  interoperability evidence; distinguish deterministic fixtures from random
  runtime encryption and local transport tests from live relay tests.
- Record tested SHAs and any normative MDK/spec differences; do not claim an
  Android device test from a Rust engine/app result.
- Update the compatibility matrix to media passes only after the complete
  message/crypto checks pass. Retain explicit remaining limitations.
- Run focused tests throughout, then pnpm check and pnpm docs:build. Run Rust
  builds/probes before the final TypeScript suite to avoid resource-related
  timeouts observed during the preceding compatibility review.

Completion requires all accepted behavior in CONTEXT.md, all milestone gates,
passing repository checks and an accurate migration guide. It does not require
publishing a package, deploying a site or opening a PR without a further request.

## Review of this plan

Self-reviewed for coverage of policy, crypto, invitation capability publication,
source-state races, optional component validation, retention/cache behavior,
legacy data, example callers and independent Rust evidence. No independent
subagent review or GSD plan-checker execution is claimed.

No further product decision blocks Milestone 1. Use existing local transport and
retention configuration defaults where applicable; do not add extra approval
checkpoints for reversible implementation details.
