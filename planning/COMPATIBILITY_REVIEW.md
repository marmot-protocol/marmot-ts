# marmot-ts ↔ darkmatter Compatibility Review

_Date: 2026-06-18 · Branch: dark-matter · Reference: `darkmatter/crates/*` (Rust)_

Companion to `2026-06-16-adversarial-module-review.md`. That document tracked a
structural decomposition pass; this one records how the resulting modules — and
the protocol-critical behavior around them — line up against the darkmatter Rust
reference, plus the divergences the review found and fixed.

"Fork-causing" below means: a difference in encoded bytes, decode strictness,
ordering, or validation that would make the same MLS commit / component state
**accepted by one implementation and rejected by the other**, desynchronizing
the group. These are the highest-severity interop bugs.

## Method

- Mapped each marmot-ts module touched by the decomposition to its darkmatter
  crate/module (the `traits`, `cgka-engine`, `transport-nostr-{adapter,peeler}`
  crates).
- Read the protocol-critical app-component codecs in
  `src/core/components/*` side by side with
  `darkmatter/crates/traits/src/app_components/*` (+ the engine-side
  `cgka-engine/src/app_components.rs`), comparing byte layout, ordering,
  length bounds, and decode strictness against the authoritative byte vectors
  in `crates/traits/src/app_components/tests.rs`.

## 1. Decomposition parity — modules map cleanly to darkmatter

The splits land on the same seams darkmatter draws:

| marmot-ts (after this work) | darkmatter analog | Notes |
| --- | --- | --- |
| `core/group-message-crypto.ts` / `group-event.ts` | `transport-nostr-peeler` peel/wrap vs adapter event build | peeler/adapter split |
| `core/welcome-event.ts` vs `welcome-join.ts` | `transport-nostr-peeler` `peel_welcome` vs `cgka-engine` `do_join_welcome` | Rust hard-splits codec from MLS join across **crates** — TS now splits across files |
| `core/key-package-event-{decode,encode,delete}.ts` | adapter `key_package.rs` build vs engine/app reads | adapter-builds / engine-reads |
| `core/components/host-safety.ts` + `url.ts` + `bytes.ts` | `traits/app_components/host_safety.rs` | Rust centralizes the classifiers and reuses them from the URL validators (avatar + encrypted-media) — TS now matches that shape |
| `core/media/crypto.ts` | `marmot-app/src/media/crypto.rs` | isolates the `randomBytes`/cipher site |
| `client/group-registry.ts` + `group-factory.ts` | (no direct analog) | Rust uses a builder + single owning session struct, not a registry/factory; this is a TS-land adaptation, explicitly "adapted, not copied" |
| `GroupSession.leave()` | `cgka-engine` `message_processor/send.rs` `do_send_leave` | "leave is a SendIntent" |
| `KeyPackageManager.selectForWelcome()` + `GroupsManager.joinFromWelcome()` | `cgka-engine` `do_join_welcome` | KeyPackageRef match + MLS join moved out of the composition root into the group/key-package layers |

## 2. Wire-format / validation parity — divergences found and FIXED

All of the following were cross-implementation fork risks; all are fixed on this
branch with regression tests pinned to darkmatter's authoritative byte vectors.

### encrypted-media (`0x8008`) — three divergences (critical)
Confirmed against `crates/traits/src/app_components/{encrypted_media.rs,tests.rs}`:

