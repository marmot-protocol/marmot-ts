# Spec Gap Review: marmot-ts vs darkmatter Marmot v2

Status: review snapshot, 2026-06-09. Branch: `dark-matter`.

This document records the gap between the current `@internet-privacy/marmot-ts` library and the
darkmatter / Marmot v2 spec (`darkmatter/spec/`), cross-checked against the Rust reference
(`darkmatter/crates/`). It is a fix backlog: each finding has an ID, a status, file:line evidence,
a severity, and a one-line fix direction.

## How to read this

- **BLOCKER** — breaks wire interop with a spec-conformant Rust/OpenMLS peer (handshake or convergence
  fails outright, or a MUST-reject rule is violated such that the two stacks disagree on validity).
- **MAJOR** — violates a spec MUST or diverges in behavior, but does not necessarily break the initial
  handshake; correctness/security/validation gaps.
- **MINOR** — spec deviation with low real-world interop risk, or polish.

Severity is about interop/correctness, not effort.

## Context: why this contradicts the prior "done" record

The prior migration plan and the project memory recorded phases 0–10 as complete and "byte-matched to
Rust." That was accurate at the time against the _then_ spec. Two things changed:

1. **The spec is a living draft and moved.** Several blockers below (the `encoding`-tag prohibition,
   KeyPackage relay discovery on kind 10002, the required KeyPackage tag set) look like spec decisions
   made after the migration's byte-matching work.
2. **Several "done" items are pure cores that were ported correctly but never fully wired into the live
   path.** The deterministic hearts (convergence selection, lifecycle table, late-commit classifier) are
   faithful 1:1 Rust ports and well-tested; the surrounding live system (quiescence/settlement, member
   departure, deferred/invalidated dispositions) is missing or incomplete.

Net: the library does **not** currently interop with a spec-conformant peer.

## What is solid (verified correct, no action)

- Marmot binary profile (QUIC varints, minimal encoding) — `src/core/binary.ts`.
- All 8 app-component **codecs** (field order, varint framing, golden vectors) — `src/core/components/*`.
- Account-identity-proof **byte format** + BIP-340 signing digest — `src/core/account-identity-proof.ts`.
- Pure deterministic cores: convergence branch selection/tie-breaks, lifecycle transition table,
  late-commit classifier, error taxonomy, registry IDs — `src/core/{convergence,group-lifecycle,retained-history,inbound}.ts`.
- Nostr kind 445 group message AEAD (exporter key, nonce‖ciphertext, base64) — `src/core/group-message.ts`.
- NIP-59 welcome gift-wrap (1059 → 13 → 444) — `src/utils/nostr.ts`, `src/core/welcome.ts`.
- Required ciphersuite 0x0001 + required_capabilities extension (0xf2f1) — `src/core/{default-capabilities,capabilities}.ts`.

---

# BLOCKERS

### B1 — `encoding` tag emitted and required (spec forbids both)

- **Status:** FIXED — no longer emitted on KeyPackage/welcome; receive always decodes standard base64.
- **Spec:** `transports/nostr.md:39-40` — "A sender MUST NOT add an `encoding` tag for any event shape …
  A receiver MUST NOT switch decoders based on an `encoding` tag."
- **Code:** emits `["encoding","base64"]` on KeyPackage (`src/core/key-package-event.ts:291`) and welcome
  rumor (`src/core/welcome.ts:71`); **requires** it on receive — `getKeyPackage` throws if `encoding !== "base64"`
  (`src/core/key-package-event.ts:114-117`), `getWelcome` throws if missing (`src/core/welcome.ts:132-134`).
- **Impact:** bidirectional non-interop. TS rejects every spec-conformant KeyPackage/welcome (which carry no
  `encoding` tag); TS's own events carry a forbidden tag.
- **Fix:** stop emitting the tag; stop requiring it on receive; always decode content as standard base64.

### B2 — KeyPackage relay discovery on kind 10051 (spec uses NIP-65 kind 10002)

