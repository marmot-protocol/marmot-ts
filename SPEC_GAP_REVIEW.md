# Marmot v2 — Remaining Work

Status: backlog snapshot, 2026-06-19. Branch: `dark-matter`.

This is the live backlog for the marmot-ts → Marmot v2 (darkmatter) migration. It
replaces the earlier spec-gap review and the `planning/` compatibility/adversarial
docs, whose findings have all been resolved (see **Completed baseline**). Pointers
below are module-level on purpose — line numbers drift, so each item names the file
and the governing spec section rather than a brittle line ref.

Legend: **BLOCKER** breaks wire interop with a spec-conformant peer · **MAJOR**
correctness/security · **MINOR** hardening/cleanup · **TRACK** large optional feature.

---

## Completed baseline (done — do not reopen)

The cross-impl handshake, inbound pipeline, convergence engine, and member
lifecycle are spec-conformant and tested. Resolved since the original review:

- **B1–B4** transport/validation blockers: `encoding` tag removed; NIP-65 (kind 10002) KeyPackage discovery + inbox (10050) welcomes; KeyPackage `mls_proposals`
  / `app_components` tags; mandatory account-identity-proof on invite/join/create.
- **B5** convergence status / quiescence-settlement — `Syncing/Resolving/Settled/
Blocked` derived core, engine tracking, settle timer + outbound queue/gating.
- **B6** member departure via MLS `self_remove` (0x000a) + deterministic
  lowest-leaf auto-committer; involuntary-removal `removed` signal.
- **B7** `deferred` disposition emitted for future-epoch / missing-parent commits.
- **M1–M8** welcome/KeyPackage validation, inner-event id+pubkey authorship binding,
  credential x-only-curve check, relay-URL profile, convergence-policy fields +
  witness window, `invalidated`-on-rewind retraction, non-admin self-update/
  self_remove carve-out.
- **m2** `self_remove` (0x000a) now advertised in leaf + required capabilities.

---

## MAJOR — remaining

### M9 — Encrypted media: wire migrated to `encrypted-media-v1`; source-epoch secret retention still open

- **Spec:** `features/encrypted-media.md` — version/scheme label `encrypted-media-v1`
  (MUST-reject legacy); attachments use `locator <kind> <value>` + `ciphertext_sha256`
  - `plaintext_sha256`; `default_blob_endpoints` fallback; source-epoch exporter-secret
    selection.
- **DONE:** the message/imeta + crypto layer is migrated (`src/core/media/`):
  `encrypted-media-v1` scheme label and key derivation/AAD; `MediaAttachment` rebuilt
  around `locators` + `ciphertextSha256`/`plaintextSha256`/`nonce`/`mediaType`/`filename`
  (+ optional `dim`/`thumbhash`); `encodeMediaImetaTag`/`parseMediaImetaTag` with strict
  validation (legacy-version reject, `blurhash` reject, duplicate single-occurrence field
  reject, host-safety on `blossom-v1` locators, unknown-kind locators kept = unfetchable
  not invalid); `image/jpg`→`image/jpeg` alias; `ciphertextSha256` compute on encrypt +
  verify on decrypt; locator fetchability + `default_blob_endpoints` fallback
  (`src/core/media/locator.ts`). Client `GroupMediaService`/`GroupMediaStore` rewired,
  cache keyed by `ciphertextSha256`. The 0x8008 policy codec was already done.
- **REMAINING:** source-epoch media-secret selection. `deriveMediaEncryptionKey` already
  takes the source-epoch `ClientState`, but `GroupMediaService` passes the _live_ state on
  receive. True source-epoch selection needs retained per-epoch exporter secrets plumbed
  from the engine/retained-history into the media service (ties into m4). Until then,
  media from an older epoch than the local tip cannot be decrypted.
- **Note:** the wire format is now interop-complete; only the receive-side epoch-secret
  retention remains.

---

## MINOR — hardening / cleanup

