# Project Research Summary

**Project:** marmot-ts — dark-matter migration, single-device wire-complete milestone
**Domain:** MLS-over-Nostr TypeScript client library (Marmot v2)
**Researched:** 2026-07-01
**Confidence:** HIGH

## Executive Summary

marmot-ts is an ESM TypeScript library that implements the Marmot v2 (darkmatter) protocol — MLS group messaging delivered over Nostr. The library has already completed a large migration from Marmot v1 and shipped baseline wire interop (B1–B7), convergence hardening (M1–M8), and encrypted-media wire format (m1/m4/m5/m6). The darkmatter spec submodule has since advanced to `c9d63de` (59 commits ahead of the v0.2.0 tag), and the June 2026 gap-analysis document is now stale. This milestone resolves that: Phase 1 runs a fresh exhaustive audit of the TS implementation against the latest spec and Rust reference to produce a verified gap catalog; Phase 2 closes every confirmed single-device gap.

The recommended approach is a strict two-phase sequence: audit first, then close. Five gaps are already confirmed from prior work (M9 source-epoch media-secret plumbing, m7 URL conformance vectors, m8 welcome recipient binding, m9 kind-445 sig-before-decrypt, m3 blossom-image documentation). Research has additionally surfaced seven likely gaps not present in the June backlog — most with HIGH likelihood of being real — that the Phase 1 audit must confirm before closure work begins. These are NIP-40 expiration tag emission, routing-rotation subscription to prior nostr_group_ids, kind 30443 exactly-one-tag enforcement, QUIC VarInt canonicality rejection, convergence apply-gating during PendingPublish, `isCommitMessage`/`isProposalMessage` wireformat bug (returns false for all PublicMessage output), and kind 1210 actor/subject attribution. The audit must cover these in addition to the confirmed open items.

The primary risk to this milestone is scope creep into multi-device (MIP-06), push (MIP-05), or the QUIC agent text-stream data plane. None of these are normative yet (MIP-06 bytes are explicitly "MUST NOT implement for interop"), and all are orthogonal to single-device wire interop. The finish line is a green test suite across Node 20/22/24, Deno 2, and Bun confirming byte-exact interop with the Rust darkmatter reference on all single-device flows.

## Key Findings

### Recommended Stack

The stack is fixed — this milestone does not change libraries, only closes gaps in how existing libraries are used. The four-layer architecture maps to counterpart Rust crates: `ts-mls@2.0.0-rc.14` (submodule, 11 commits ahead of tag) → `src/core/` (Marmot protocol primitives) → `src/engine/` (fork-aware state machine) → `src/client/` (Nostr transport, session, runtime). All interop-critical crypto is performed by `@noble/ciphers@2.2.0` (ChaCha20-Poly1305 for kind-445 and media), `@noble/curves@2.2.0` (BIP-340 Schnorr), `@noble/hashes@2.2.0` (SHA-256, HKDF), and `@hpke/core@1.9.0` (HPKE for MLS handshake). Nostr event shape comes from `applesauce-core@6.2.0` and `applesauce-common@6.2.0`.

**Core technologies:**
- `ts-mls` (submodule): MLS RFC 9420 state machine, TLS codec, key schedule — must be used from submodule source, not the published npm tag
- `@noble/ciphers@2.2.0`: ChaCha20-Poly1305 AEAD (kind-445 envelope, encrypted-media) — exact version pinned by ts-mls, do not bump independently
- `@noble/curves@2.2.0`: BIP-340 Schnorr for account identity proofs and event sig verification — same pin constraint
- `@noble/hashes@2.2.0`: SHA-256 message IDs, HKDF key derivation (media keys, NIP-44)
- `@scure/base@2.2.0`: standard RFC 4648 §4 base64 — spec mandates this for kind-445 content; `base64url` is wrong
- `applesauce-core/common@6.2.0`: Nostr event types and NIP-59 gift-wrap factories
- Build constraints: `module: NodeNext` requires `.js` extensions on all relative imports; strict TS fails on unused locals/params; named exports only; `Uint8Array` for all binary (no `Buffer`)

