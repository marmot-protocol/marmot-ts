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

## Next Milestone Goals

Not yet defined — start with `/gsd-new-milestone`. Candidates:

- Re-check `refs/marmot` + `refs/mdk` for drift (mdk was bumped after Phase 5 in `2dd92b3`, now `7102d66f`)
- Backlog 999.1 — group image support end-to-end
- Backlog 999.2 — documentation review/update ahead of the next release
- Backlog 999.3–999.6 — shelved pre-catchup audit/closure phases; re-scope against the current code before promoting
- v2 tracks still deferred: multi-device (MDEV-01), push notifications (PUSH-01)

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
- ✓ PROOF-01 account-identity-proof v2 (kind-450 event-id signing, Rust-signed → TS-verified fixture) — v1.0
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

### Active

<!-- Hypotheses for the next milestone; refined by /gsd-new-milestone. -->

- [ ] Resync to upstream changes landed in `refs/marmot` / `refs/mdk` since Phase 5
- [ ] Group image support end-to-end (backlog 999.1)
- [ ] Documentation reflects the current library surface (backlog 999.2)

### Out of Scope

- Multi-device (MIP-06) — catalogued, deferred to v2 (MDEV-01); orthogonal to single-device wire interop
- Push notifications (MIP-05) — deferred to v2 (PUSH-01); groups must work with zero push
- Implementing the blossom-image (0x8002) codec — Rust reference omits it; documented as unsupported instead
- QUIC transport runtime / broker (agent text streams) — experimental; the 0x8006 durable policy codec is done, the data plane is deliberately absent
- App / tooling crates (marmot-app, cli, forensics, uniffi, concrete storage backends) — not library scope
- App-message NIP-40 expiry semantics — cataloged as deferred by the catchup review

## Context

- Both upstreams are vendored under `refs/` and are the source of truth for wire format:
  **`refs/marmot/`** (spec, topic-organized; MIP numbering deprecated) and **`refs/mdk/`**
  (Rust "Marmot Development Kit", currently `7102d66f`). A standing rule checks both for upstream
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

_Last updated: 2026-09-11 after v1.0 milestone_
