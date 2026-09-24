# marmot-ts

## What This Is

marmot-ts is an ESM TypeScript library implementing a Marmot (MLS over Nostr) client. It
runs in the browser and natively in Deno, Bun, and Node.js, and is built as layered
abstractions: **ts-mls** (the core MLS engine) → **src/core** (Marmot helpers, constants,
and crypto over MLS) → **src/engine** (a fork-aware state-machine that tracks epochs and
chooses the correct fork to follow) → **src/client** (a convenience layer so downstream
apps can create clients and subscribe to groups easily). It is for developers building
Marmot/Nostr clients who want a spec-conformant MLS implementation without reimplementing
the protocol.

## Core Value

A downstream client can join a Marmot group and exchange messages that interoperate,
byte-for-byte, with any spec-conformant peer (including the Rust MDK reference) —
correctly, across every supported runtime.

## Current State

**v1.0 Catchup — shipped 2026-09-11** (last phase completed 2026-09-06). See
`.planning/MILESTONES.md` and `.planning/milestones/v1.0-ROADMAP.md`.

marmot-ts is resynced to the post-split marmot spec (`refs/marmot`) and the MDK Rust reference
(`refs/mdk`): account-identity-proof v2, verify-before-trust inbound boundary, #236 KeyPackage
lifetime cap and tag cardinality, commit-integrity and admin/leaf coupling on every legality
seam, SelfEvicted and digest-attributed rewind-withdrawable notifications, a confirm-time
own-commit convergence stamp (ported from MDK), SafeAAD leaf advertisement, the
`marmot.group.lifecycle.v1` disbanded terminal state, MDK conformance vectors wired as automated
tests, and a six-runtime CI matrix with byte-exact Rust parity dossiers.

**v2.0 in progress:** Phase 6 complete (2026-09-12) — `src/core/authorization-proof.ts` provides the shared,
proof-class-agnostic 104-byte `MarmotAuthorizationProof` primitive, reproducing the spec signing vector byte-for-byte.
Phase 7 complete (2026-09-14) — KeyPackage leaves carry the `0x8009` account identity proof (spec vector byte-exact),
signed with the client's own `EventSigner`; invite, admin Add, and join-via-Welcome seams validate it; the legacy
`0xf2f1` module and exports are deleted with no fallback; stored legacy KeyPackages are flagged `nonCurrent`.
Phase 8 complete (2026-09-15) — every group requires `0x8009` in its GroupContext, enforced identically across
create, invite, join, inbound ingest, and convergence, closing the recurring seam-asymmetry defect class.
Phase 9 complete (2026-09-24) — a replacement leaf (self-update or committer update-path) must preserve the
member's account identity and keep `0x8009` bound to the leaf's resulting signature key, on every legality seam;
standalone Update proposals are re-checked at admission. Validation-only — no new key-rotation API.
Next: Phase 10 (founding Current-profile group creation via Welcome only).

## Current Milestone: v2.0 Account identity proof v2

**Goal:** Replace the legacy `0xf2f1` proof extension with the adopted `marmot.member.account-identity-proof.v2`
app component `0x8009` (104-byte `MarmotAuthorizationProof`) so marmot-ts interoperates with MDK's default
Current-profile groups.

**Why:** v1.0's PROOF-01 shipped the pre-adoption proof shape (custom LeafNode extension `0xf2f1`, version byte `2`,
`created_at = 0`, decimal tags). The adopted spec (`refs/marmot/app-components/account-identity-proof-v2.md`,
`refs/marmot/foundation/authorization-proofs.md`) and MDK's default `ProtocolProfile::Current` use component `0x8009`
instead, so MDK-default groups are not joinable by marmot-ts today.

**Target features:**

- Shared `MarmotAuthorizationProof` core primitive — 104-byte envelope codec, `created_at` range (1..2⁵³−1), NIP-01
  event-id + BIP-340 verification, strict external-signer return validation; account proof is its first proof class
- `0x8009` proof class — exact kind-450 event (ordered tags, `0x`-hex ciphersuite/scheme, fixed content, real
  `created_at`), carried in the LeafNode `app_data_dictionary`, advertised in leaf `app_components`, spec test vector
- Clean cut — `0xf2f1` removed from publish, verify, capabilities, and admin policy; legacy KeyPackages, leaves, and
  groups rejected with no fallback
- Group profile requirement — GroupContext `app_components` requires `0x8009`; `0x8009` data in GroupContext is
  rejected; enforced on invite, join, inbound, send, and convergence seams
- Self-update binding — a replacement leaf keeps the same account identity with a fresh valid proof; `0x8009` is never
  removable from a non-blank leaf
- Founding create via Welcome — Current-profile group creation publishes no founding commit; invitees join via
  Welcome only (MDK `FoundingGroupCreated`)

**Deferred candidates (not this milestone):** backlog 999.1 group image support, 999.2 docs review, 999.3–999.6
shelved audit/closure phases, 999.7 invite-only client mode; multi-device (MDEV-01) and push (PUSH-01).

## Requirements

