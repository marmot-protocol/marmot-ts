# MDK ↔ marmot-ts interop & feature deltas (v0.2 → v0.9.4)

Audit of the Rust reference (`refs/mdk`, MDK v0.9.4) against marmot-ts `src/`.
Scope: `cgka-engine`, `cgka-session`, `traits`, `transport-nostr-peeler`,
`transport-nostr-adapter`, `marmot-account`, `marmot-markdown`, `storage-sqlite`,
`cgka-conformance-simulator`. App/CLI/uniffi/QUIC/agent/forensics cataloged as deferred.

Method: `git log v0.6.0..HEAD` per in-scope crate, read the rule in Rust, cross-checked
marmot-ts with file:line. No source changed.

Note on the "wire" story: MDK carries all group state (profile, admin policy, nostr
routing, retention, media, avatar) as versioned **app components** inside the OpenMLS
draft-08 `app_data_dictionary` extension. marmot-ts already mirrors this whole subsystem
(`src/core/components/*`, ids matching `traits/src/app_components`). The deltas below are
incremental changes on top of that shared baseline.

---

## Findings (classified)

### 1. App-component integrity validation on staged commits — MISSING — interop-breaking

- **Rust:** `cgka-engine/src/app_components.rs` `validate_app_component_integrity_for_staged_commit`
  (PR #704, commit `dc9c234`; also `b9ae3ce`). Enforced at 4 seams: ingest
  (`message_processor/ingest.rs`), send (`message_processor/send.rs`), convergence/replay,
  and the GCE-authoring upgrade path. Rejects **pre-merge** any commit whose resulting
  `GroupContext` (a) drops the `app_data_dictionary`, (b) drops the `app_components` entry
  or any currently-required component id, or (c) rewrites a required component's bytes
  **outside** a validated `AppDataUpdate` proposal (attribution rule: every dictionary
  entry that changes vs the current epoch must match one of the commit's own AppDataUpdate
  ops). Guards against a `GroupContextExtensions`-only commit silently stripping/tampering
  admin-policy → admin-less, frozen group.
- **marmot-ts:** No equivalent. Grep for `validate*component`, `requiredComponents`,
  `integrity`, `AppDataUpdate`-attribution across `src/core` + `src/engine` returns nothing
  (component codecs exist in `src/core/components/dictionary.ts` but no commit-time
  retention/attribution check). Admin-commit policy (`src/engine/admin-policy.ts`) only
  enforces MIP-03 admin-only-commits, not component retention.
- **Verdict:** MISSING. **interop-breaking** (validation-consistency): marmot-ts would
  _accept_ a component-stripping/tampering commit that MDK _rejects_ → divergent group
  state / silent fork between the two impls.
- **Change:** Port `validate_app_component_integrity_for_staged_commit` into the engine and
  invoke it on the inbound-commit path (`src/engine/ingest.ts` commit branch), the
  outbound commit/send path, and the convergence/replay candidate path.

### 2. SafeAAD component id (0x0002) + leaf dictionary advertisement — MISSING — additive-feature

- **Rust:** `traits/src/app_components/mod.rs:57` `SAFE_AAD_COMPONENT_ID = 0x0002`;
  `cgka-engine/src/app_components.rs` `leaf_app_components_extension` (PR-less commit
  `b9ae3ce`, "Advertise SafeAAD app component support") now (a) inserts
  `APP_COMPONENTS_COMPONENT_ID` (0x0001) **into** the advertised `app_components` list, and
  (b) adds a second dict entry under `SAFE_AAD_COMPONENT_ID` (empty list) signalling the
  impl understands SafeAAD framing but does not yet emit it. Group creation must NOT put a
  safe_aad entry in the GroupContext, and safe_aad as _group-component state_ is rejected
  (`validate_app_component_update`/`_remove` return "not supported yet").
- **marmot-ts:** `src/core/components/ids.ts` has no `SAFE_AAD_COMPONENT_ID`.
  `src/core/components/dictionary.ts:129` `makeLeafAppComponentsExtension` builds a **single**
  `app_components` entry from `SUPPORTED_APP_COMPONENT_IDS`, which by comment deliberately
  **excludes** 0x0001; no safe_aad entry emitted.
- **Verdict:** MISSING / DIVERGES on LeafNode bytes. **additive-feature** (not join-breaking:
  neither impl _requires_ 0x0001/0x0002 as a group component, so intersection negotiation
  still succeeds; but published KeyPackage/LeafNode dictionaries differ from the reference).
- **Change:** Add `SAFE_AAD_COMPONENT_ID = 0x0002`; include `APP_COMPONENTS_COMPONENT_ID` in
  the advertised leaf list and add the empty safe_aad entry in
  `makeLeafAppComponentsExtension`; reject safe_aad as group-component state.

### 3. Malformed group message → terminal stale, never abort ingest — PARITY

- **Rust:** PR #893 (`e673cf8`) `malformed_terminal_stale` — a `PeelerError::Malformed`
  must retire the message as terminal stale, never propagate `?` and abort the whole
  transport drain (one garbage kind-445 must not stall the group).
- **marmot-ts:** Already the model. `src/engine/ingest.ts` classifies undecodable/decode-error
  envelopes as `unreadable` (terminal) → `src/engine/ingest-disposition.ts:46-47`
  `inputCategories.invalidEncoding`; the ingest generator yields dispositions and never
  throws on garbage (see ingest.ts:515-522 non-commit unreadable; :368 nothing-readable).
- **Verdict:** PARITY. No change needed. (Optionally cross-check that snapshot-fallback /
  deferred-peel retry paths also stay non-aborting — marmot-ts uses the ingestion pool for
  retry, structurally equivalent.)

### 4. Nostr ingest-boundary hardening (strict tags + id verification) — DIVERGES — defer

- **Rust:** PR #727 (`a345c28`) `transport-nostr-peeler`. Routing tags (`445` `h`, `1059`
  `p`, `444` rumor `e`/`relays`) extracted **exactly-once** (`single_tag_value`), missing
  AND duplicate both rejected; the `h` value must be hex-exact 32 bytes; `TransportMessage.id`
  is bound to the **recomputed NIP-01 event hash** (`self.id == computed_id()`), never the
  self-reported id; relay URLs length-bounded + ws/wss-scheme validated on wrap and peel.
