# Adversarial Module Review — marmot-ts

_Date: 2026-06-16 · Branch: dark-matter_

A full adversarial pass over the TypeScript library to find code doing too much
that should be split into more focused modules. Reference inspiration:
`darkmatter/crates/*` (the Rust implementation), **adapted** for a library that
must run in the web browser as well as natively — not copied, since the Rust
crates are native-only.

## Cross-cutting theme

marmot-ts already factors its **pure, stateless logic** cleanly — `core/convergence.ts`,
`core/retained-history.ts`, `core/group-lifecycle.ts`, `core/inbound.ts`, the
per-component codecs, `binary.ts`, and the small interface modules
(`group-effects.ts`, `nostr-interface.ts`, `transport.ts`) are single-purpose
and map almost 1:1 to darkmatter's `traits` crate. Leave those alone.

The problems concentrate in **stateful orchestrators and transport conflation**.
Where darkmatter draws three hard lines — **adapter** (build/sign/publish),
**peeler** (crypto wrap/unwrap), **storage** (persist) — marmot-ts repeatedly
fuses two or three into one large class or file.

Every proposed split lands on **already-injected dependencies**
(`GenericKeyValueStore`, `NostrNetworkInterface`, `CryptoProvider`,
`EventSigner`), so none introduces browser/native risk — most _reduce_ it by
collapsing each native-sensitive concern (signing, `randomBytes`, relay publish,
media crypto) into one auditable module.

## Ranked refactor opportunities

### 1. `src/engine/group-engine.ts` — 1130-line `MarmotGroupEngine` (highest payoff) — DONE

_Completed: `group-engine.ts` now 425 lines; extracted `engine/retained-store.ts`
(`RetainedHistoryStore`), `engine/fork-recovery.ts` (`ForkRecovery`), and
`engine/ingest.ts` (`ingestEnvelopes`). Compile + engine tests pass._

One class does seven jobs: send-intents (`send`, 155–306), publish lifecycle
(`confirmPublished`/`publishFailed`, 308–345), retained-state store
(`#retainAppliedCommit` + the four `#retained*`/`#applied*`/`#branch*` maps),
**fork recovery** (`#buildBranches` 438–585, `#resolveFork` 592–656, ~225 lines),
admin-callback wiring (658–668), commit sorting (670–686), and the **440-line
recursive ingest generator** (`#ingestRaw`, 688–1129).

darkmatter splits exactly this into `message_processor/{ingest,send,store}.rs`,
`fork_recovery.rs`, `epoch_manager.rs`. The pure scoring (`convergence.ts`) is
_already_ separated correctly — this extends that seam to the stateful half.

**Plan:**

- `engine/retained-store.ts` — `RetainedHistoryStore`: owns the epoch→state and
  epoch→commit maps + pruning (darkmatter `epoch_manager.rs` / `message_processor/store.rs`).
- `engine/fork-recovery.ts` — `ForkRecovery`: `buildBranches` + `resolveFork`,
  operating on a `RetainedHistoryStore`, returning a resolution the engine
  applies (lifecycle stays in the engine). Branch tip/chain `WeakMap`s become
  per-call local state (darkmatter `fork_recovery.rs`).
- `engine/ingest.ts` — `ingestEnvelopes` generator over an `IngestContext`
  (darkmatter `message_processor/ingest.rs`).
- `MarmotGroupEngine` shrinks to a coordinator over send + lifecycle + the three units.

### 2. `src/client/key-package-manager.ts` — 857 lines, three fused darkmatter seams — DONE

Header admits "Storage helpers (inlined from KeyPackageStore)." Fuses storage
(`store*` CRUD, 307–473), Nostr publish/sign transport (`create`/`rotate`/`purge`,
494–681, the only `signer.signEvent`+`network.publish` site), and pure helpers
(event dedup 103–139, four error classes 149–193). Split into
`key-package-events.ts` (pure), re-extract `KeyPackageStore`, extract
`KeyPackagePublisher` (the native-sensitive sign/`randomBytes`/publish boundary),
leave a thin manager. Mirrors darkmatter's `AccountSecretStore` /
`KeyPackagePublisher`. _Gap: transport is publish-only — no relay fetch side._

_Completed: extracted `client/key-package-errors.ts` (4 error classes),
`client/key-package-events.ts` (pure event dedup), `client/key-package-store.ts`
(`KeyPackageStore` — owns entries + stored-entry types, emits added/removed/updated),
and `client/key-package-publisher.ts` (`KeyPackagePublisher` — the only
`signer.signEvent`/`network.publish`/`randomBytes` site). `KeyPackageManager` is now
a ~470-line coordinator that re-emits store events and re-exports the moved types/errors
for source compatibility. Also fixed a latent bug: the publisher now honours the
injected `cryptoProvider` for ciphersuite resolution instead of always using the
default. Public API unchanged; all 480 tests pass (exports snapshot gains
`KeyPackageStore` + `KeyPackagePublisher`)._

### 3. `src/core/group-message.ts` — 371 lines, the adapter/peeler conflation — DONE

