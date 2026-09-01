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

**v1.0 — catchup: resync marmot-ts to the post-split marmot spec + MDK Rust reference.**

The old "darkmatter" repo was split back into two upstream repos: **`marmot-protocol/marmot`**
(the spec — vendored at `refs/marmot/`) and **`marmot-protocol/mdk`** (the "Marmot Development
Kit" Rust reference — vendored at `refs/mdk/`, now at `marmotkit-v0.9.4`, well ahead of the
`v0.2.0`-era baseline marmot-ts was last audited against). This milestone (1) **reviews what
changed** in both repos since the split, then (2) **catches marmot-ts up** to feature parity
and byte-for-byte interoperability with the MDK Rust code, closing interop-breaking gaps first.
**Proof v2** (the account-identity-proof v1→v2 change) is the headline known breaker. Scope stays
single-device: multi-device (MIP-06), push notifications (MIP-05), the QUIC data-plane/agent-stream
runtime, and app/tooling crates are cataloged during the review but deliberately deferred.

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
- ✓ Commit-integrity and convergence parity (exact proposal-union authorization, listener-safe durable removal, rewind-aware notifications, and structurally complete own-commit convergence) — validated in Phase 03
- ✓ encrypted-media-v1 wire format (locators, ciphertext/plaintext sha256, key derivation/AAD, strict imeta validation) — existing
- ✓ m1/m4/m5/m6 cleanup & retention hardening (legacy fallback retired, pruning pin rule, eligibility split verified, content-derived cross-source dedup) — existing

### Active

<!-- This milestone's (catchup) scope. Hypotheses until shipped and validated; the review step
     (refs/marmot + refs/mdk) and REQUIREMENTS.md refine these into scoped REQ-IDs. -->

- [ ] Review the post-split changes in `refs/marmot` (spec) + `refs/mdk` (Rust), classifying each as interop-breaking / additive / defer, producing the catch-up backlog
- [ ] **Proof v2** — migrate account-identity-proof v1 → v2 to match MDK Rust (known interop-breaker)
- [ ] Conform to post-split spec tightening: wire-boundary validation (#236), admin-policy / membership / role-change invariants (#171), adopted-spec framing (#170)
- [ ] Reach feature parity + byte-for-byte interop with MDK library-scope crates (cgka-engine/session, marmot-account, transport-nostr-*, marmot-markdown)
- [ ] Wire up MDK conformance vectors (`cgka-conformance-simulator`) as cross-impl tests where available
- [ ] Green test suite across all supported runtimes (Node 20/22/24, Deno 2, Bun latest/1.1) at milestone end

### Out of Scope

- Multi-device (MIP-06) — audited & catalogued but deferred; orthogonal to single-device wire interop, sizable feature
- Push notifications (MIP-05) — deferred; optional, groups must work with zero push
- Implementing the blossom-image (0x8002) codec — Rust reference omits it; documenting as unsupported instead (see m3)
- QUIC transport runtime / broker (agent text streams) — experimental live-preview-only; the 0x8006 durable policy codec is done, the data plane is deliberately absent
- App / tooling crates (marmot-app, cli, marmot-markdown, forensics, uniffi, concrete storage backends) — not library scope

## Context

- The old `darkmatter` repo was split into two upstream repos, both vendored under `refs/`:
  - **`refs/marmot/`** — the spec (`marmot-protocol/marmot`), at `archive/marmot-pre-darkmatter-spec-import-64-g7f2f5fa`.
    Post-split spec work of note: #170 (adopted, drop draft/v2 framing), #171 (admin-policy/membership/role-change
    invariants), #236 (wire-boundary validation tightening).
  - **`refs/mdk/`** — the Rust reference ("Marmot Development Kit", `marmot-protocol/mdk`), at `marmotkit-v0.9.4-14-g3628ccc`,
    ahead of the `v0.2.0`-era baseline marmot-ts was last audited against. 21 crates; library-scope ones are
    `cgka-engine`, `cgka-session`, `marmot-account`, `traits`, `transport-nostr-adapter/-peeler`, `marmot-markdown`,
    `storage-sqlite`, and `cgka-conformance-simulator` (test vectors).
- `ts-mls` is a submodule (at `v2.0.0-rc.14-11-g2ca5c43`) and is the MLS engine the library builds on.
- Spec surface to review: `refs/marmot/{foundation,protocol-core,app-components,transports,features}` plus the
  Rust `refs/mdk/crates/`.
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

| Decision                                                                            | Rationale                                                                                                                                                                                                                   | Outcome   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| v1.0 repurposed as "catchup" (not shipped)                                          | The prior v1.0 (single-device wire-complete) never shipped; the darkmatter repo split into marmot + mdk and moved far ahead (v0.2→v0.9), so its phases were shelved to backlog (999.3–999.6) and v1.0 reused for the resync | — Pending |
| Milestone = resync to post-split marmot spec + MDK Rust                             | Feature parity + byte-for-byte interop with the current Rust reference is the verifiable finish line; the refs moved enough that a fresh review is required                                                                 | — Pending |
| Review refs first, then close interop-breakers first                                | Proof v2 and other breakers must be identified and closed before additive parity work; the review grounds the roadmap                                                                                                       | — Pending |
| Proof v2 is the headline known breaker                                              | account-identity-proof v1→v2 changed the wire format; v1 peers cannot interop with current MDK                                                                                                                              | — Pending |
| Multi-device (MIP-06), push (MIP-05), QUIC data-plane & app/tooling crates deferred | Orthogonal to single-device wire interop; cataloged during review but out of scope this milestone                                                                                                                           | — Pending |

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

_Last updated: 2026-09-01 — Phase 03 commit-integrity and convergence parity validated_