- **marmot-ts:** `h` tag read with **first-match** `tags.find(t => t[0]==="h")` and used only
  for audit metadata (`src/client/runtime/group-runtime.ts:360`,
  `src/engine/group-engine.ts:1221`); no single-tag enforcement, no event-id recomputation at
  the peeler (`src/client/group/nostr-peeler.ts` just decrypts; `idOf` returns `envelope.id`).
  Signature/id trust is effectively delegated to the applesauce event store / relay layer.
- **Verdict:** DIVERGES. **defer** (hardening, not wire-format): peeling is by decryption, and
  the `h` tag is not routing-load-bearing in marmot-ts (filter subscription drives routing).
  Worth adding id-hash verification + strict-tag extraction as defense-in-depth, but not
  required for byte-for-byte interop.
- **Change (optional):** verify `event.id === computeEventId(event)` and enforce single `h`
  tag at the ingest seam before trusting audit `wire_id`.

### 5. Own confirmed commit protected / GroupStateInvalidated — DIVERGES? — defer (verify)

- **Rust:** PRs #706/#723 (`1551a7a`, "materialize own confirmed commits as pre-validated
  convergence candidates") + #363/#702 (`ddf2602`). A device's own **published-and-confirmed**
  commit is materialized as a pre-validated convergence candidate and is **not** rolled back
  in favor of a same-epoch reorged sibling; when a branch is superseded the engine emits a
  `traits::GroupEvent::GroupStateInvalidated { group_id, epoch, invalidated_commit_id,
reason }` (an **internal** app-facing engine event, NOT a Nostr wire event) +
  `CommitRolledBack`.
- **marmot-ts:** Has independent convergence/fork selection (`src/engine/fork-recovery.ts`,
  `tree-convergence.ts`, `history-tree.ts`, publish-before-apply staging). Needs a focused
  check that own-confirmed tips get the same protected/pre-validated treatment and identical
  same-epoch tie-break, since divergent winner selection would fork state across impls.
- **Verdict:** DIVERGES (unconfirmed) on convergence selection semantics; the invalidation
  event itself is internal → **defer** the event, but flag the selection rule for a targeted
  convergence-parity check.

### 6. Clear removed-marker on branch supersession (#724) & admin-policy coupled to