### Expected Features

Research categorizes all spec surface into three buckets for this milestone.

**Must have (confirmed table stakes gaps to close):**
- M9: source-epoch media-secret retention — `GroupMediaService` derives media decryption key only from live-tip `ClientState`; media from older epochs fails silently. Fix: expose `getRetainedExporterSecrets()` from engine, thread into `GroupMediaService`, iterate retained `ClientState` objects from `RetainedHistoryStore`
- m8: welcome recipient binding — `src/core/welcome-join.ts` has no explicit check that the Welcome is addressed to the local account pubkey; `KeyPackageRef` structural match is present but the spec requires the pubkey check to run first
- m9: kind-445 sig-before-decrypt — `NostrGroupPeeler.peelGroupMessages` attempts ChaCha20-Poly1305 decryption before verifying the Nostr event id/sig; spec mandates sig verification as the outermost gate
- m7: URL normalization conformance vectors — WHATWG URL normalization is implemented for avatar-url (0x8007) and encrypted-media (0x8008) but no test vectors for exotic percent-encoding (e.g. `%2F`/`%2f`), IDNA/punycode round-trips, default port elision, or trailing-slash serialization
- m3: blossom-image (0x8002) formally unsupported — must be added to exclusion list with comment pointing to avatar-url (0x8007); matches Rust reference which omits the codec

**Must audit and close if confirmed (likely gaps from fresh spec read):**
- NIP-40 expiration tag emission — when message-retention-v1 (0x8005) is enabled, kind-445 app messages SHOULD carry an `expiration` tag; no evidence of tag emit in `GroupRuntime`; HIGH likelihood gap
- Routing-rotation subscription to prior nostr_group_ids — after a routing update commit, the prior `nostr_group_id` must remain in subscription state for `app_payload_past_epoch_limit` (5) epochs; subscription setup code does not appear to track this; HIGH likelihood gap
- QUIC VarInt canonicality rejection — component decoders must reject over-long length prefixes per `canonical-encoding.md`; no such rejection test exists; MEDIUM–HIGH likelihood
- Convergence apply-gating during PendingPublish — `mayApplyRetainedInbound()` is never called in `ingestEnvelopes`; an inbound commit can advance the canonical tip while a local commit is staged; MEDIUM likelihood
- `isCommitMessage`/`isProposalMessage` wireformat bug — predicates guard on `mls_private_message`; engine now uses `mls_public_message`; all return `false` for real engine output; confirmed bug
- Kind 30443 exactly-one-tag enforcement — spec requires rejecting a KeyPackage event with duplicate id-list tag names; needs audit in `key-package-event-decode.ts`; MEDIUM likelihood
- Kind 1210 actor/subject attribution — whether the engine emits sufficient state-change data for consumers to derive actor/subject on member-added/removed/admin-change events; MEDIUM likelihood