- **m1 — Retire legacy group-message fallback.** `src/core/group-message-crypto.ts`
  still falls back to `src/core/group-message-legacy.ts` on decrypt failure. Receive-only
  leniency, harmless for interop, but off-spec surface to remove for a clean v2 cut.
- **m3 — blossom-image (0x8002) codec absent.** No `blossom-image.ts`; excluded from
  `SUPPORTED_APP_COMPONENT_IDS`. Spec (`app-components/group-blossom-image-v1.md`) defines
  its bytes, but Rust also omits the codec and points groups at `avatar-url` (0x8007,
  done). A group that _requires_ 0x8002 is unjoinable. Decide: implement, or formally
  document as unsupported.
- **m4 — Retained-history pruning vs the pin rule.** `requiredRetainedEpochs` /
  `prunableRetainedEpochs` (`src/core/retained-history.ts`) encode the rule but the live
  pruning path must honor "MUST NOT remove state needed by an active PendingPublish /
  Merging / Recovering / Unrecoverable" (`retained-history.md`). Re-verify the current
  prune site (moved into the engine during the B5 work) honors lifecycle pins.
- **m5 — Eligibility predicate "older than retained anchor".** `isBranchEligible`
  (`src/core/convergence.ts`) enforces only the rollback-horizon delta; the
  "older than retained anchor" guard (`convergence.md`) is applied operationally in the
  engine's `#resolveFork` but not in the reusable predicate.
- **m6 — Content-derived cross-source dedup.** Self-echo dedup uses the Nostr event id and
  only covers own sends; there is no general content-keyed `seen_message_ids` gate
  (`inbound-processing.md`; Rust `seen_message_ids`). Duplicate commits from two relays are
  deduped only incidentally by epoch checks.
- **m7 — URL-normalization parity vectors.** avatar-url (0x8007) / encrypted-media (0x8008)
  codecs assume WHATWG-URL (TS) and the Rust `url` crate normalize identically. No defect
  found, but no conformance vectors cover exotic percent-encoding / IDNA. Add tricky-URL
  round-trip vectors.
- **m8 — Explicit welcome recipient binding.** No "reject welcome not addressed to my
  account" check in `src/core/welcome.ts`; the KeyPackageRef match is a stronger binding,
  but the explicit recipient check is absent.
- **m9 — kind 445 sig-before-decrypt.** `decryptGroupMessageEvent`
  (`src/core/group-message.ts`) decrypts against a single `ClientState` and does not verify
  the Nostr event id/signature before decrypting (spec asks for sig-check first). May be
  covered at the pool/convergence layer — cross-check the inbound-processing path first.

---

## TRACK — larger optional features (in scope, unbuilt)

- **Multi-device (MIP-06).** Entirely absent: extension 0xf2f0, External-Commit carve-out,
  join-PSK exporter, pairing payload. A sizable client feature, orthogonal to single-device
  wire interop.
- **Push notifications (MIP-05).** Missing but optional — groups must work with zero push.

---

## Out of scope / deliberate (not gaps)

- **QUIC transport** (agent text streams): experimental, live-preview-only; baseline
  messaging never needs it. The durable group-policy component `agent-text-stream.quic.v1`
  (0x8006) codec IS implemented; the QUIC runtime/broker is correctly absent.
- **App / tooling crates** — `marmot-app`, `cli`, `marmot-markdown`, `marmot-forensics`,
  `marmot-uniffi`, `storage-sqlite` (concrete backend), `agent-*`,
  `cgka-conformance-simulator` — not library scope.

---

## Suggested sequencing

1. **M9** — close the last single-device wire-interop gap (encrypted-media-v1).
2. **m1, m4, m5, m6** — cleanup + convergence/retention hardening that tightens the
   already-shipped engine.
3. **m3, m7, m8, m9** — codec/validation parity and conformance vectors.
4. **Multi-device / push** — separate tracks, only if/when product needs them.