member removals on send/validate (#701) — DIVERGES? — defer (verify)

- **Rust:** `b255836` (#724) clears a member's "removed" marker when branch selection
  supersedes the removal (marker also clears via authenticated re-join); `5f0d60b` (#701)
  couples admin-policy AppDataUpdate to member-removal proposals on both send and validate
  paths (removing a member who is an admin must also update admin-policy in the same commit,
  else reject).
- **marmot-ts:** `src/engine/admin-policy.ts` enforces admin-only-commits but no grep-visible
  coupling of admin-policy updates to removal proposals, nor a removed-marker-clear-on-
  supersession rule. Likely partial/absent.
- **Verdict:** DIVERGES (probable). **defer** — behavior-parity items; #701 is the higher
  interop risk (send/validate could disagree with MDK on whether a removal-without-policy-
  update commit is legal).

---

## Deferred (cataloged — app-layer / out of scope, no marmot-ts wire impact)

| PR / commit                   | Area                                                                            | Why deferred                                                                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #852 `8faa6d2`                | `marmot-app/media/blossom.rs` — ciphertext-compatible Blossom defaults          | App upload endpoint selection/config; not wire format. marmot-ts media lives in `src/core/media*` + `src/client/group/group-media-*` and is codec-level already.                                           |
| #874 `3071274`                | `marmot-app` + `storage-sqlite` timeline — honor group-admin moderation deletes | App timeline projection + a sqlite migration (`0027_app_event_moderation_grant`); no engine/wire rule.                                                                                                     |
| #892 `e6654ec`                | `marmot-app` epoch-stall + `transport-nostr-adapter`                            | Commit-loss epoch-gap **backfill** is app sync-loop logic; the only in-scope bit is the adapter registering routing state before issuing subscriptions (minor ordering fix).                               |
| #825 `363b1fe`                | `marmot-app` + `storage-sqlite`                                                 | Commit-loss **error taxonomy** (`AppError::AccountCatchUp`) + transport-cursor clamp-then-max on save; app/storage concern.                                                                                |
| #827 `894e768`                | `marmot-uniffi` errors                                                          | Distinguish malformed recipient KeyPackage vs unusable fetched KeyPackage. FFI taxonomy; underlying rule may already be covered by `src/client/key-package-errors.ts` (verify it separates the two cases). |
| #755 `cf780a1`                | external signer account support                                                 | Auth/account-mgmt; not wire.                                                                                                                                                                               |
| #782 `814a13a`                | repro loop                                                                      | Test harness.                                                                                                                                                                                              |
| #699/#379, #708, #700, #381   | redaction/zeroize, host-safety dial chokepoint, daemon bounds                   | Security/runtime hardening, out of scope.                                                                                                                                                                  |
| #736/#745 `7c4ad03`           | convergence send-gate future-side bound + superseded-scan scoping               | Engine perf/bounds; verify marmot-ts send-gate has an equivalent bound but low interop risk.                                                                                                               |
| #728/#737/#746/#747 `1e05ef6` | admin/identity seam-parity gaps                                                 | Internal seam-parity; verify but likely additive.                                                                                                                                                          |

## Test vectors available (cross-impl, worth wiring up)

Path root: `refs/mdk/crates/cgka-conformance-simulator/vectors/`

- **Byte-level component codec fixtures (directly consumable by marmot-ts codecs):**
  `byte-fixtures/nostr-routing-v1-valid-state.v1.json`,
  `byte-fixtures/nostr-routing-v1-valid-update.v1.json`,
  `byte-fixtures/nostr-routing-v1-invalid-duplicate-relay.v1.json`,
  `byte-fixtures/schema.v1.json`. → assert `src/core/components/nostr-routing.ts` encode/decode
  is byte-identical and rejects the duplicate-relay case.
- **Convergence / scenario vectors (behavioral, higher effort):**
  `convergence-committer-selected.v1.json`, `convergence-witness-selected.v1.json`,
  `admin-policy-update.v1.json`, `group-data-update.v1.json`,
  `group-data-fork-recovery.v1.json`, `concurrent-invite-fork-recovery.v1.json`,
  `invite-member.v1.json`, `three-client-message-exchange.v1.json`,
  `delayed-past-epoch-app-message.v1.json`, `partition-clear-leave.v1.json`,
  plus `manifest.v1.json` and `vectors/incidents/`. → convergence-parity harness for
  `src/engine/fork-recovery.ts` + `tree-convergence.ts` (relevant to findings 5 & 6).