`createGroupEvent` (194) **encrypts MLS bytes AND builds + ephemerally-signs a
routed Nostr event** in one call — the load-bearing conflation of the transport
layer. Also carries engine-only classification (`sortGroupCommits`, `is*Message`,
275–353) and app-rumor JSON (226–259). Split into `group-message-crypto.ts`
(peel/wrap), `group-event.ts` (event build/sign), `group-message-classify.ts`
(engine-side), `application-rumor.ts`. Delete dead `createProposalEvent`/
`createCommitEvent` aliases (301–317).

_Completed: extracted `core/group-message-crypto.ts` (the MIP-03
encrypt/decrypt + `GroupMessagePair`, the randomBytes/cipher site),
`core/group-event.ts` (`createGroupEvent` — the ephemeral-sign adapter),
`core/group-message-classify.ts` (`sortGroupCommits` + `is*Message`), and
`core/application-rumor.ts` (rumor JSON serialize/deserialize). `group-message.ts`
is now a barrel re-exporting all four for source compatibility. Deleted the dead
`createProposalEvent`/`createCommitEvent` aliases and dropped them from the
exports snapshot. Compile + all 481 tests pass._

### 4. `src/core/media.ts` — 466 lines, four dependency surfaces fused — DONE

Crypto (MLS-exporter→HKDF→ChaCha20, AAD, 114–299) + MIME canonicalization +
NIP-92/NIP-94 tag I/O (applesauce-coupled, 338–460) + the type model. Split into
`media/{types,canonical,crypto,imeta}.ts` — isolating the security-critical,
platform-sensitive `crypto.ts` (the only `randomBytes`/cipher site) so it's
auditable against darkmatter `media/crypto.rs`.

_Completed: extracted `core/media/types.ts` (`MediaAttachment`,
`EncryptMediaFileResult`, `MIP04_VERSION`), `core/media/canonical.ts`
(`canonicalizeMimeType` + the internal `isValidMimeType`/`isValidHex`
validators), `core/media/crypto.ts` (`buildMip04Aad` AAD + key derivation +
the randomBytes/ChaCha20 encrypt/decrypt site), and `core/media/imeta.ts`
(NIP-92/NIP-94 imeta parsing). `media.ts` is now a barrel with **explicit**
named re-exports so the formerly-internal validators stay private (public
surface unchanged). Compile + all 481 tests pass._

### 5. `src/core/key-package-event.ts` — 374 lines, read/write seam fused — DONE

Write-side ~110-line encoder (`createKeyPackageEventInternal`, 237–342, with
GREASE/extension/version munging) sits beside all read-side tag accessors + the
MLSMessage-frame compat decode (97–203), plus an unrelated kind-5 delete builder
(53–95). Split encode/decode/delete; matches darkmatter adapter-builds /
engine-reads. (Relevant to the KeyPackage MLSMessage-framing work — the compat
hack belongs with the _read_ accessors.)

_Completed: extracted `core/key-package-event-decode.ts` (all `getKeyPackage*`
read accessors + the MLSMessage-frame compat decode), `core/key-package-event-encode.ts`
(`createKeyPackageEvent` + the GREASE/extension/version munging builder), and
`core/key-package-event-delete.ts` (the kind-5 NIP-09 delete builder, which
imports `getKeyPackageIdentifier` from the decode module). `key-package-event.ts`
is now a barrel re-exporting all three for source compatibility. Compile + all
481 tests pass._

### 6. `src/client/groups-manager.ts` — 573 lines, registry + factory + RPC facade — DONE

Split `GroupRegistry` (cache/`#groups`/listeners/lifecycle), `GroupFactory`
(`create()` 491–536, the only `accountProofSigner`/ciphersuite consumer), leaving
a thin orchestrator. `leave()`'s inline proposal-building (461–471) should move
behind `session.leave()` to match darkmatter's "leave is a SendIntent."

_Completed: extracted `client/group-registry.ts` (`GroupRegistry` — the
`#groups`/listener/`#groupLoadPromises` cache, hydrate/build/track/untrack,
emits `updated`/`loaded`) and `client/group-factory.ts` (`GroupFactory.create()`
— the sole `accountProofSigner`/ciphersuite consumer, darkmatter
`do_create_group`). `GroupsManager` is now a thin orchestrator that forwards the
registry's cache events and layers the lifecycle events
(created/imported/joined/destroyed/left). `GroupSession.leave(ownPubkey)` now
owns the self-remove proposal build (matching darkmatter `do_send_leave` —
"leave is a SendIntent"); the manager just publishes its effects. Also added
`GroupsManager.joinFromWelcome()` for item 7. Public API unchanged; all tests pass._

### 7. `src/client/marmot-client.ts` — `joinGroupFromWelcome` layering violation — DONE

A 70-line RFC-9420 KeyPackageRef-matching loop reaching into `welcome.secrets`/
`secret.newMember` internals (210–333) — protocol logic in the composition root,
duplicated in spirit by `readInviteGroupInfo` (171–187). darkmatter makes this
`engine.join_welcome`. Extract `keyPackages.selectForWelcome()` +
`groups.joinFromWelcome()`.

