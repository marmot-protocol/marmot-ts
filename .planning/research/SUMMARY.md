# Project Research Summary

**Project:** marmot-ts — v2.0 "Account identity proof v2"
**Domain:** MLS-over-Nostr (Marmot) protocol library — clean-cut wire-format cutover (component `0x8009`)
**Researched:** 2026-09-12
**Confidence:** HIGH

## Executive Summary

This milestone is an internal cutover, not a feature build: marmot-ts must replace its legacy `0xf2f1` LeafNode
extension proof with the adopted `marmot.member.account-identity-proof.v2` app component `0x8009`, a 104-byte
`MarmotAuthorizationProof` envelope carried inside the LeafNode's `app_data_dictionary` rather than as a raw MLS
extension. All four research passes converge on the same headline finding: **no new dependency is needed** — `ts-mls`
rc.14, `@noble/curves`, `@noble/hashes`, and `applesauce-core`'s `getEventHash` already expose every primitive this
proof class needs (dictionary containers, self-update leaf carriage, BIP-340 verify-that-fails-closed, exact NIP-01
event-id computation up to `2^53-1`). The work is entirely `src/core`/`src/engine`/`src/client` integration code: a
new shared envelope primitive, a new proof-class module built on it, deletion of the old `0xf2f1` machinery with no
fallback, a GroupContext-level requirement enforced across every legality seam, self-update identity/proof binding,
and — the most architecturally novel piece — Current-profile founding group creation that publishes zero founding
commit and delivers membership via Welcome only.

The recommended approach follows a strict dependency chain, confirmed independently by both architecture and
feature research: build the shared 104-byte envelope and byte-exact spec-vector test first (pure, no I/O, cheapest
gate), then the `0x8009` proof-class module and KeyPackage/leaf negotiation rewrite, then the GroupContext
requirement plus the single shared `validateCommitLegality` seam-adapter extension (which propagates to
send/inbound/fork-recovery in one change), then self-update binding, then the clean-cut removal of `0xf2f1` threaded
through the same touched files, and only last the founding-create-via-Welcome path, which depends on every prior
piece already being correct.

The dominant risk is not cryptographic — it's this codebase's own recurring defect class, seam asymmetry (the
"mdk#707" pattern): a legality guard added correctly to one seam (e.g. send) but silently missing or differently
scoped on inbound, convergence/fork-replay, tree-reconvergence, or Welcome-join. v1.0's own history shows this
exact class survived three review rounds and an inserted phase for a *different* guard rollout on this same
codebase. Every new `0x8009` check (presence/uniqueness/location validity, GroupContext requirement, self-update
identity binding, `0xf2f1` rejection) must be written once and reached identically by all five seams, verified with
an explicit per-seam parity test matrix, not just a happy-path fixture. Secondary risks: reproducing the exact
byte-for-byte tag encoding (six simultaneous differences from the legacy event, easy to under-migrate), `created_at`
range/precision handling as a `bigint` before any `Number` conversion, and per-KeyPackage (not per-group) ciphersuite
selection during proof reconstruction — MDK itself needed two dedicated fixes for that last one.

## Key Findings

### Recommended Stack