**Defer to future milestone (catalog only):**
- Multi-device MIP-06 — spec bytes are placeholders; explicitly "MUST NOT be implemented for interop yet"; large orthogonal track
- Push notifications MIP-05 — optional; groups work without it; detailed new spec (post-June, token gossip #725)
- QUIC agent text-stream data plane — experimental; receive-role compliance does not require the data plane; 0x8006 policy codec is already done
- `EncryptedKeyValueStore` replacement — AES-CBC with low-iteration PBKDF2 is unsafe for production; out of scope for this milestone but must not be used outside examples/

### Architecture Approach

The TS architecture is a strict four-layer dependency graph that mirrors the Rust crate hierarchy: `ts-mls` (MLS) → `src/core` (no I/O, protocol primitives) → `src/engine` (transport-agnostic state machine) → `src/client` (Nostr transport, session, runtime). The key invariant is that `src/core` and `src/engine` have zero Nostr dependency; transport isolation is enforced at the `GroupPeeler<TEnvelope>` interface boundary. The audit must follow this dependency order bottom-up so foundational encoding issues are caught before higher-layer gaps are investigated.

**Major components and their audit relevance:**
1. `src/core/binary.ts` + `src/core/components/*.ts` — Marmot binary profile with QUIC VarInt encoding; canonicality rejection rules must be verified per-component-decoder
2. `src/engine/retained-store.ts` (`RetainedHistoryStore`) — holds per-epoch `ClientState` objects including `keySchedule.exporterSecret`; the M9 fix attaches to this via a new engine accessor
3. `src/engine/ingest.ts` (`ingestEnvelopes`) — inbound classify/apply pipeline; apply-gating predicate `mayApplyRetainedInbound` must be called here during PendingPublish
4. `src/engine/fork-recovery.ts` — branch comparator must use only authenticated bytes (account identity, commit digest) as tie-breakers; transport arrival order must never enter the comparator
5. `src/client/group/nostr-peeler.ts` (`NostrGroupPeeler`) — the transport/engine boundary where sig-before-decrypt (m9) must be added
6. `src/core/welcome-join.ts` — Welcome recipient binding (m8) and admin-authority check must be enforced before calling `ts-mls joinGroup()`
7. `src/client/runtime/group-runtime.ts` — NIP-40 expiration tag emit when message-retention is active belongs here in the send path
8. `src/core/group-message-classify.ts` — `isCommitMessage`/`isProposalMessage` predicates are stale (PrivateMessage-only); must be updated or deprecated

### Critical Pitfalls

1. **Source-epoch media key not plumbed (M9)** — `decryptMediaFileWithKeys` exists and is correct; the multi-key API is already built; it just never receives retained-epoch states. Silent failure mode: media from any epoch other than the tip fails with a misleading "ciphertext did not authenticate" error. Prevention: add `getRetainedExporterSecrets()` to `MarmotGroupEngine` and thread it into `GroupMediaService`.

2. **Convergence comparator may leak transport arrival order** — JavaScript `Array.prototype.sort()` is stable but falls back to insertion order for equal elements. If any tie-breaker in `resolveFork` / `selectCanonicalBranch` bottoms out on array index rather than `tip_committer` (account identity) then `tip_digest` (SHA-256 of MLS bytes), two peers receiving the same commits in different relay-delivery order will select different canonical branches. Prevention: audit the comparator chain in `fork-recovery.ts`; add a two-instance dual-ordering test.

3. **`isCommitMessage`/`isProposalMessage` return false for all engine output** — the predicates guard on `mls_private_message` wire format; the engine switched to `mls_public_message` during the darkmatter migration and these were never updated. Any caller branching on these predicates silently gets wrong behavior. Prevention: update to use `framedContentType()` from `src/engine/wire-format.ts` or deprecate and replace; add a round-trip test on real engine output.

4. **Convergence apply-gating absent during PendingPublish** — `mayApplyRetainedInbound()` is never called in `ingestEnvelopes`, so an inbound commit can advance the canonical tip while a local commit is staged. The pin (m4) protects data retention but not apply ordering. Prevention: add the predicate call before `processCommit`; return `deferred` disposition when it returns false.

5. **QUIC VarInt non-canonical bytes accepted silently** — `canonical-encoding.md` mandates reject (not repair) on over-long length prefixes. If component decoders accept them, a Rust-produced commit with canonical bytes and a TS-produced commit with over-long bytes will disagree on the canonical form, potentially forking the group. Prevention: add re-encode-and-compare canonicality check in `src/core/binary.ts` after every VarInt read; add an over-long-prefix rejection test.

## Implications for Roadmap

Based on combined research, the milestone maps cleanly to two execution phases.

### Phase 1: Exhaustive Gap Audit

**Rationale:** The darkmatter spec has advanced 59 commits since the June backlog. Five gaps are confirmed from prior work, but research has surfaced seven additional likely gaps. The audit must confirm or close every candidate before closure work begins. Proceeding with Phase 2 before the audit risks implementing fixes against a stale or incomplete gap catalog.

**Delivers:** A rewritten `SPEC_GAP_REVIEW.md` (supersedes the June 2026 snapshot) listing every confirmed gap with file:line pointers, disposition (close-now / defer / already-done), and severity. This is the Phase 1 deliverable and the authoritative input to Phase 2 planning.

**Addresses (from FEATURES.md audit list):**
- Confirm or close: NIP-40 expiration tag emission (HIGH likelihood)
- Confirm or close: routing-rotation subscription to prior nostr_group_ids (HIGH likelihood)
- Confirm or close: QUIC VarInt canonicality rejection (MEDIUM–HIGH likelihood)
- Confirm or close: convergence apply-gating during PendingPublish (MEDIUM likelihood)
- Confirm: `isCommitMessage`/`isProposalMessage` wireformat bug (confirmed bug, severity assessment needed)
- Confirm or close: kind 30443 exactly-one-tag enforcement (MEDIUM likelihood)
- Confirm or close: kind 1210 actor/subject attribution (MEDIUM likelihood)
- Catalog: all MIP-06 multi-device, MIP-05 push, QUIC data-plane surface (defer)

**Audit ordering (bottom-up by architectural dependency):**
1. Transport wire format — kind-445 framing, sig-before-decrypt (m9), MLSMessage base64/nonce encoding. Rust ref: `transport-nostr-peeler/src/peeler.rs`
2. Welcome/join flow — recipient binding (m8), admin-authority check (joining.md steps 1/6/8), KeyPackage rotation failure path. Rust ref: `cgka-engine/src/group_lifecycle.rs`
3. Retained history + epoch secrets — pruning pin, app-payload window, M9 media-secret retention path. Rust ref: `cgka-engine/src/group_context_view.rs`
4. Inbound processing — deferred/stale classification, apply-gating during PendingPublish, dedup vocabulary parity. Rust ref: `cgka-engine/src/message_processor/ingest.rs`
5. Convergence — branch scoring comparator, arrival-order independence, Resolving/Settled distinction. Rust ref: `cgka-engine/src/convergence.rs` + `canonicalization.rs`
6. Publish lifecycle — PendingPublish gates, NIP-40 expiration tag emit, welcome-after-ACK ordering. Rust ref: `cgka-engine/src/publish.rs`
7. App components — QUIC VarInt canonicality, URL normalization parity (m7), 0x8002 exclusion (m3), kind 30443 tag validation, unknown-component byte-for-byte preservation. Rust ref: `cgka-traits/src/app_components/`

**Avoids:** Beginning closure work against an incomplete or incorrect gap catalog; re-visiting closed items if spec surface is discovered late.

**Research flag:** Phase 1 is itself the research phase — it is exhaustive by design. No additional `--research-phase` pass needed before planning.

---

### Phase 2: Close Confirmed Single-Device Gaps

**Rationale:** Once Phase 1 delivers the verified gap catalog, Phase 2 closes every confirmed single-device gap in severity order. The five known-open items plus however many Phase 1 confirms from the likely-gaps list are all closed here. Multi-device, push, and QUIC data-plane items cataloged by Phase 1 are explicitly not touched.

**Delivers:** Green test suite across Node 20/22/24, Deno 2, and Bun; rewritten `SPEC_GAP_REVIEW.md` updated from "audit" to "closed"; all active PROJECT.md requirements moved to Validated.

**Implements (ordered by severity and architectural dependency):**

Blockers first (single-device MUST for wire interop):
- **M9** — `getRetainedExporterSecrets()` on `MarmotGroupEngine`; thread into `GroupMediaService`; cross-epoch media decrypt test (send at epoch N, advance to N+2, verify decrypt)
- **Convergence apply-gating** — call `mayApplyRetainedInbound()` in `ingestEnvelopes` before `processCommit`; test: PendingPublish + inbound commit yields inbound deferred, tip not advanced
- **Convergence comparator audit** — verify tie-breakers bottom out on `tip_committer` then `tip_digest`; add dual-ordering test (two instances, same two competing commits in opposite order, same selected tip)

Security hardening:
- **m9** — add `verifyEvent(event)` in `NostrGroupPeeler.peelGroupMessages` before decrypt; invalid-sig events routed to `invalid_signature` disposition; test with corrupted `sig`
- **m8** — add explicit account-pubkey check in `src/core/welcome-join.ts` before `joinGroup()`; add admin-authority validation post-`joinGroup()`; test: Welcome addressed to account-B delivered to account-A yields `wrong_recipient` before any MLS work

Public API correctness:
- **`isCommitMessage`/`isProposalMessage`** — update predicates to use `framedContentType()` from `src/engine/wire-format.ts` (or deprecate and re-export `framedContentType` as replacement); round-trip test on real engine output

Conformance (close if Phase 1 confirms):
- **NIP-40 expiration tag** — add tag emit in `GroupRuntime` send path when message-retention-v1 is active; omit on commits/proposals; test: retention-enabled group, send app message, verify `expiration` tag present
- **Routing-rotation subscription** — track prior `nostr_group_id` after routing-update commit; subscribe to it for `app_payload_past_epoch_limit` epochs; test: routing update then send on old group id within window yields received
- **QUIC VarInt canonicality rejection** — add re-encode-and-compare check after VarInt decode in `src/core/binary.ts`; test: over-long prefix throws `invalid_encoding`
- **Kind 30443 tag validation** — exactly-one-tag-per-id-list enforcement; `i` tag KeyPackageRef verification in `key-package-event-decode.ts`; test: duplicate `mls_extensions` tag yields rejected
- **m7** — add exotic URL conformance vectors for avatar-url and encrypted-media: IDNA/punycode (`münchen.de` to punycode), percent-encoding case (`%2F` vs `%2f`), default-port elision, trailing-slash serialization
- **m3** — add 0x8002 to `SUPPORTED_APP_COMPONENT_IDS` exclusion list; add source comment pointing to 0x8007; no codec

Any additional gaps confirmed by Phase 1 audit.

**Uses (from STACK.md):** `@noble/curves@2.2.0` `secp256k1.schnorr.verify` for m9 sig check; `ts-mls mlsExporter` called on per-epoch retained `ClientState` for M9; `applesauce-core` event serialization for id hash in m9; existing `WHATWG URL` normalization for m7 vectors.

**Avoids:** Pitfall 1 (M9 silent decrypt failure), Pitfall 2 (sig-before-decrypt ordering), Pitfall 3 (m8 structural-only binding), Pitfall 4 (QUIC non-canonical bytes), Pitfall 6 (isCommitMessage returns false), Pitfall 7 (apply-gating absent).

**Research flag:** Phase 2 work follows well-documented patterns established in B1–B7, M1–M8. No additional research phase needed. Individual items may require cross-checking the Rust reference at `darkmatter/crates/` for exact byte expectations — treat as spot-checks during implementation, not a full research pass.

---

### Phase Ordering Rationale

- Phase 1 must precede Phase 2 because the gap catalog is incomplete. Starting closure work before the audit risks implementing fixes that conflict with newly-discovered gaps (e.g., fixing M9 plumbing before discovering that the retained-store pruning rule is also wrong).
- Within Phase 2, blocker-severity items (M9, apply-gating, convergence comparator) come before hardening items because the convergence and media items are genuine interop failures, not just spec conformance defects.
- Security hardening (m8, m9) follows blockers but precedes conformance items because the spec treats them as MUST requirements on the inbound path.
- Deferred items (MIP-06, MIP-05, QUIC data plane) are explicitly not re-entered even if Phase 1 surfaces new detail about them — they go into the catalog for the next milestone.

### Research Flags

Phases needing no further research pass:
- **Phase 1 (audit):** Is itself research; no pre-pass needed.
- **Phase 2 (closure):** All items have well-defined fix surfaces from ARCHITECTURE.md. The Rust reference (`darkmatter/crates/`) is available for spot-checks during implementation.

Phases with deferred scope requiring future research (not this milestone):
- **Multi-device (MIP-06):** Spec bytes non-normative; a future milestone will need a full fresh spec read when bytes are finalized.
- **Push notifications (MIP-05):** New post-June spec (PR #725 token gossip, #766 chat-list semantics) changes the feature surface significantly; a future milestone needs a full spec read.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions read from `package.json`, `pnpm-lock.yaml`, `ts-mls/package.json`, `darkmatter/Cargo.toml`; no training-data inference |
| Features | HIGH | All spec files read from `darkmatter/spec/` at `c9d63de`; TS source cross-checked; prior `SPEC_GAP_REVIEW.md` used as starting checklist, not truth |
| Architecture | HIGH | Live source code read (`src/engine/`, `src/client/`, `src/core/`); Rust crate AGENTS.md files read; data flows derived from actual code |
| Pitfalls | HIGH | Findings derived from spec text, Rust reference, existing codebase, and `.planning/codebase/CONCERNS.md`; host-safety missing CGNAT/benchmarking ranges is the one MEDIUM-confidence item needing cross-check against `host-safety.md` spec table |

**Overall confidence:** HIGH

### Gaps to Address

- **Host-safety CGNAT/benchmarking ranges:** `src/core/components/host-safety.ts` may be missing some IPv4 special-purpose ranges from the spec table; needs cross-check against `darkmatter/spec/foundation/host-safety.md` during Phase 1 audit pass 7 (app components).
- **`applesauce-core` upstream sig verification:** It is unknown whether `applesauce-core` verifies Nostr event id/sig upstream of the library's ingest path. If it does, m9 closes with a comment rather than new code. Must be confirmed during Phase 2 before adding a redundant check.
- **Kind 1210 attribution scope:** Whether the spec requires the library to emit actor/subject attribution or leaves it entirely to the app layer is not resolved from the spec text alone. Phase 1 must re-read `application-messages.md` and `darkmatter/crates/` usage to determine if this is a library gap or an app-layer responsibility.
- **darkmatter commit `c9d63de` recency:** Commits after June 2026 include push-token gossip (#725), chat-list semantics (#766), and rename-events (#726). Phase 1 must scan these for any new single-device protocol requirements that fall within scope.

## Sources

### Primary (HIGH confidence)
- `darkmatter/spec/` at `c9d63de` (`marmotkit-v0.2.0-59-gc9d63de`) — all subdirectories: `foundation/`, `protocol-core/`, `app-components/`, `transports/`, `features/`
- `darkmatter/crates/*/AGENTS.md` — subsystem maps for `cgka-engine`, `traits`, `transport-nostr-peeler`, `cgka-session`, `marmot-account`
- `darkmatter/Cargo.toml` + crate-level `Cargo.toml` files — Rust dependency version pins
- `package.json`, `pnpm-lock.yaml` — all runtime and dev dep declarations with exact locked versions
- `ts-mls/package.json` — ts-mls version, peer dep requirements
- `src/engine/group-engine.ts`, `src/engine/retained-store.ts`, `src/engine/fork-recovery.ts`, `src/engine/ingest.ts` — engine source
- `src/client/group/nostr-peeler.ts`, `src/core/group-message-crypto.ts` — transport peeler source
- `src/core/welcome-join.ts`, `src/core/group-message-classify.ts` — welcome and classify source
- `src/core/media/crypto.ts`, `src/client/media/group-media-service.ts` — media encrypt/decrypt source
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/codebase/STRUCTURE.md` — codebase map baseline
- `SPEC_GAP_REVIEW.md` (2026-06-19 snapshot) — prior gap analysis, used as starting checklist

### Secondary (MEDIUM confidence)
- `.planning/PROJECT.md` — milestone scope, validated/active/out-of-scope requirement lists
- `darkmatter/crates/cgka-engine/AGENTS.md` audit corrections (B1–B3, Sm1–Sm7, H1) — Rust-side fix history informing TS gap likelihood

---
*Research completed: 2026-07-01*
*Ready for roadmap: yes*