- **Status:** FIXED — retired the 10051 `key-package-relay-list` module; added NIP-65 (kind 10002, `r` tags) helpers for KeyPackage discovery and inbox (kind 10050, `relay` tags) helpers for welcomes; transport binding now carries `nip65RelayListKind`/`inboxRelayListKind`.
- **Spec:** `transports/nostr.md:171,191,206`, `foundation/registries.md:69` — KeyPackage relay discovery
  uses the account's **kind 10002** NIP-65 relay list; "There is no dedicated KeyPackage relay list."
- **Code:** centers discovery on **kind 10051** — `src/core/protocol.ts:8` (`KEY_PACKAGE_RELAY_LIST_KIND=10051`),
  `src/core/key-package-relay-list.ts` (whole file), `src/core/transport.ts:58`, doc'd in
  `src/client/nostr-interface.ts:75`.
- **Impact:** cross-impl invite discovery can't locate each other's KeyPackages.
- **Fix:** publish/fetch KeyPackages against kind 10002 (`r` tags); retire the 10051 relay-list module or
  repurpose to read NIP-65. Also re-point `getUserInboxRelays` (push inbox is kind 10050, separate).

### B3 — KeyPackage event missing required `mls_proposals` and `app_components` tags

- **Status:** FIXED — emit derives `mls_proposals` from the leaf's advertised proposals and `app_components` from `SUPPORTED_APP_COMPONENT_IDS`.
- **Spec:** `transports/nostr.md:159-161` — KeyPackage event (kind 30443) MUST carry `mls_extensions`,
  `mls_proposals`, and `app_components` tags.
- **Code:** `src/core/key-package-event.ts:285-307` emits `d`, `mls_protocol_version`, `mls_ciphersuite`,
  `mls_extensions`, `i`, optional `client`/`relays`, plus the forbidden `encoding` — but **not**
  `mls_proposals` or `app_components`. Rust rejects empty `mls_proposals`/`app_components`
  (`crates/cgka-engine/src/key_package.rs:61-70`).
- **Fix:** add both tags, sourced from the leaf's advertised proposal ids and supported app-component ids.

### B4 — Account identity proof not enforced as mandatory

- **Status:** FIXED — invite now always verifies the invitee leaf proof (no `hasProof` escape); join verifies every member leaf via `verifyAllLeafAccountIdentityProofs`; group creation signs the creator's own leaf proof (`accountProofSigner` threaded through `GroupsManager`).
- **Spec:** `foundation/identity.md` + `foundation/account-identity-proof-v1.md` §Validation — clients MUST
  reject a member leaf or KeyPackage whose proof is missing/invalid. "There is no legacy fallback."
- **Code:** `src/client/group/proposals/invite-user.ts:23-29` verifies only `if (hasProof)`, with comment
  "Leaves without the proof are still allowed for backwards compatibility." Join path
  `src/client/marmot-client.ts:280-289` does not verify existing member leaves post-join. Rust validates
  every leaf (`crates/cgka-engine/src/account_identity_proof.rs`).
- **Impact:** TS adds/joins groups containing proof-less leaves that Rust rejects → membership-validity
  disagreement.
- **Fix:** make the proof mandatory on add and on join (verify every leaf in the ratchet tree after join);
  remove the backwards-compat escape.

### B5 — Convergence status / quiescence-settlement model entirely missing

- **Status:** MISSING
- **Spec:** `protocol-core/group-state.md` §Convergence status — `Syncing`/`Resolving`/`Settled`/`Blocked`
  derived from a `settlement_quiescence_ms` window; outbound app payloads held while unresolved.
- **Code:** grep across `src/` finds zero `Syncing`/`Resolving`/`Settled`/`Blocked`/`ConvergenceStatus`/
  `quiescence`. Ingest converges eagerly per-batch with no settle window. Rust: `canonicalization.rs`
  (`ConvergenceStatus`, `convergence_status_for_result`). Outbound send is ungated —
  `src/client/group/marmot-group.ts:1104-1167` (`sendApplicationRumor`).
- **Impact:** no settle-then-release spine; interop timing diverges; spec's status/lifecycle couplings
  can't be expressed.
- **Fix:** introduce a convergence-status state machine driven by `settlement_quiescence_ms`; gate outbound
  app payloads on `Settled`.

### B6 — Member departure: plain `Remove` instead of MLS `SelfRemove`; no deterministic auto-committer