### Validated

<!-- Inferred from existing code — the completed migration baseline and shipped architecture. -->

- ✓ Layered architecture (ts-mls → core → engine → client) — existing
- ✓ Cross-platform build/test (browser, Deno 2, Bun, Node 20/22/24) — existing
- ✓ Cross-impl handshake: MLSMessage-framed KeyPackages, PublicMessage commits/proposals — existing
- ✓ Transport/validation blockers B1–B4 (NIP-65 KeyPackage discovery, inbox welcomes, proposal/component tags, account-identity-proof) — existing
- ✓ B5 convergence status/quiescence-settlement (Syncing/Resolving/Settled/Blocked + settle timer + outbound gating) — existing
- ✓ B6 member departure via MLS self_remove (0x000a) + deterministic auto-committer — existing
- ✓ B7 deferred disposition for future-epoch / missing-parent commits — existing
- ✓ M1–M8 validation & convergence hardening — existing
- ✓ Fork-aware engine with tree-fed re-convergence (switch forks live and on restart) — existing
- ✓ encrypted-media-v1 wire format — existing
- ✓ m1/m4/m5/m6 cleanup & retention hardening — existing
- ✓ PROOF-01 account-identity-proof v2 (kind-450 event-id signing, Rust-signed → TS-verified fixture) — v1.0 _(legacy `0xf2f1` profile; superseded by the adopted `0x8009` component in v2.0)_
- ✓ SEC-01 verify event id + signature before trusting routing tags or decrypting — v1.0
- ✓ WIRE-01 KeyPackage Lifetime cap (≤ 84 days) on publish and inbound — v1.0
- ✓ WIRE-02 required-tag cardinality enforcement (445/1059/444/30443) — v1.0
- ✓ WIRE-03 app-component integrity on send, inbound, and convergence seams — v1.0
- ✓ WIRE-04 SafeAAD component advertisement matching MDK leaf bytes — v1.0
- ✓ CONV-01 admin ⊆ member-leaves resulting-epoch invariant — v1.0
- ✓ CONV-02 SelfEvicted / durable removed-inactive realization — v1.0
- ✓ CONV-03 commit-digest-attributed notifications withdrawn on rewind — v1.0
- ✓ CONV-04 own-confirmed-commit protection (closed structurally via confirm-time convergence stamp) — v1.0
- ✓ CONV-05 disband commits always enter a bounded convergence pass — v1.0
- ✓ LIFE-01 / LIFE-02 `marmot.group.lifecycle.v1` codec and absorbing durable disbanded state — v1.0
- ✓ CONF-01 MDK reference vectors as automated cross-impl tests — v1.0
- ✓ QA-01 green suite on Node 20/22/24, Deno 2, Bun latest/1.1 — v1.0
- ✓ QA-02 byte-exact MDK cross-checks recorded as parity dossiers — v1.0
- ✓ AUTHZ-01..05 shared `MarmotAuthorizationProof` envelope primitive in `src/core` (104-byte codec, `created_at` range, x-only signer check, NIP-01 + BIP-340 verify, strict external-signer produce) — v2.0 _(Validated in Phase 6: Shared Authorization-Proof Envelope Primitive)_
- ✓ PROOF-02..06 `0x8009` account identity proof component (kind-450 template/producer on the spec vector, leaf advertisement + single dictionary entry, leaf/KeyPackage/tree validators, wrong-container rejection) — v2.0 _(Validated in Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut)_
- ✓ CUT-01 / CUT-02 legacy `0xf2f1` never emitted, exports removed, and any `0xf2f1`-carrying/requiring KeyPackage, leaf, or group rejected — v2.0 _(Validated in Phase 7: Account Identity Proof Component (0x8009) + Legacy Clean Cut)_
- ✓ GRP-01..04 GroupContext `app_components` requires `0x8009`, `0x8009` data in GroupContext rejected, enforced identically on create, invite, join, inbound, and convergence seams — v2.0 _(Validated in Phase 8: GroupContext Profile Requirement & Legality-Seam Extension)_
- ✓ UPD-01..04 replacement-leaf identity binding (prior-occupant identity preserved, proof bound to the resulting signature key, `0x8009` non-removable from a non-blank leaf, standalone Update re-checked at admission) — v2.0 _(Validated in Phase 9: Self-Update / Replacement-Leaf Identity Binding)_

### Active

<!-- Hypotheses for the next milestone; refined by /gsd-new-milestone. -->

<!-- v2.0 Account identity proof v2 — REQ-IDs are defined in REQUIREMENTS.md. -->

- [x] Account identity proof as app component `0x8009`, byte-exact with the spec vector and MDK Current profile _(Phase 7)_
- [x] Legacy `0xf2f1` proof profile removed and rejected everywhere (clean cut) _(Phase 7)_
- [x] GroupContext requires `0x8009`; profile enforced on every legality seam _(Phase 8)_
- [x] Self-update / replacement-leaf identity and proof binding rules _(Phase 9)_
- [ ] Current-profile founding group creation via Welcome only