1. **Endpoint vector layout (darkmatter #171).** TS wrapped each
   `BlobStoreEndpointV1` in its own length prefix; darkmatter encodes the bare
   concatenation `opaque(locator_kind) ++ opaque(base_url)` under one outer
   vector length, **no** per-item wrapper. The layouts were mutually
   undecodable. Fixed encoder + decoder; pinned to darkmatter's authoritative
   vector (`https://blossom.primal.net/`).
2. **Query strings (darkmatter #374).** TS rejected endpoint URLs carrying a
   query; darkmatter accepts and preserves them (rejecting them forked commit
   acceptance). Fixed.
3. **Trailing slash.** TS stripped the WHATWG-normalized trailing `/`;
   darkmatter keeps it (the serializer's output is the stored form). Fixed.
4. **Repairing decoder (the originally-flagged item).** `decodeEncryptedMediaPolicyV1`
   re-ran producer normalization, silently repairing non-canonical bytes.
   It is now a strict validator: rejects non-canonical case/dupes/non-normalized
   URLs/trailing bytes, never repairs (`foundation/canonical-encoding.md`
   "Canonical decoding").

### nostr-routing (`0x8004`) — relay URL validation (critical)
`validate_nostr_relay_url` (`routing.rs`) rejects non-`ws`/`wss` scheme, missing
host, **credentials**, and **fragment** — on both encode and decode. TS only
checked the scheme, so `wss://user@relay.example` / `wss://relay.example#frag`
were accepted where darkmatter rejects (it has an explicit negative test
vector). Fixed in `nostr-routing.ts:validateRelay`.

### avatar-url (`0x8007`) — non-UTF-8 hint handling (high)
The darkmatter decoder treats a non-UTF-8 `dim`/`thumbhash` hint as **absent**
(`String::from_utf8(..).ok()`) and explicitly must not reject it; the TS decoder
was fatal on invalid UTF-8 → it rejected state darkmatter accepts. Fixed: hint
**presence** is decided on the raw bytes (so empty-url + hint bytes still
rejects), but UTF-8 conversion is non-fatal.

### agent-text-stream (`0x8006`) — frame cap (low)
TS capped `max_plaintext_frame_len` at 65536; darkmatter caps at 65519 (one QUIC
datagram). Accept/reject forked only for values in `65520..=65536` (no default
hits it). Fixed.

### binary reader (not a component, but adjacent)
`BinaryReader.vector()` now copies its body (`.slice()`) instead of aliasing the
backing buffer via `.subarray()`, matching `bytes()`. No behavior change today;
removes a latent aliasing footgun.

## 3. Components confirmed byte/validation-identical (no change needed)

- **group-profile (`0x8001`)** — field order, var-bytes framing, 256/4096
  limits, strict trailing-byte + UTF-8 rejection all match
  `cgka-engine/src/app_components.rs`.
- **admin-policy (`0x8003`)** — raw-byte ascending sort + dedup, 32-byte
  framing, strict decode (sorted/unique/`len%32==0`) match `encode_admin_policy`
  / `decode_admin_policy`.
- **message-retention (`0x8005`)** — 8-byte big-endian `u64`, seconds, `0` =
  disabled; TS strict-8-byte decode matches the authoritative engine validator
  `validate_message_retention`.
- **app-components-list (`0x0001`)** — varint length + sorted/unique `u16` ids;
  matches `codec.rs` `encode/decode_components_list`, including duplicate /
  trailing-byte / odd-length rejection.
- **media (MIP-04 v2)** — key derivation + AEAD AAD already validated by the
  existing media tests; isolated into `media/crypto.ts` without behavior change.
- The QUIC-varint primitives in `binary.ts` encode minimally and reject
  non-minimal encodings on decode, matching `decode_quic_varint`.

## 4. Behavioral findings (NOT fixed — flagged for a decision)

These are protocol-behavior divergences, not codec bugs. They do not cause a
codec fork but are worth an explicit decision.

- **Leave semantics.** darkmatter `do_send_leave` is **SelfRemove-only**
  (`MlsGroup::leave_group_via_self_remove`) and **blocks admins**
  (`EngineError::AdminCannotSelfRemove`). marmot-ts `GroupSession.leave()` emits
  ordinary Remove proposals targeting the member's own leaf (for another admin
  to commit) and does **not** block an admin from leaving. Functionally a member
  still departs, but the proposal type and the admin guard differ. Revisit if/when
  ts-mls exposes SelfRemove, and consider an admin-self-remove guard.
- **Join-from-welcome matching.** darkmatter performs KeyPackageRef→private-bundle
  matching **inside** the engine via OpenMLS's storage provider; marmot-ts now
  does explicit candidate selection in `KeyPackageManager.selectForWelcome()`
  (ref-matches-first) before handing each candidate to `joinGroup`. Functionally
  equivalent; the matching is explicit rather than provider-implicit.

## 5. Structural gaps — deferred (net-new subsystems, not reshapes)

These are real architectural differences from darkmatter, but building them is
new feature work with no current consuming use case, so they are **not**
implemented here. Recorded with references for a future transport-layer pass:

- **No `TransportMessage`/`TransportEnvelope` + route-then-peel stage.**
  darkmatter `traits/src/transport.rs` defines a `TransportEnvelope`
  (`GroupMessage { transport_group_id }` | `Welcome { recipient }`) that routes
  both message classes **before** peeling, and `TransportPeeler`
  (`traits/src/peeler.rs`) carries both `peel_group_message` and `peel_welcome`.
  marmot-ts `NostrGroupPeeler` carries only group methods; welcome wrap/peel
  lives separately in `client/transport/nostr/welcome-delivery.ts`. Adding a
  unified envelope + a peeler that carries welcomes would align the seam.
- **Publish-only key-package / welcome transport.** The raw
  `NostrNetworkInterface` does expose `request()` (a read side), but there is no
  dedicated **fetch** abstraction for key packages or welcomes matching
  darkmatter's `DirectoryRelayFetcher`
  (`marmot-app/src/relay_plane/directory.rs`) /
  `NostrSubscription::AccountInbox` (`transport-nostr-adapter`). The TS
  `KeyPackagePublisher` and `NostrWelcomeDelivery` publish but do not fetch.

## Summary

- 9/9 ranked decomposition items complete; modules map cleanly to darkmatter's
  proven seams (with the registry/factory split being an explicit TS adaptation).
- **5 cross-implementation fork bugs found and fixed** (4 in encrypted-media
  counting the layout/query/slash/strict-decode, plus nostr-routing, avatar-url,
  agent-text-stream — the encrypted-media set + 3 others), each pinned to a
  darkmatter authoritative vector or negative test.
- 6 components confirmed byte-identical.
- 2 behavioral divergences (leave semantics, join matching) flagged for a
  decision; 2 transport-architecture gaps documented as scoped follow-ups.
- `pnpm compile` clean · 486 tests pass · prettier clean.