- **Status:** DIVERGENT (SelfRemove) + MISSING (auto-committer)
- **Spec:** `protocol-core/member-departure.md:11-13` (MLS SelfRemove proposal type), `:33-44` (deterministic
  committer = eligible members minus leaver minus not-allowed-to-commit, lowest leaf index), `:49-57`
  (validation: admin must leave admin-set first, must not leave group with no active admin, proposal targets
  sender, leaver must not commit).
- **Code:** `src/client/group/proposals/leave-group.ts:20-37` builds a self-targeted `defaultProposalTypes.remove`.
  ts-mls has no SelfRemove proposal type. No auto-committer anywhere in `src/` (grep `auto.?commit`/`lowest.*leaf`
  → none). None of the SelfRemove validation rules are present. Rust: `auto_committer.rs`.
- **Impact:** departure wire shape differs from spec peers; concurrent leaves fork (no deterministic committer).
- **Fix:** needs a SelfRemove proposal type (likely upstream ts-mls work) + a deterministic auto-committer +
  the departure validation rules. Largest single subsystem gap alongside B5.

### B7 — `deferred` disposition declared but never emitted

- **Status:** FIXED (2026-06-18, live engine path). NOTE: the original file:line evidence below points at the
  now-deleted monolithic `marmot-group.ts`; the gap had been relocated into `src/engine/` and was fixed there.
- **Spec:** `protocol-core/inbound-processing.md:51-63` — future-epoch / missing-parent / group-busy inputs are
  `deferred` (with reason) and retried when state becomes available; not terminal.
- **Fix applied:** added a `DeferredIngestResult` kind (`src/engine/types.ts`) + a `deferred` arm in
  `ingestResultDisposition` (`src/engine/ingest-disposition.ts`). In `src/engine/ingest.ts` a commit whose
  framed epoch is `> current + 1` is now recorded as `deferred(missing_parent)` instead of being pushed to the
  fork pool and the `unreadable` list; it still rides the in-batch retry set, but the two terminal yield points
  (max-retries, no-progress) surface it as `deferred`, not `stale: invalid_encoding`. The session-layer
  `IngestResult` mirror (`src/client/session/group-session.ts`) gained the matching variant. Tests:
  `src/engine/__tests__/ingest-deferred.test.ts` (end-to-end pipeline → `deferred: missing_parent`) +
  `ingest-disposition.test.ts` (mapping). STILL NOT EMITTED: `future_epoch` (undecryptable app messages can't be
  distinguished from garbage at the peel boundary) and `group_busy` (no PendingPublish/Merging inbound gate yet).
- **Historical evidence (stale paths):** `src/core/inbound.ts:63-77` declared `deferred` + reasons, but the old
  `ingestResultDisposition` (`marmot-group.ts:197-221`) had no `deferred` arm; inputs went onto `unreadable` and
  after `maxRetries` mapped to terminal `stale: invalid_encoding`.
- **Impact:** retryable inputs were terminally mis-classified as malformed.

---

# MAJOR

### M1 — Welcome rumor validation missing (`e` / `relays`)

- **Status:** FIXED — `e` is unconditional on send; receive rejects missing/non-32-byte-hex `e` and missing/empty `relays`.
- **Spec:** `transports/nostr.md` §Welcome delivery — rumor MUST carry an `e` tag (32-byte hex KeyPackage event
  id) and a non-empty `relays` tag; reject otherwise. Rust peeler rejects all three failures
  (`transport-nostr-peeler` `peeler.rs:185-191`).
- **Code:** `src/core/welcome.ts:63-75` emits `e` only conditionally (`if (keyPackageEventId)`); receive side
  `:87-98` reads but never rejects missing `e`, empty `relays`, or non-32-byte-hex `e`.
- **Fix:** make `e` unconditional on send; validate `e` (32-byte hex) and non-empty `relays` on receive.

### M2 — KeyPackage `i` ref not verified against decoded KeyPackage

- **Status:** FIXED (2026-06-18).
- **Spec:** `transports/nostr.md` §KeyPackage publication — receivers MUST verify the `i` tag (hex KeyPackageRef)
  against the decoded KeyPackage.
