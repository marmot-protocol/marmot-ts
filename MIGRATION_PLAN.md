# marmot-ts → darkmatter (Marmot v2) Migration Plan

Status: high-level plan, draft. Last updated 2026-06-09.

This document tracks the overhaul of `@internet-privacy/marmot-ts` from the current **marmot / MIP**
spec (`../marmot`) to the **darkmatter / Marmot v2** spec (`../darkmatter/spec`). It is intentionally
high level: it names the work, the order, the dependencies, and the risks. Each phase becomes its own
detailed plan when we pick it up.

## Strategy (decided)

- **Approach: in-place evolution.** Evolve `src/core` and `src/client` toward v2 and break as we go.
  No long-lived `v2/` fork. The library is expected to be unstable on the `dark-matter` branch during
  the migration.
- **Compatibility: hard cut to v2.** Drop v1/MIP wire compatibility. Darkmatter is already breaking
  (account identity proof has no legacy fallback). v1 groups are not expected to interop. This lets us
  _delete_ legacy code instead of maintaining dual paths.
- **Sequencing: foundation first.** Land encoding, identity, registries, and the app-component
  framework before the hard new engine work (convergence / inbound / retained history).

## How to read the spec

- `../darkmatter/spec/layout.md` — canonical surface map and ownership rules.
- `../darkmatter/spec/mip-coverage.md` — the Rosetta stone: maps current MIPs and `marmot_group_data`
  fields to v2 surfaces. **Start here for any "where did X go" question.**
- `../darkmatter/spec/implementation-model.md` — non-normative; how the Rust `darkmatter` repo maps the
  protocol to code (`CgkaEngine`, `PendingStateRef`, `drain_auto_publish`, convergence simulator).
- Knowledge graphs exist for all three repos under each `graphify-out/`. Use `graphify query "..."`.

## Delta summary: what actually changes

### Restructures (existing code, new shape)

| Area            | Today (marmot-ts)                                                                          | Darkmatter v2                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Group state     | `src/core/marmot-group-data.ts` — one `marmot_group_data` MLS extension holding all fields | Split into versioned **app components** in an MLS `AppDataDictionary`, mutated by `AppDataUpdate` diff proposals |
| Encoding        | Ad-hoc decoders (`decodeOpaque16`, `decodeCommaSeparated`, …)                              | Formal **Marmot binary profile** (TLS presentation language + QUIC varint vectors)                               |
| Transport       | Nostr baked through core (`nostr-interface.ts`, kinds, tags)                               | Nostr is one **transport binding**; identity/content/key-agreement decoupled                                     |
| Commit ordering | Deterministic `timestamp-then-id` race resolution                                          | **Convergence**: content-derived branch selection; transport time/order forbidden                                |

`marmot_group_data` field → v2 component (from `mip-coverage.md`):

| MIP-era field                                                | v2 component                        |
| ------------------------------------------------------------ | ----------------------------------- |
| `name`, `description`                                        | `marmot.group.profile.v1`           |
| `admin_pubkeys`                                              | `marmot.group.admin-policy.v1`      |
| `nostr_group_id`, `relays`                                   | `marmot.transport.nostr.routing.v1` |
| `image_hash`, `image_key`, `image_nonce`, `image_upload_key` | `marmot.group.blossom.image.v1`     |
| `disappearing_message_secs`                                  | `marmot.group.message-retention.v1` |

### Genuinely new subsystems (no analog in `src/`)

- **Convergence engine** (`protocol-core/convergence.md`) — candidate-branch replay from retained
  states, branch scoring (`effective_commit_depth`, witness quorum, same-epoch races via
  `commit_digest`), convergence policy as signed group state, branch application + dispositions.
- **Inbound-processing pipeline** (`protocol-core/inbound-processing.md`) — transport-independent
  message-id dedup, classification, dispositions (`AlreadySeen` / `Stale` / `Deferred` /
  `Invalidated` / `Accepted`), application-visible state notifications vs. delivered app payloads.
- **Retained history + anchors** (`protocol-core/retained-history.md`) — `max_rewind_commits` rollback
  horizon, `BeyondAnchor` drop, `MissingRetainedAnchor → Unrecoverable`, app-payload retention window,
  pruning rules.
