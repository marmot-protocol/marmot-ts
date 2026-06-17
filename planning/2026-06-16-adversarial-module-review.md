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
`EventSigner`), so none introduces browser/native risk — most *reduce* it by
collapsing each native-sensitive concern (signing, `randomBytes`, relay publish,
media crypto) into one auditable module.

## Ranked refactor opportunities

### 1. `src/engine/group-engine.ts` — 1130-line `MarmotGroupEngine` (highest payoff) — IN PROGRESS

One class does seven jobs: send-intents (`send`, 155–306), publish lifecycle
(`confirmPublished`/`publishFailed`, 308–345), retained-state store
(`#retainAppliedCommit` + the four `#retained*`/`#applied*`/`#branch*` maps),
**fork recovery** (`#buildBranches` 438–585, `#resolveFork` 592–656, ~225 lines),
admin-callback wiring (658–668), commit sorting (670–686), and the **440-line
recursive ingest generator** (`#ingestRaw`, 688–1129).

darkmatter splits exactly this into `message_processor/{ingest,send,store}.rs`,
`fork_recovery.rs`, `epoch_manager.rs`. The pure scoring (`convergence.ts`) is
*already* separated correctly — this extends that seam to the stateful half.

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

### 2. `src/client/key-package-manager.ts` — 857 lines, three fused darkmatter seams

Header admits "Storage helpers (inlined from KeyPackageStore)." Fuses storage
(`store*` CRUD, 307–473), Nostr publish/sign transport (`create`/`rotate`/`purge`,
494–681, the only `signer.signEvent`+`network.publish` site), and pure helpers
(event dedup 103–139, four error classes 149–193). Split into
`key-package-events.ts` (pure), re-extract `KeyPackageStore`, extract
`KeyPackagePublisher` (the native-sensitive sign/`randomBytes`/publish boundary),
leave a thin manager. Mirrors darkmatter's `AccountSecretStore` /
`KeyPackagePublisher`. _Gap: transport is publish-only — no relay fetch side._

### 3. `src/core/group-message.ts` — 371 lines, the adapter/peeler conflation

`createGroupEvent` (194) **encrypts MLS bytes AND builds + ephemerally-signs a
routed Nostr event** in one call — the load-bearing conflation of the transport
layer. Also carries engine-only classification (`sortGroupCommits`, `is*Message`,
275–353) and app-rumor JSON (226–259). Split into `group-message-crypto.ts`
(peel/wrap), `group-event.ts` (event build/sign), `group-message-classify.ts`
(engine-side), `application-rumor.ts`. Delete dead `createProposalEvent`/
`createCommitEvent` aliases (301–317).

### 4. `src/core/media.ts` — 466 lines, four dependency surfaces fused

Crypto (MLS-exporter→HKDF→ChaCha20, AAD, 114–299) + MIME canonicalization +
NIP-92/NIP-94 tag I/O (applesauce-coupled, 338–460) + the type model. Split into
`media/{types,canonical,crypto,imeta}.ts` — isolating the security-critical,
platform-sensitive `crypto.ts` (the only `randomBytes`/cipher site) so it's
auditable against darkmatter `media/crypto.rs`.

### 5. `src/core/key-package-event.ts` — 374 lines, read/write seam fused

Write-side ~110-line encoder (`createKeyPackageEventInternal`, 237–342, with
GREASE/extension/version munging) sits beside all read-side tag accessors + the
MLSMessage-frame compat decode (97–203), plus an unrelated kind-5 delete builder
(53–95). Split encode/decode/delete; matches darkmatter adapter-builds /
engine-reads. (Relevant to the KeyPackage MLSMessage-framing work — the compat
hack belongs with the *read* accessors.)

### 6. `src/client/groups-manager.ts` — 573 lines, registry + factory + RPC facade

Split `GroupRegistry` (cache/`#groups`/listeners/lifecycle), `GroupFactory`
(`create()` 491–536, the only `accountProofSigner`/ciphersuite consumer), leaving
a thin orchestrator. `leave()`'s inline proposal-building (461–471) should move
behind `session.leave()` to match darkmatter's "leave is a SendIntent."

### 7. `src/client/marmot-client.ts` — `joinGroupFromWelcome` layering violation

A 70-line RFC-9420 KeyPackageRef-matching loop reaching into `welcome.secrets`/
`secret.newMember` internals (210–333) — protocol logic in the composition root,
duplicated in spirit by `readInviteGroupInfo` (171–187). darkmatter makes this
`engine.join_welcome`. Extract `keyPackages.selectForWelcome()` +
`groups.joinFromWelcome()`.

### 8. `src/core/components/internal.ts` — 211 lines, three unrelated concerns

A generic `compareBytes` (3–10) shipped beside a full hand-rolled IPv4/IPv6
host-safety classifier (17–115, a browser-forced reimplementation of Rust
`std::net`, security-critical) and the URL validator. Split `bytes.ts` /
`host-safety.ts` / `url.ts` — the file's own comments cite it as a port of
darkmatter `host_safety.rs`.

### 9. `src/core/welcome.ts` — 252 lines, codec + MLS-join fused (borderline)

Transport codec (build/parse kind-444 rumor) fused with actual `joinGroup`
group-secret decryption (`readWelcomeGroupInfo`, 177–219). Split
`welcome-event.ts` / `welcome-join.ts`. Lower urgency given size, but the
`joinGroup` import is the tell.

## Non-structural flags surfaced (separate follow-up)

- **`encrypted-media.ts:178`** — `decodeEncryptedMediaPolicyV1` *re-runs*
  producer normalization instead of strict validate, so it silently repairs
  non-canonical stored bytes where darkmatter rejects them → risk of
  **cross-implementation commit-acceptance forks**.
- **`binary.ts`** — `BinaryReader` mixes `.slice()` (335) and `.subarray()` (381)
  over the backing buffer; latent aliasing bug, not a split issue.

## Structural gaps vs. darkmatter (missing a seam, not "too big")

- No `TransportMessage`/envelope intermediate and no "route-then-peel" stage;
  `GroupPeeler` lacks welcome methods, so welcome wrap/peel lives as free
  functions. darkmatter's `TransportPeeler` carries both group and welcome.
- Key-package and welcome transport are **publish-only** — no relay *fetch* side.
- `dictionary.ts` (293) — don't split; collapse its 16 hand-written
  accessor/builder wrappers into a `{id, decode, encode}` descriptor table
  (darkmatter's `codec.rs` idea).

## Items 1–3 are the high-payoff core

They align the engine's stateful half, the account/key-package seams, and the
adapter/peeler boundary with darkmatter's proven decomposition, and each
collapses a native-sensitive concern into a single auditable module.