- **Fix applied:** `KeyPackageStore.addPublished` (`src/client/key-package-store.ts`) now decodes the body,
  recomputes the KeyPackageRef via `calculateKeyPackageRef`, and throws on mismatch with the resolved `i`-tag
  key (case-insensitive). This is the single chokepoint for both `KeyPackageManager.track` (untrusted, receive
  side — a throw makes `track` return `false`) and self-published events (always consistent). The duplicate
  decode in the no-entry branch was removed (the verified body is reused). Test:
  `key-package-manager.test.ts` "rejects an event whose `i` tag does not match the decoded KeyPackage".

### M3 — Inner app-event `id`/`pubkey` not validated against MLS sender

- **Status:** FIXED (2026-06-18, live engine path).
- **Spec:** `foundation/application-messages.md` §Encoding (reject `id` ≠ canonical Nostr event id) +
  `foundation/identity.md` §Application content (inner `pubkey` validated against the authenticated MLS sender);
  both failures classify as `invalid_encoding` per `foundation/errors.md` (the inner event is unsigned, so not
  `invalid_signature`; authorship forgery is a decode rule, not `authorization_failed`).
- **Fix applied:** `deserializeApplicationData` (`src/core/application-rumor.ts`) is now a strict decoder —
  exactly the six NIP-01 members (`id, pubkey, created_at, kind, tags, content`; no `sig`/unknown members) and
  the carried `id` must equal the canonical id recomputed via `getEventHash`. New
  `verifyApplicationRumorAuthorship(payload, senderHex)` adds the MLS-sender binding. The engine
  (`src/engine/ingest.ts` `isAuthenticApplicationMessage`) resolves the sender leaf → credential identity via
  `getCredentialFromLeafIndex`/`getCredentialPubkey` and rejects a forged id or mismatched author as a new
  `skipped` reason `invalid-app-payload` → `invalid_encoding`; the MLS ratchet still advances (the message was
  MLS-authenticated) but the payload is never delivered/saved. Tests:
  `group-session.test.ts` "application-message authorship (M3)" (forged author + non-canonical id rejected).
  KNOWN GAP: duplicate-key rejection is not enforced (JSON.parse is last-write-wins); not a forgery vector since
  the id + author bind the surviving values, but it is a residual non-canonical-input deviation.

### M4 — Credential identity not curve-validated

- **Spec:** `foundation/identity.md` / `key-packages.md` — reject credentials whose identity is not a valid
  x-only secp256k1 public key. Rust: `identity.rs::validate_credential_identity` (`lift_x` on-curve).
- **Code:** `src/core/auth-service.ts:14-22` checks only `length === 32`; `src/core/credential.ts:21-37` checks
  only 64-hex format. No curve-point check anywhere.
- **Fix:** add an x-only secp256k1 `lift_x` / on-curve check in `marmotAuthService` (and/or `getCredentialPubkey`).

### M5 — nostr-routing relay-URL validation too loose

- **Spec:** `transports/nostr.md:43-51` relay-URL profile — host present; username/password/fragment absent;
  ≤512 bytes; ws/wss. Rust: `validate_nostr_relay_url` (`crates/traits/src/app_components.rs:737-758`) rejects
  `wss://user@relay`, `wss://relay#frag`, `wss://` (no host).
- **Code:** `src/core/components/nostr-routing.ts:44-97` delegates to `src/utils/relay-url.ts:9-18`, which checks
  only ws/wss scheme + parseability.