_Completed: added `KeyPackageManager.selectForWelcome(welcome)` (candidate
selection + KeyPackageRef matching, ref-matches-first ordering; returns the new
`WelcomeKeyPackageCandidate[]`) and `GroupsManager.joinFromWelcome({welcome,
candidates, ciphersuiteImpl})` (the `joinGroup` loop + `verifyAllLeafAccountIdentityProofs`
+ adopt, mirroring engine `do_join_welcome`). `marmot-client.joinGroupFromWelcome`
is now ~20 lines and touches no `welcome.secrets`/KeyPackageRef internals;
`readInviteGroupInfo` reuses the same `selectForWelcome` path. Public API unchanged._

### 8. `src/core/components/internal.ts` — 211 lines, three unrelated concerns — DONE

A generic `compareBytes` (3–10) shipped beside a full hand-rolled IPv4/IPv6
host-safety classifier (17–115, a browser-forced reimplementation of Rust
`std::net`, security-critical) and the URL validator. Split `bytes.ts` /
`host-safety.ts` / `url.ts` — the file's own comments cite it as a port of
darkmatter `host_safety.rs`.

_Completed: split into `core/components/bytes.ts` (`compareBytes`),
`core/components/host-safety.ts` (the IPv4/IPv6 non-routable classifiers +
`isLoopbackHost`/`rejectNonRoutableHost`), and `core/components/url.ts`
(`validateAndNormalizeHttpsUrl`). The 4 importers were repointed and
`internal.ts` removed. Matches darkmatter's centralization in
`traits/app_components/host_safety.rs`, reused (not duplicated) by the URL
validators._

### 9. `src/core/welcome.ts` — 252 lines, codec + MLS-join fused (borderline) — DONE

Transport codec (build/parse kind-444 rumor) fused with actual `joinGroup`
group-secret decryption (`readWelcomeGroupInfo`, 177–219). Split
`welcome-event.ts` / `welcome-join.ts`. Lower urgency given size, but the
`joinGroup` import is the tell.

_Completed: split into `core/welcome-event.ts` (the kind-444 rumor codec +
`getWelcome`/`getWelcomeKeyPackageRefs`) and `core/welcome-join.ts`
(`readWelcomeGroupInfo`/`readWelcomeMarmotGroupView`, the `joinGroup` path).
`welcome.ts` is now a barrel. The darkmatter review confirmed this seam: Rust
hard-splits the welcome event codec (transport-nostr-peeler crate) from the MLS
join (`cgka-engine` `do_join_welcome`)._

## Non-structural flags surfaced (separate follow-up) — DONE

- **`encrypted-media.ts`** — DONE. The decoder no longer re-runs producer
  normalization; it is a strict validator (rejects non-canonical case/dupes/
  non-normalized URLs/trailing bytes). The compatibility review against
  darkmatter `crates/traits/src/app_components/{encrypted_media.rs,tests.rs}`
  surfaced **two further fork-causing wire divergences** beyond the flag, both
  fixed: (a) the endpoint vector used a per-item length wrapper where darkmatter
  uses a bare `{kind,url}` concatenation under one outer length (#171), and
  (b) endpoint URLs rejected query strings and stripped the WHATWG trailing
  slash where darkmatter accepts queries (#374) and keeps the slash. Now pinned
  to darkmatter's authoritative byte vector. See `COMPATIBILITY_REVIEW.md`.
- **`binary.ts`** — DONE. `BinaryReader.vector()` now copies its body with
  `.slice()` (matching `bytes()`) instead of aliasing the backing buffer via
  `.subarray()`.

## Structural gaps vs. darkmatter (missing a seam, not "too big")

- `dictionary.ts` — DONE. Collapsed onto a `ComponentCodec<T> {id, decode,
  encode}` descriptor table; the 16 accessor/builder wrappers are now one-line
  projections (`getComponent`/`entryFor`) over their descriptor.
- **Transport seams — deferred (net-new subsystems, not reshapes).** Confirmed
  against the darkmatter map: there is no `TransportMessage`/`TransportEnvelope`
  intermediate or "route-then-peel" stage; `NostrGroupPeeler` carries only
  group methods (welcome wrap/peel lives in `NostrWelcomeDelivery`), whereas
  darkmatter's `traits/src/transport.rs` `TransportEnvelope` routes both group
  and welcome pre-peel and `TransportPeeler` carries both. The key-package and
  welcome **transport helpers** are publish-only (the raw `NostrNetworkInterface`
  does expose `request()`, but there is no `KeyPackageFetcher`/welcome-fetch
  abstraction matching darkmatter's `DirectoryRelayFetcher` /
  `NostrSubscription::AccountInbox`). These are new abstractions, not
  refactors of existing code, and building them speculatively (no consuming use
  case yet) would add unused/under-specified API. Documented as scoped
  follow-ups in `COMPATIBILITY_REVIEW.md` with the darkmatter references.

## Items 1–3 are the high-payoff core

They align the engine's stateful half, the account/key-package seams, and the
adapter/peeler boundary with darkmatter's proven decomposition, and each
collapses a native-sensitive concern into a single auditable module.