### Out of Scope

- Multi-device (MIP-06) — catalogued, deferred to v2 (MDEV-01); orthogonal to single-device wire interop
- Push notifications (MIP-05) — deferred to v2 (PUSH-01); groups must work with zero push
- Implementing the blossom-image (0x8002) codec — Rust reference omits it; documented as unsupported instead
- QUIC transport runtime / broker (agent text streams) — experimental; the 0x8006 durable policy codec is done, the data plane is deliberately absent
- App / tooling crates (marmot-app, cli, forensics, uniffi, concrete storage backends) — not library scope
- App-message NIP-40 expiry semantics — cataloged as deferred by the catchup review
- Legacy `0xf2f1` proof compatibility (reading or joining existing Legacy-profile groups) — v2.0 is a clean cut to the adopted spec, which forbids a v1/legacy fallback
- Published KeyPackage rotation/refresh to retire legacy KeyPackages — not taken on in v2.0; apps republish

## Context

- Both upstreams are vendored under `refs/` and are the source of truth for wire format:
  **`refs/marmot/`** (spec, topic-organized; MIP numbering deprecated) and **`refs/mdk/`**
  (Rust "Marmot Development Kit", currently `accda242`). A standing rule checks both for upstream
  changes at the start of every phase.
- `ts-mls` is a local workspace package and the MLS engine the library builds on.
- Codebase: ~54k lines of TypeScript under `src/`. The v1.0 catchup touched 124 `src/` files
  (+20.7k / −0.75k) across 53 plans in 7 phases.
- Known technical debt carried out of v1.0:
  - `maxRewindCommits: Infinity` remains memory-unbounded until `GroupHistoryTree` pruning lands
  - Stale `MIP-NN` citations remain in `src/` files outside the Phase-3 citation manifest
  - Accepted/deferred review items are recorded in the phase `deferred-items.md` files
- `SPEC_GAP_REVIEW.md` (repo root) is an older backlog snapshot referenced by example READMEs; keep the path.

## Constraints

- **Tech stack**: ESM TypeScript, `module`/`moduleResolution: NodeNext` — all relative
  imports in `src` need emitted `.js` extensions; named exports only; `Uint8Array` for
  binary/protocol data.
- **Compatibility**: Must interoperate byte-for-byte with the MDK Rust reference; the
  Rust code + spec are the source of truth for wire format.
- **Cross-platform**: Vitest on Node 20/22/24, Deno 2, and Bun (latest/1.1) must all pass;
  no runtime-specific APIs that break the others.
- **Build**: strict TS config fails on unused locals/params and missing returns; `pnpm` with
  `--frozen-lockfile`; `pnpm lint` is prettier-only.
- **Scope discipline**: single-device wire interop; multi-device and push stay deferred until a
  milestone explicitly takes them on.

## Key Decisions

| Decision | Rationale | Outcome |
| --- | --- | --- |
| v1.0 repurposed as "catchup" | The prior v1.0 never shipped and the upstream split moved far ahead, so its phases were shelved to backlog (999.3–999.6) | ✓ Good — shipped a verifiable resync |
| Milestone = resync to post-split marmot spec + MDK Rust | Byte-for-byte parity with the current Rust reference is a verifiable finish line | ✓ Good |
| Review refs first, then close interop-breakers first | Breakers (proof v2, inbound trust, wire boundary) had to land before additive parity | ✓ Good |
| Proof v2 isolated as Phase 1 | Touches identity/credential machinery; headline breaker | ✓ Good — closed in 2 plans |
| Multi-device, push, QUIC data plane, app/tooling deferred | Orthogonal to single-device wire interop | ✓ Good — still valid |
| Insert Phase 03.1 instead of a fourth self-graded review-fix pass | Three review rounds each found blockers in the previous fixes | ✓ Good — 15 planned closures verified |
| Port MDK `OwnCommitConvergenceStamp` rather than patch CR-08/CR-11 incrementally | The Rust reference already had a structural solution to the defect class | ✓ Good — closed in Phase 4 |
| Standing per-phase `refs/` upstream check | 2026-08-06 sweep found submodules 4 and 193 commits behind | ✓ Good — surfaced lifecycle-v1 scope (Phase 04.1) |
| Implement `marmot.group.lifecycle.v1` disbanding in v1.0 (Phase 04.1) | New spec scope sharing the convergence-pass machinery | ✓ Good |
| QA-02 evidence as immutable dossiers bound to one tested source SHA | Byte-exact claims must be reproducible and machine-validated | ✓ Good |
| v2.0 clean cut to proof component `0x8009` (no legacy `0xf2f1` profile) | Adopted spec forbids a v1/legacy fallback; diverges deliberately from MDK's temporary explicit-legacy path | — Pending |
| `MarmotAuthorizationProof` as a shared `src/core` primitive | Multi-device join authorization and push owner proofs reuse the same 104-byte envelope | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):

1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):

1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

_Last updated: 2026-09-24 — Phase 9 (Self-Update / Replacement-Leaf Identity Binding) complete_