- **Impact:** TS encodes/accepts canonical signed routing state that Rust rejects → divergent group-state acceptance.
- **Fix:** enforce host-present + no-userinfo + no-fragment + 512-byte cap in the validator used by nostr-routing
  (don't reuse the loose generic `isValidRelayUrl`, or harden it). Same profile gap noted at `src/utils/relay-url.ts`
  for general relay handling.

### M6 — ConvergencePolicy missing 3 fields + app-payload retention window unenforced

- **Spec:** `protocol-core/convergence.md:24-35` (policy fields incl. `policy_version`,
  `app_payload_past_epoch_limit`, `settlement_quiescence_ms`); `:104` + `retained-history.md:41-49` (app messages
  older than the window expire and MUST NOT count as witnesses).
- **Code:** `src/core/convergence.ts:21-30` defines only 4 of 7 fields; `isAppPayloadExpired`
  (`src/core/retained-history.ts:71-77`) is never called from the live path; witness gathering
  (`src/client/group/marmot-group.ts:606-648`) applies no past-epoch limit. Rust:
  `canonicalization.rs` (`is_app_payload_expired`, `app_message_past_epoch_limit`).
- **Impact:** stale app messages can still count as convergence witnesses → branch scores diverge from Rust.
- **Fix:** add the 3 policy fields (or a `CanonicalizationPolicy` wrapper); enforce `isAppPayloadExpired` in witness
  gathering and app-message acceptance.

### M7 — `invalidated` disposition not emitted on rewind

- **Spec:** `protocol-core/inbound-processing.md:102-110` + `convergence.md:189-190` — app payloads that decrypted
  only on an abandoned branch MUST be reported `invalidated` (+ a state notification). Rust:
  `distributed_convergence.rs:328-344` (`AppMessageInvalidated`).
- **Code:** no `invalidated` arm in `ingestResultDisposition` (`src/client/group/marmot-group.ts:197-221`); rewinds
  in `#resolveFork` never report invalidated payloads.
- **Fix:** track app payloads applied on the losing branch and emit `invalidated` on rewind.

### M8 — Non-admin outbound commits fully blocked

- **Spec:** `protocol-core/group-messaging.md:50-56` — non-admins may commit a self-update-only commit and a
  SelfRemove-only commit.
- **Code:** `src/client/group/marmot-group.ts:1245-1247` hard-rejects every non-admin in `commit()`. (Inbound
  policy `createAdminCommitPolicyCallback` at `:380-387` does accept these shapes — so the gap is outbound only.)
- **Fix:** allow non-admin `commit()` for self-update-only and SelfRemove-only commit shapes.

### M9 — Encrypted media still on MIP-04 wire, not `encrypted-media-v1`

- **Spec:** `features/encrypted-media.md` — version/scheme label `encrypted-media-v1` (MUST-reject legacy);
  attachments use `locator <kind> <value>` + `ciphertext_sha256` + `plaintext_sha256`; `default_blob_endpoints`
  fallback; source-epoch exporter-secret selection.
- **Code:** `src/core/media.ts:27,38,142` uses `mip04-v2` scheme/version and NIP-92 `url`/`x` attachments; key
  derivation reads only the live `clientState` (no source-epoch selection). The group-policy component
  `marmot.group.encrypted-media.v1` (0x8008) codec IS done (`src/core/components/encrypted-media.ts`); the
  message/imeta layer is not migrated. Flagged pending during the migration (Phase 10).
- **Fix:** migrate the imeta/message layer to `encrypted-media-v1`; add source-epoch media-secret selection and
  blob-endpoint fallback.

---

# MINOR

### m1 — Legacy group-message fallback decryption still present

- `src/core/group-message.ts:83-95` falls back to `decryptLegacyGroupMessageEventContent`
  (`src/core/group-message-legacy.ts`) on failure. Receive-only leniency; harmless for interop but off-spec
  surface to retire for a clean v2 cut.

### m2 — `self_remove` (0x000a) proposal capability not advertised

- `src/core/capabilities.ts:23-50` doesn't advertise `self_remove`. `key-packages.md` lists it; but the Rust
  engine baseline (`capabilities.rs`) also omits it, so this is spec-vs-both-impls, low interop risk. Related to B6.

### m3 — blossom-image (0x8002) has no codec

- No `blossom-image.ts`; excluded from `SUPPORTED_APP_COMPONENT_IDS` (`src/core/components/ids.ts:69-77`). The
  spec (`app-components/group-blossom-image-v1.md`) DOES specify its bytes, but Rust also omits the codec and
  points groups at `avatar-url` (0x8007, implemented). Consequence: a group that _requires_ 0x8002 is unjoinable.
  Decide: implement, or formally document as unsupported.

### m4 — Retained-history pruning ignores pin rule

- `requiredRetainedEpochs`/`prunableRetainedEpochs` (`src/core/retained-history.ts:85-113`) are correct but unused;
  live pruning is an inline floor loop (`src/client/group/marmot-group.ts:544-548`) that doesn't honor "MUST NOT
  remove state needed by an active PendingPublish/Merging/Recovering/Unrecoverable" (`retained-history.md:53-58`).
  Low real-world risk.

### m5 — Eligibility predicate doesn't enforce "older than retained anchor"

- `isBranchEligible` (`src/core/convergence.ts:190-198`) enforces only the rollback-horizon delta; the
  "older than retained anchor" guard (`convergence.md:102`) is enforced operationally in `#resolveFork` but not in
  the reusable predicate.

### m6 — Cross-source dedup keyed on transport id, not content

- Self-echo dedup uses Nostr event id (`#sentEventIds`, `src/client/group/marmot-group.ts:469,1789`) and only
  covers own sends; no general content-derived dedup gate (`inbound-processing.md:24-34`; Rust `seen_message_ids`).
  Duplicate commits from two relays are deduped only incidentally by epoch checks.

### m7 — URL normalization cross-impl parity unproven (avatar-url 0x8007, encrypted-media 0x8008)

- Codecs rely on WHATWG-URL (TS) vs the Rust `url` crate producing identical normalized output. No defect found,
  but no conformance vectors cover exotic percent-encoding/IDNA URLs. Add tricky-URL round-trip vectors.

### m8 — Welcome recipient binding not explicit

- No "reject welcome not addressed to my account" check in `src/core/welcome.ts`; the KeyPackageRef match in
  `src/client/marmot-client.ts:230-308` is a stronger binding, but the explicit recipient check is absent.

### m9 — kind 445 receive: no event-sig-before-decrypt, single-state decrypt

- `decryptGroupMessageEvent` (`src/core/group-message.ts:66-95`) decrypts against one `clientState` and does not
  verify the Nostr event id/signature before decrypting (spec asks for sig-check first). May be enforced at the
  pool/convergence layer — cross-check with the inbound-processing path before acting.

---

# Out of scope / deliberate (not gaps)

- **QUIC transport** (agent text streams): out of library scope. Spec makes it experimental, live-preview-only;
  baseline messaging never needs it. The durable group-policy component (`agent-text-stream.quic.v1`, 0x8006) IS
  implemented (`src/core/components/agent-text-stream.ts`); the QUIC runtime/broker is correctly absent.
- **Push notifications** (MIP-05): missing but optional — groups must work with zero push support.
- **Multi-device** (MIP-06): entirely absent, in-scope-but-unbuilt (ext 0xf2f0, External-Commit carve-out,
  join-PSK exporter, pairing payload). A sizable client feature, orthogonal to single-device wire interop.
- App/tooling crates — `marmot-app`, `cli`, `marmot-markdown`, `marmot-forensics`, `marmot-uniffi`,
  `storage-sqlite` (concrete backend), `agent-*`, `cgka-conformance-simulator` — are not library scope.

---

# Recommended sequencing

1. **Transport blockers B1–B3** (+ B4): small, localized envelope/validation changes that currently make every
   cross-impl handshake fail before any protocol logic runs. Cheapest, highest-impact. Good first commit(s).
2. **B7 `deferred` disposition** + **M1/M2 welcome+KeyPackage validation**: localized correctness fixes.
3. **M3/M4/M5/M6**: validation/security hardening (inner-event authorship, credential curve check, relay-URL
   profile, app-payload retention in witnessing).
4. **B5 convergence status / quiescence** and **B6 SelfRemove + auto-committer**: genuinely new subsystems; the
   biggest lifts. B6 likely needs upstream ts-mls SelfRemove support.
5. **M9 encrypted-media v2 wire**, then optional features (push, multi-device) as separate tracks.

# Verification provenance

Findings produced by five parallel surface-analysis agents (foundation, protocol-core, app-components,
transports, features/scope), each reading the spec docs + Rust reference + `src/`. The highest-severity
transport claims (B1–B3) were independently re-verified against the spec text and source in the main session.
The pure-core ports (convergence/lifecycle/classifier) were confirmed correct, not just assumed.