- **Publish-before-apply lifecycle** (`protocol-core/publish-lifecycle.md`) — publish obligations,
  pending state, confirm/fail. **Behavioral inversion**: today group creation applies the initial
  commit locally first; v2 forbids canonical apply before publish is confirmed.

### New & breaking

- **Account identity proof** (`foundation/account-identity-proof-v1.md`) — `marmot.account-identity-proof.v1`
  LeafNode extension `0xf2f1`, BIP-340 Schnorr signature binding the Nostr account key to the MLS leaf
  signature key. Required in every KeyPackage + member LeafNode and in group `RequiredCapabilities`.
  No legacy fallback.

### Deletions (enabled by hard cut)

- `src/core/group-message-legacy.ts` and legacy NIP-44 group-message paths.
- `src/core/marmot-group-data.ts` monolith (superseded by components).
- v1 commit-ordering / race-resolution code that uses transport timestamps.

## 🔴 Gating dependency: ts-mls extensions-draft support

Installed `ts-mls@2.0.0-rc.10` exposes `CustomExtension` + `RequiredCapabilities` — enough for the
`0xf2f1` identity proof (a custom LeafNode extension) and today's `marmot_group_data` extension.

It does **not** appear to expose the MLS-extensions-draft machinery the app-component model needs:
`app_data_dictionary` extension (`0x0006`), `app_data_update` proposal (`0x0008`), `app_components`
component (`0x0001`). The Rust `darkmatter` side gets these from OpenMLS's `extensions-draft-08`
feature (targeting draft-09 code points).

A second, later ts-mls risk: **convergence requires replaying commits against arbitrary retained
`ClientState` snapshots.** We need to confirm ts-mls can apply a commit to a non-current prior state
(branch replay), not only advance the live state.

Both are resolved in Phase 0 before the component framework (Phase 3) and convergence (Phase 9) commit
to an implementation strategy.

## Phased plan

Ordering reflects foundation-first. The engine cluster (7–9) is the hard, highest-uncertainty work and
lands last. Phases within the same block can overlap.

### Phase 0 — De-risk ts-mls (spike, blocks 3 + 9) — ✅ DONE

- Decision record: [`migration/phase-0-ts-mls-spike.md`](migration/phase-0-ts-mls-spike.md). Probes:
  `src/__tests__/spikes/phase0-ts-mls.spike.test.ts`.
- **Branch replay (Q2): confirmed working** on ts-mls as-is — Phase 9's MLS replay mechanic is de-risked.
- **App components (Q1):** the `0x0006` carrier works (members must advertise `0x0006`/`0x0008` in
  capabilities — a Phase 2/3 task), but ts-mls has **no `app_data_update` (`0x0008`) draft semantics**: it
  carries the proposal opaquely without mutating the dictionary, so there is no in-repo, no-fork path to a
  wire-conformant result.
- **Decision: Option A (cross-impl interop required).** Phase 3 needs real draft-09 AppData support in
  ts-mls via an **upstream contribution (preferred)** or **fork (fallback)**. The native type-7
  `group_context_extensions` path is rejected for production (not wire-conformant with OpenMLS).

### Foundation block (do first)

**Phase 1 — Canonical encoding profile** (`foundation/canonical-encoding.md`)

- Implement the Marmot binary profile (fixed/variable TLS vectors, QUIC varint length prefixes).
- Replace ad-hoc decoders currently in `marmot-group-data.ts`; this becomes the substrate for every
  component byte format and the identity-proof preimage.
- Touches: new `src/core/encoding/` (or `src/utils/marmot-encoding.ts`).

**Phase 2 — Identity + account identity proof** (`foundation/identity.md`, `account-identity-proof-v1.md`, `key-packages.md`)

- Implement the `0xf2f1` extension payload, the domain-separated signing-input preimage, and BIP-340
  Schnorr sign/verify (`@noble/curves` already present).
- Require the proof in KeyPackage generation; reject leaves/KeyPackages without a valid proof.
- Advertise `0xf2f1` in capabilities and require it in group `RequiredCapabilities`.
- Touches: `key-package.ts`, `key-package-event.ts`, `credential.ts`, `capabilities.ts`, `auth-service.ts`.

**Phase 3 — App-component framework** (`app-components/README.md`, `foundation/registries.md`) — _gated by Phase 0_

- `AppDataDictionary` carrier + `ComponentID` model; `AppDataUpdate` diff-proposal grouping and
  deterministic per-component update rules; per-component propose/commit authorization; byte-for-byte
  preservation of unknown non-required components.
