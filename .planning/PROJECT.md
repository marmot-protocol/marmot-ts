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
byte-for-byte, with any spec-conformant peer (including the Rust `darkmatter` reference) —
correctly, across every supported runtime.

## Milestone

**Finish the dark-matter migration to single-device wire-complete.**

The library has been migrated to Marmot v2 (darkmatter). This milestone (1) runs a fresh,
exhaustive audit of the TypeScript implementation against the *latest* darkmatter spec and
Rust reference, replacing the stale `SPEC_GAP_REVIEW.md`, then (2) closes every confirmed
single-device gap the audit surfaces, reaching full single-device wire interop with a green
test suite. Multi-device (MIP-06) and push notifications (MIP-05) are audited and catalogued
but deliberately deferred.

## Requirements

### Validated

<!-- Inferred from existing code — the completed migration baseline (SPEC_GAP_REVIEW "Completed baseline") and shipped architecture. -->

- ✓ Layered architecture (ts-mls → core → engine → client) — existing
- ✓ Cross-platform build/test (browser, Deno 2, Bun, Node 20/22/24) — existing
- ✓ Cross-impl handshake: MLSMessage-framed KeyPackages, PublicMessage commits/proposals — existing
- ✓ Transport/validation blockers B1–B4 (NIP-65 KeyPackage discovery, inbox welcomes, proposal/component tags, account-identity-proof) — existing
- ✓ B5 convergence status/quiescence-settlement (Syncing/Resolving/Settled/Blocked + settle timer + outbound gating) — existing
- ✓ B6 member departure via MLS self_remove (0x000a) + deterministic auto-committer — existing
- ✓ B7 deferred disposition for future-epoch / missing-parent commits — existing
- ✓ M1–M8 validation & convergence hardening (welcome/KeyPackage validation, authorship binding, x-only curve check, relay-URL profile, convergence-policy + witness window, invalidated-on-rewind, non-admin self-update carve-out) — existing
- ✓ Fork-aware engine with tree-fed re-convergence (switch forks live and on restart) — existing
- ✓ encrypted-media-v1 wire format (locators, ciphertext/plaintext sha256, key derivation/AAD, strict imeta validation) — existing
- ✓ m1/m4/m5/m6 cleanup & retention hardening (legacy fallback retired, pruning pin rule, eligibility split verified, content-derived cross-source dedup) — existing

### Active

<!-- This milestone's scope. Hypotheses until shipped and validated. -->

- [ ] Exhaustive gap audit of TS impl vs latest darkmatter spec + Rust, producing a rewritten verified gap-analysis document (Phase 1 deliverable)
- [ ] M9 — source-epoch media-secret retention: retained per-epoch exporter secrets plumbed to the media service so media from an older epoch than the local tip decrypts
- [ ] m7 — URL-normalization parity conformance vectors (avatar-url 0x8007 / encrypted-media 0x8008) covering exotic percent-encoding / IDNA
- [ ] m8 — explicit welcome recipient binding ("reject welcome not addressed to my account") in src/core/welcome.ts
- [ ] m9 — kind-445 sig-before-decrypt: verify Nostr event id/signature before decrypting group messages (or confirm it is covered upstream in the inbound path)
- [ ] m3 — formally document blossom-image (0x8002) as unsupported (Rust-parity: point groups at avatar-url 0x8007)
- [ ] Any additional single-device wire/correctness gaps the Phase 1 audit confirms
- [ ] Green test suite across all supported runtimes at milestone end

### Out of Scope

- Multi-device (MIP-06) — audited & catalogued but deferred; orthogonal to single-device wire interop, sizable feature
- Push notifications (MIP-05) — deferred; optional, groups must work with zero push
- Implementing the blossom-image (0x8002) codec — Rust reference omits it; documenting as unsupported instead (see m3)
- QUIC transport runtime / broker (agent text streams) — experimental live-preview-only; the 0x8006 durable policy codec is done, the data plane is deliberately absent
- App / tooling crates (marmot-app, cli, marmot-markdown, forensics, uniffi, concrete storage backends) — not library scope

## Context

- The `darkmatter` submodule (spec + Rust reference) is checked out at `c9d63de`
  (`marmotkit-v0.2.0-59-gc9d63de`), ahead of the superproject's recorded commit. Its recent
  history postdates the June backlog (e.g. push-token gossip #725, chat-list left-vs-removed
  #766, rename-events #726), so a fresh audit is warranted.
- `ts-mls` is also a submodule (at `v2.0.0-rc.14-11-g2ca5c43`) and is the MLS engine the
  library builds on.
- Spec surface to audit: `darkmatter/spec/{foundation,protocol-core,app-components,transports,features}`
  plus the Rust `crates/`.
- A codebase map already exists at `.planning/codebase/` (ARCHITECTURE, STACK, STRUCTURE,
  CONVENTIONS, CONCERNS, INTEGRATIONS, TESTING).
- `SPEC_GAP_REVIEW.md` (repo root) is the prior backlog snapshot (2026-06-19); Phase 1's
  audit supersedes it. It is referenced by example READMEs, so keep the path.

## Constraints

- **Tech stack**: ESM TypeScript, `module`/`moduleResolution: NodeNext` — all relative
  imports in `src` need emitted `.js` extensions; named exports only; `Uint8Array` for
  binary/protocol data.
- **Compatibility**: Must interoperate byte-for-byte with the Rust darkmatter reference; the
  Rust code + spec are the source of truth for wire format.
- **Cross-platform**: Vitest on Node 20/22/24, Deno 2, and Bun (latest/1.1) must all pass;
  no runtime-specific APIs that break the others.
- **Build**: strict TS config fails on unused locals/params and missing returns; `pnpm` with
  `--frozen-lockfile`; `pnpm lint` is prettier-only.
- **Scope discipline**: single-device wire interop is the finish line; do not build
  multi-device or push in this milestone.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Milestone = single-device wire-complete | Full single-device spec interop + green suite is a shippable, verifiable finish line; multi-device/push are large orthogonal tracks | — Pending |
| Phase 1 is an exhaustive gap audit, all spec areas | The June backlog is stale and darkmatter moved ahead; a verified catalog must precede closure work | — Pending |
| Audit breadth exhaustive, closure single-device only | Catalog everything for completeness, but only close single-device gaps this milestone | — Pending |
| m3 blossom-image documented as unsupported, not implemented | Matches Rust reference which omits the codec and points groups at avatar-url 0x8007 | — Pending |
| Multi-device (MIP-06) & push (MIP-05) deferred | Orthogonal to single-device wire interop; product does not need them yet | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-01 after initialization*