No new packages. `ts-mls@2.0.0-rc.14` (local fork, submodule-pinned) already exposes `appDataDictionaryExtensionType`,
`ComponentData`, `getAppDataDictionary`, and accepts `leafNodeExtensions` on KeyPackage generation, Update proposals,
and (implicitly, carried forward unchanged) Commit path-updates. `@noble/curves@^2.2.0`'s `schnorr.verify`/
`schnorr.utils.lift_x` already reject invalid x-only points as part of normal verification. `applesauce-core@^6.2.0`'s
re-exported `getEventHash` computes the exact NIP-01 id, including at `created_at = 2^53-1` (JS `Number` is exact to
`Number.MAX_SAFE_INTEGER`, which is precisely the spec's ceiling). `src/core/binary.ts`'s `BinaryWriter`/
`BinaryReader` already has the big-endian `uint64` methods the fixed 104-byte envelope needs.

**Core technologies (unchanged, confirmed sufficient):**
- `ts-mls` (local fork) — LeafNode/KeyPackage `app_data_dictionary` container, self-update/commit leaf carriage
- `@noble/curves` — BIP-340 verify + x-only point validity, already fails closed
- `@noble/hashes` — hex codec, SHA-256 (via `getEventHash`)
- `applesauce-core` — NIP-01 event-id computation, exact to the spec's `2^53-1` ceiling

**What must NOT be added:** a new pubkey-validity or BIP-340 library; a new JSON/event-id library; any patch to
`ts-mls` for a `0x8009`-aware validator (the spec is explicit the proof is app-component-layer only, never an MLS
extension type — confirmed against MDK's `capabilities.rs`); registering `0x8009` in MLS `Capabilities.extensions` or
`required_capabilities` (must go in the `app_components` list instead, the same mechanism `0x8003` already uses).

### Expected Features

**Must have (table stakes — MDK-default groups are unjoinable without every one of these):**
- `MarmotAuthorizationProof` 104-byte codec (fixed-width, no version field, no length prefixes)
- Kind-450 v2 event builder — exact 5-tag order, `0x`-hex ciphersuite/scheme, fixed content string, real `created_at`
- Full validation algorithm (13 enumerated MUST-reject cases from `authorization-proofs.md`/`account-identity-proof-v2.md`)
- Leaf/KeyPackage negotiation: `0x8009` in the `app_components` support list AND exactly one dictionary entry — both
  independently required, merged into the single existing `app_data_dictionary` extension (not a second raw extension)
- GroupContext requirement via the `app_components` list mechanism (not `required_capabilities`)
- Commit-integrity carve-out: `0x8009` is required but leaf-only — must never demand GroupContext dictionary *state*
- Self-update/Update-proposal identity-equality + non-removability + fresh-proof-on-key-rotation checks
- Clean removal of `0xf2f1` from publish/verify/capabilities/admin-policy — no dual-profile fallback
- Founding group creation via Welcome only — no founding commit publication

**Should have (differentiators / hardening beyond a line-for-line MDK port):**
- Explicit "invalid location" rejection distinguishing `KeyPackage.leafNode.extensions` from `KeyPackage.extensions`
  (a ts-mls-specific smuggling vector MDK's Rust model doesn't structurally have)
- `MarmotAuthorizationProof` factored as a genuinely reusable `src/core` primitive (pays off in later milestones:
  multi-device join authorization and push owner proofs are expected to reuse the same envelope)
- Standalone Update-proposal admission re-check mirroring MDK's `validate_standalone_proposal_account_identity_proof`
  (MDK covers Add and Update; marmot-ts's existing `admin-policy.ts` inline check only covers Add today)

**Defer (explicitly out of scope this milestone):** KeyPackage rotation/refresh, multi-device (MDEV-01), push
(PUSH-01), any legacy-group-joining compatibility path.

### Architecture Approach

The proof moves from the MLS-capability-negotiation subsystem (`src/core/capabilities.ts`, raw LeafNode extension)
to the existing Marmot app-component subsystem (`src/core/components/`), joining `admin-policy` and `group-profile`
as one more `app_data_dictionary` entry — but leaf-scoped, never GroupContext-scoped. marmot-ts already has a single
shared seam-adapter, `validateCommitLegality` (`src/core/components/integrity.ts`), called by all four
commit-producing seams (send/`group-engine.ts`, inbound/`ingest.ts`, fork-recovery, and indirectly tree-reconvergence)
— this is a structural advantage over MDK's own per-call-site wiring, and the primary chokepoint to extend rather
than duplicate.

**Major components (this milestone touches):**
1. New `src/core/authorization-proof.ts` — shared 104-byte envelope primitive (encode/decode/verify, `createdAt`
   range check), zero dependents yet, pure and independently testable
2. New `0x8009` proof-class module (in `src/core/components/`) — kind-450 event shape, tag order, ciphersuite/scheme
   hex encoding, binding checks; built on (1)
3. `validateCommitLegality` (`src/core/components/integrity.ts`) — extended with the GroupContext-requires-0x8009 +
   every-resulting-leaf-has-valid-proof check; this single change propagates to 4 of 5 seams at once
4. `GroupFactory`/new core founding-add helper/`GroupRuntime` — new "welcome-only" publish path bypassing the
   existing `PendingPublish`→confirm/rollback commit-publish lifecycle entirely for founding creation with invitees

### Critical Pitfalls

1. **Tag-encoding regression** — the v2 event is not a version bump of the legacy `0xf2f1` event; it differs in tag
   count (6→5), tag values (decimal→`0x`-hex), content string, and `created_at` (always-0→real time), simultaneously.
   Avoid by writing the v2 builder as a new module verified byte-exact against the spec's own signing test vector
   before wiring any call site — never adapt the old tag builder in place.
2. **Seam asymmetry (the "mdk#707" class)** — this codebase's own worst recurring defect: a guard correct on one seam
   (e.g. send) silently missing or differently-scoped on inbound, convergence/replay, tree-reconvergence, or
   Welcome-join. v1.0 needed three review rounds and an inserted phase to close a *different* instance of this same
   class. Avoid by writing every new `0x8009` check once (inside `validateCommitLegality` where possible) and adding
   an explicit per-seam parity test matrix (same malformed input run through all five seams, asserting identical
   rejection) — never assume one shared function is "reached" by every seam without proving it.
3. **`created_at` precision/range** — must be range-checked as a `bigint` (`[1, 2^53-1]`) before any conversion to
   `Number`; a naive `Number(bigint)` conversion before the range check can silently accept out-of-range values.
4. **Wrong ciphersuite for proof reconstruction** — MDK needed two dedicated fixes for reusing an ambient
   "group/engine" ciphersuite instead of reading it per-KeyPackage/leaf. Every reconstruction function must take the
   ciphersuite off the specific leaf/KeyPackage under validation, never a caller-supplied "current" value.
5. **Founding-create-via-Welcome breaks two lifecycle assumptions at once** — it is not "who calls what," it changes
   publish-before-apply semantics (no pending window, no single-commit rollback point) and partial-failure handling
   (N invitees, M<N Welcomes delivered is a valid, retryable state, not an atomic all-or-nothing operation). Must be
   designed as its own result variant, not squeezed into the existing `commit`/`groupEvolution` pending/confirm path.

## Implications for Roadmap

Phase numbering continues at **Phase 6** (v1.0 ended at Phase 5 / QA gate).

### Phase 6: Shared authorization-proof envelope primitive
**Rationale:** Pure, no I/O, zero dependents — the cheapest possible correctness gate (byte-exact spec vector) and a
hard blocker for every other phase. Architecture/pitfalls research both name this as the mandatory first step.
**Delivers:** New `src/core/authorization-proof.ts` — 104-byte `MarmotAuthorizationProof` encode/decode (no version
byte, no length prefixes, strict trailing-byte rejection), `bigint`-based `createdAt` range check `[1, 2^53-1]`,
BIP-340 verify wired through `@noble/curves`, external-signer strict-equality re-verification pattern preserved from
the existing `accountIdentityProofSignatureFromSignedEvent`.
**Addresses:** Table-stakes "104-byte codec" feature.
**Avoids:** Pitfall 2 (created_at precision), Pitfall 4 (strict decode / no version field), Pitfall 5 (x-only pubkey
validity), Pitfall 6 (external-signer substitution), Pitfall 8 (duplicate dictionary entries), Pitfall 17
(cross-runtime BigInt/DataView correctness on Node/Deno/Bun).

### Phase 7: `0x8009` proof class + KeyPackage/leaf negotiation + clean-cut removal of `0xf2f1`
**Rationale:** Needs (6)'s envelope to exist; needed before anything else can produce or validate a v2-shaped leaf.
Bundling the `0xf2f1` removal here is efficient since the same files (`capabilities.ts`, `key-package.ts`,
`components/{ids,dictionary}.ts`) are already being rewritten.
**Delivers:** New proof-class module (exact kind-450 tag order/content/hex encoding), `ACCOUNT_IDENTITY_PROOF_
COMPONENT_ID = 0x8009` registered in `components/ids.ts`, `makeLeafAppComponentsExtension` extended to carry the
proof as one dictionary entry (not a second raw extension), full 13-case validation algorithm, and removal of
`ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE` from `capabilities.ts`'s two `Capabilities.extensions`/
`required_capabilities` push sites with no fallback path retained.
**Addresses:** Table-stakes "kind-450 event builder," "full validation algorithm," "leaf/KeyPackage negotiation,"
"clean removal of 0xf2f1."
**Avoids:** Pitfall 1 (tag-encoding regression), Pitfall 3 (wrong ciphersuite), Pitfall 7 (support-list vs
dictionary-entry confusion), Pitfall 10 (mixed-profile states), Pitfall 14 (stale/nondeterministic fixtures — decide
determinism strategy now, not mid-QA).

### Phase 8: GroupContext requirement + shared legality-seam extension
**Rationale:** Needs (7)'s proof-class logic and realistic v2-shaped fixtures from KeyPackage generation. Centralizing
in `validateCommitLegality` before touching individual seam files avoids a window where seams disagree — matches both
architecture research's explicit build-order recommendation and pitfalls research's #1 lesson from this project's own
history.
**Delivers:** `DEFAULT_GROUP_COMPONENT_IDS` gains `0x8009` (via `createGroup`'s existing `requiredIds` pattern, no
GroupContext `ComponentData` entry since it's leaf-only); `validateCommitLegality`
(`src/core/components/integrity.ts`) extended with the GroupContext-requires-0x8009 + every-member-leaf-has-valid-
proof check, plus the leaf-only carve-out so WIRE-03's "protected id must have GroupContext state" rule doesn't
wrongly demand state for `0x8009`; seam-local swaps in `admin-policy.ts`, `invite-user.ts`, `groups-manager.ts` that
can't be centralized.
**Addresses:** Table-stakes "GroupContext requirement," "commit-integrity carve-out."
**Avoids:** Pitfall 9 (0x8009 leaking into GroupContext dictionary builders/`AppDataUpdate`), Pitfall 11 (seam
asymmetry — this is the phase pitfalls research names by number as the primary defense point; budget a review-fix
cycle here specifically).

### Phase 9: Self-update / replacement-leaf identity and proof binding
**Rationale:** Needs (8)'s chokepoint in place as the extension point. Isolated because it's a distinct invariant
(identity preservation across signature-key rotation) rather than another instance of the presence/validity checks
already built.
**Delivers:** New leaf-rebinding check reachable from the engine's `#assertStagedCommitLegal` — asserts
`replacementLeaf.credential.identity === priorLeaf.credential.identity` independently of proof-internal validity, and
that a fresh proof (never a cached/reused one) binds the new signature key; non-removability of `0x8009` from a
live leaf enforced at the same seam.
**Addresses:** Table-stakes "self-update binding," "non-removability."
**Avoids:** Pitfall 12 (identity-change treated as ordinary self-update), Pitfall 13 (stale proof reused across a
key rotation).

### Phase 10: Founding group creation via Welcome only
**Rationale:** Highest complexity, most architecturally novel — correctly sequenced last since the founding Add
itself must pass full current-profile validation (Phases 6–9) before the local-merge-only path is safe to build.
**Delivers:** `GroupFactory`/`create()` gains an initial-invitees parameter; new core helper applies the founding Add
locally (no group-message publish); new `GroupRuntime`/`GroupPublishWork` welcome-only variant; lifecycle-FSM
decision resolved and documented (open question 2 below) so founding creation's persisted state is `Stable`
immediately with Welcome delivery as an independently-retryable queue, not a `PendingPublish` window.
**Addresses:** Table-stakes "founding group creation via Welcome only."
**Avoids:** Pitfall 16 (naive port onto the ordinary commit pending/rollback machinery; partial-Welcome-failure
mishandling).

### Phase 11: Parity fixtures, exports snapshot, and QA gate
**Rationale:** Acceptance gate for everything above, not a dependency of it — matches the milestone's own established
five-phase QA-gate convention from v1.0.
**Delivers:** Spec test-vector byte-exact round-trip test; re-pointed `proof-v2-parity.test.ts` at the adopted
`0x8009` vector; grep-audited removal/rejection-only status for all 20 files currently referencing `0xf2f1`; updated
`src/__tests__/exports.test.ts` snapshot for removed/renamed/added exports; per-seam parity test matrix (missing
`0x8009`, duplicate, mixed `0xf2f1`+`0x8009`, wrong ciphersuite) run through send/inbound/convergence-replay/
tree-reconvergence/Welcome-join; a decided-and-documented determinism strategy for any byte-exact `0x8009` fixture.
**Addresses:** Cross-cutting QA obligations noted in every research file.
**Avoids:** Pitfall 14 (stale fixtures), Pitfall 15 (exports-surface churn).

### Phase Ordering Rationale

- **Envelope → proof class → seams → self-update → founding-create → QA** is the one dependency order all three
  non-stack research files converge on independently (architecture's §7, features' "MVP recommendation," pitfalls'
  phase mapping table) — treat divergence from this order as a planning red flag.
- Centralizing the legality check in the existing shared `validateCommitLegality` adapter (Phase 8) before any
  seam-local swap is the single highest-leverage ordering decision: it closes 4 of 5 seams in one change and avoids
  re-touching seam files once the proof-class logic (inevitably) needs a correction against the spec vector.
- Founding-create is deliberately last and isolated into its own phase because it is additive new capability with a
  different failure-mode shape (independent per-Welcome retries, not atomic commit-publish) — not a proof-shape swap
  — and its correctness depends on every prior phase already being right.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 8:** the exact lifecycle-FSM treatment interacts directly with Phase 10's founding-create question (open
  question 2 below) — confirm whether standalone Update-proposal admission needs the same pre-commit re-check
  Add proposals get today (open question 1).
- **Phase 10:** highest complexity, most novel data flow in the whole milestone; no existing marmot-ts precedent for
  a "welcome-only, no group-message" publish path. Recommend `/gsd-plan-phase --research-phase 10`.
- **Phase 9:** no MDK engine-level "rotate signature key + mint fresh proof" convenience function exists to port
  (open question 4) — this is new design, not a port; worth a research pass on the exact API shape.

Phases with standard patterns (skip research-phase):
- **Phase 6:** pure codec work against an already-verified spec vector; no ambiguity.
- **Phase 7:** direct extension of existing `components/dictionary.ts` patterns already used for `admin-policy`/
  `group-profile`.
- **Phase 11:** established QA-gate pattern from v1.0's own Phase 5.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Every claim verified by reading `ts-mls` submodule source directly, resolved `node_modules/.pnpm` copies of `@noble/curves`/`nostr-tools`, and existing marmot-ts call sites — no inference from external docs |
| Features | HIGH | Every behavior cited to a specific spec file:line or MDK Rust file:function; byte-exact test vector cross-checked between spec doc and MDK's own Rust unit test |
| Architecture | HIGH | Every claim is a direct grep/read against `src/`, cross-checked against MDK source at `accda242` and the adopted spec at `4a2bc65` — no inference |
| Pitfalls | HIGH | Primary sources: adopted spec text, MDK source + 4 dated review-feedback commits, and this project's own v1.0 phase-review artifacts documenting the *same* defect class recurring three times |

**Overall confidence:** HIGH

### Gaps to Address

- **Admin-policy standalone Update-proposal proof check** — MDK's `validate_standalone_proposal_account_identity_proof`
  covers both Add and Update proposals at admission time; marmot-ts's existing `admin-policy.ts` inline check only
  covers Add today. Whether Update-side coverage is added in Phase 8 or deferred needs an explicit decision during
  planning — flagged as a differentiator in FEATURES.md, not yet a committed requirement.
- **Lifecycle FSM treatment of founding create** — architecture research recommends "skip `PendingPublish` entirely,
  persist as `Stable` immediately, track Welcomes as an independent retryable queue" (matching MDK), but explicitly
  flags this as a decision for the phase plan to confirm, not something already decided in PROJECT.md. Must be
  resolved before Phase 10 implementation, not discovered mid-build.
- **No MDK conformance byte-fixture for `0x8009`** — `refs/mdk/crates/cgka-conformance-simulator/vectors/byte-fixtures/`
  has no `0x8009`-specific fixture file today (only `nostr-routing-v1-*` and a schema file exist). The spec's own
  signing test vector (`account-identity-proof-v2.md`) plus MDK's `#[test] current_proof_matches_the_adopted_signing_
  vector` are the only existing byte-exact sources. Plan to author a new fixture (e.g.
  `account-identity-proof-v2-rust.json`, following the existing `proof-v2-rust.json` schema) from the spec vector,
  cross-checked against the cited MDK unit test, in Phase 7 or 11 — do not wait for an upstream fixture file to
  appear.
- **No explicit identity-rotating replacement-leaf path in ts-mls** — `createUpdateProposal`/`createUpdatePath` both
  hardcode reuse of the existing leaf's `signaturePublicKey`; there is no ts-mls-level mechanism to install a new MLS
  signature key as part of a self-update. This is not a bug to fix in `ts-mls` (the spec's proof-reuse rule means the
  common case is "same proof carried forward unchanged"), but if a future need for actual key rotation surfaces during
  Phase 9 planning, it may require either a new marmot-ts-level remove+re-add convenience or a documented limitation.

## Sources

### Primary (HIGH confidence)
- `./ts-mls/src/{appDataDictionary,keyPackage,createMessage,updatePath,leafNode,extension}.ts` — read directly (vendored submodule)
- `refs/mdk/crates/cgka-engine/src/{account_identity_proof,app_components,self_update,group_lifecycle}.rs`,
  `refs/mdk/crates/traits/src/{engine,app_components/mod,group}.rs`, `refs/mdk/crates/cgka-engine/CLAUDE.md` — read
  directly at `accda242`
- `refs/marmot/app-components/account-identity-proof-v2.md`, `refs/marmot/foundation/authorization-proofs.md`,
  `refs/marmot/protocol-core/{group-setup,joining}.md`, `refs/marmot/foundation/registries.md`,
  `refs/marmot/app-components/README.md` — adopted spec, read directly at `4a2bc65`
- `node_modules/.pnpm/@noble+curves@2.2.0/...`, `node_modules/.pnpm/nostr-tools@2.19.4_typescript@6.0.3/...` —
  resolved installed dependency source, read directly
- marmot-ts source: `src/core/{account-identity-proof,capabilities,key-package,group,credential,binary}.ts`,
  `src/core/components/{ids,dictionary,integrity,app-components-list}.ts`,
  `src/engine/{admin-policy,ingest,group-engine,fork-recovery}.ts`,
  `src/client/{group-factory,groups-manager,marmot-client,key-package-manager,key-package-publisher}.ts`,
  `src/client/group/proposals/invite-user.ts`, `src/client/session/group-session.ts`,
  `src/client/runtime/group-runtime.ts`, `src/__tests__/exports.test.ts` — read directly

### Secondary (MEDIUM confidence)
- None — all four research files reached HIGH confidence via direct primary-source reads

### Tertiary (LOW confidence)
- None flagged

---
*Research completed: 2026-09-12*
*Ready for roadmap: yes*