- Registries module (component ids, proposal ids, extension ids).

**Phase 4 — Migrate group state into components** (`mip-coverage.md` field split + each component doc)

- Implement `profile.v1`, `admin-policy.v1`, `transport.nostr.routing.v1`, `blossom.image.v1`,
  `message-retention.v1`. Delete the `marmot_group_data` monolith.
- Rewire `createGroup`, capability advertisement (`app_components`), and `proposals/update-metadata.ts`
  onto component updates. `admin-policy.v1` becomes the admin-set source of truth.

### Transport + lifecycle block

**Phase 5 — Transport binding separation** (`transports/nostr.md`)

- Extract Nostr specifics (kinds `445/444/1059`, `h` tag, NIP-65 relay discovery, NIP-40 expiry) into a
  transport-binding layer behind a generalized interface; `nostr-interface.ts` becomes one binding.
- `transport.nostr.routing.v1` holds `nostr_group_id` + relays as **canonical signed group state**, not
  local hints (behavior change).

**Phase 6 — Publish-before-apply lifecycle** (`publish-lifecycle.md`) — behavioral inversion

- Introduce publish obligations + pending state + confirm/fail; stop applying group-creation and
  commits locally before publish confirmation.
- Touches: `groups-manager.ts`, `group/marmot-group.ts`, `group/proposals/*`.

### Engine block (hardest, last)

**Phase 7 — Inbound processing + error taxonomy** (`inbound-processing.md`, `foundation/errors.md`)

- Disposition state machine; transport-independent stable message-id dedup; classification; deferred
  queue; state-notification vs. delivered-payload split.

**Phase 8 — Retained history + anchors** (`retained-history.md`)

- Retained anchor, rollback horizon, app-payload window, pruning, `BeyondAnchor` /
  `MissingRetainedAnchor → Unrecoverable`. Reworks the `group-rumor-history` concept toward retained
  MLS state for replay.

**Phase 9 — Convergence engine** (`convergence.md`) — depends on 7 + 8, de-risked by Phase 0

- Candidate-branch replay, branch scoring + same-epoch race resolution by `commit_digest`, convergence
  policy as signed/required group state, branch application + dispositions + invalidation notifications.
- Replaces all transport-time-based ordering.

### Features + cleanup

**Phase 10 — Features re-layer** (`features/*`)

- Re-point encrypted media onto `marmot.group.encrypted-media.v1` + `features/encrypted-media.md`.
- Multi-device (MIP-06) onto identity + group-messaging surfaces.
- Push notifications: optional. Agent text streams over QUIC: likely out of scope for the TS library
  (new transport); confirm before committing.

**Phase 11 — Cleanup, docs, release**

- Delete remaining legacy paths; update `docs/` + `.vitepress/config.ts`, package `exports`, and
  changesets. Major version bump (breaking).

## Dependency graph (text)

```
Phase 0 (ts-mls spike) ─┬─> Phase 3 (component framework) ─> Phase 4 (state→components) ─> Phase 5 (transport)
                        └─> Phase 9 (convergence)
Phase 1 (encoding) ─> Phase 2 (identity proof), Phase 3, and all component byte formats
Phase 6 (publish lifecycle) ─┐
Phase 7 (inbound)  ──────────┼─> Phase 9 (convergence)
Phase 8 (retained) ──────────┘
Phase 10 (features) after its surfaces land · Phase 11 cleanup throughout, finalize at end
```

## Open questions

- ~~**ts-mls strategy** (Phase 0 output): upstream contribution vs. in-repo custom handling vs. fork.~~
  **Resolved (Phase 0): Option A** — upstream contribution to ts-mls for draft-09 `app_data_update`,
  fork as fallback. See `migration/phase-0-ts-mls-spike.md`.
- **Agent-text-streams-over-QUIC**: in scope for a TS library, or Nostr-only for now?
- **Convergence test strategy**: port darkmatter's "convergence simulator" idea into Vitest, or build a
  TS equivalent? The Rust repo leans on it heavily.
- **Retention defaults**: what default convergence policy + retention window ships for groups that carry
  no explicit policy bytes?

## Next step

Turn **Phase 1 (canonical encoding)** into a detailed, executable plan, and run the **Phase 0 ts-mls
spike** in parallel (it gates Phase 3, not Phase 1).
