# Stack Research

**Domain:** MLS-over-Nostr TypeScript client library (Marmot v2 — dark-matter migration)
**Researched:** 2026-07-01
**Confidence:** HIGH (all versions read from package.json, pnpm-lock.yaml, Cargo.toml, and submodule source; not from training data)

---

## Layer Map

The stack is four layers. Each layer maps to counterpart Rust crates in darkmatter. Wire interop requires byte-exact agreement at every layer boundary.

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 4 — Nostr Event Shape                                │
│  applesauce-core@6.2.0, applesauce-common@6.2.0            │
│  Rust peer: nostr@0.44.2, nostr-sdk@0.44                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 3 — Marmot Protocol (src/core/, src/engine/)         │
│  @noble/ciphers@2.2.0, @noble/curves@2.2.0,                │
│  @noble/hashes@2.2.0, @scure/base@2.2.0                    │
│  Rust peer: chacha20poly1305@0.10, k256@0.13, sha2@0.10,   │
│             hkdf@0.12                                        │
├─────────────────────────────────────────────────────────────┤
│  Layer 2 — HPKE (KEM/AEAD for MLS handshake)               │
│  @hpke/core@1.9.0 + WebCrypto AES-GCM                      │
│  Rust peer: openmls_rust_crypto@~0.5 (hpke-rs)             │
├─────────────────────────────────────────────────────────────┤
│  Layer 1 — MLS Engine                                        │
│  ts-mls@2.0.0-rc.14 (workspace submodule, git ahead)        │
│  Rust peer: openmls@~0.8.1 + tls_codec@~0.4               │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer 1 — MLS Engine: ts-mls

### Version and pin

- **Package name:** `ts-mls` (workspace path `./ts-mls`)
- **Published version:** `2.0.0-rc.14`
- **Actual submodule commit:** `v2.0.0-rc.14-11-g2ca5c43` (11 commits ahead of the tag)
- **Rust counterpart:** `openmls@~0.8.1` with feature `extensions-draft-08` (tilde-pinned in `darkmatter/Cargo.toml` with comment "avoid silent companion-crate skew")

The submodule is ahead of the published tag. Any ts-mls API used by marmot-ts must be verified against the submodule source, not the npmjs release.

### What ts-mls provides

ts-mls is a complete RFC 9420 MLS implementation in TypeScript. It owns:

- **TLS serialization**: `encode`/`decode` TLS codec (in `ts-mls/src/codec/`) plus `mlsMessageDecoder`. This is the byte format that must match OpenMLS `tls_codec@~0.4` output byte-for-byte.
- **Group state machine**: `createGroup`, `joinGroup`, `joinGroupWithExtensions`, `createCommit`, `processMessage`, `processPublicMessage`, `processPrivateMessage`, `createApplicationMessage`, `createProposal`, `createSelfRemoveProposal` — full commit/proposal/welcome lifecycle.
- **Key schedule**: `mlsExporter` for MLS exporter secrets (critical for kind-445 envelope key and encrypted-media key derivation). The call signature is `mlsExporter(exporterSecret, label, context, length, ciphersuiteImpl)`.
- **App data dictionary extension**: `appDataDictionaryExtensionType`, `makeAppDataDictionaryExtension`, `getAppDataDictionary` — required for Marmot group state components.
- **AppDataUpdate proposal**: `appDataUpdateProposalType`, `appDataUpdateOperations` — used for group profile and routing updates.
- **SelfRemove proposal**: `selfRemoveProposalType`, `createSelfRemoveProposal` — MIP-03 member departure (MLS proposal type code 0x000a).
- **Custom extensions**: `makeCustomExtension`, `CustomExtension` — used by the Marmot account-identity-proof LeafNode extension.
- **Ciphersuites**: `ciphersuites` enum with both RFC 9420 standard IDs (1–7) and ts-mls experimental post-quantum IDs (0xf007–0xf012). Marmot requires only ciphersuite `1` (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`).
- **Wire format types**: `PublicMessage`, `PrivateMessage` — Marmot pins to `PublicMessage` for handshake messages (commits and proposals). The choice is set by `messageProtectionPublic.ts`; marmot-ts uses `PURE_PLAINTEXT_WIRE_FORMAT_POLICY` terminology (matching the Rust engine's `src/wire_format.rs`).

### What marmot-ts MUST add on top

ts-mls implements MLS but knows nothing about Marmot. marmot-ts adds:

1. **Account identity proof** (`src/core/account-identity-proof.ts`): the `marmot.account-identity-proof.v1` LeafNode extension (`0xf2f1`). This is a BIP-340 Schnorr signature by the Nostr account key over a SHA-256 digest binding the account pubkey to the MLS leaf signature key. ts-mls carries the extension bytes but does not interpret them; marmot-ts encodes, decodes, and verifies them.
2. **Marmot binary profile** (`src/core/binary.ts`): TLS-like encoding with QUIC variable-length integer length prefixes for all Marmot-owned byte structures (app component state, extensions). This is distinct from MLS TLS encoding (which ts-mls owns) and must match the spec in `darkmatter/spec/foundation/canonical-encoding.md`.
3. **kind-445 envelope crypto** (`src/core/group-message-crypto.ts`): ChaCha20-Poly1305 encryption of MLS PublicMessage bytes under `MLS-Exporter("marmot", "group-event", 32)`. Standard base64 encoding (RFC 4648 §4, not URL-safe). The nonce is 12 bytes random; AAD is empty string.
4. **NIP-44 v2 binary** (`src/utils/nip44-binary.ts`): ChaCha20 (not ChaCha20-Poly1305) + HMAC-SHA256 wrapping of MLS Welcome bytes for NIP-59 gift-wrap delivery. This is NOT the same as the kind-445 envelope and NOT the same as NIP-44 text DMs — it encodes binary data, not UTF-8 strings.
5. **Encrypted media v1** (`src/core/media/crypto.ts`): ChaCha20-Poly1305 AEAD keyed from `HKDF-Expand(MLS-Exporter("marmot", "encrypted-media", 32), info, 32)` where info includes the plaintext SHA-256, canonical MIME type, and filename. Nonce is 12 bytes. AAD binds scheme label + field block.
6. **KeyPackage MLSMessage framing** (`src/core/key-package-event-encode.ts`, `-decode.ts`): kind-30443 content is MLSMessage-framed (`mls_key_package` wire format), not bare KeyPackage bytes. Both publish and decode must use the framed form.
7. **Convergence engine** (`src/engine/`): fork-aware state machine tracking epochs and choosing canonical forks. ts-mls has no convergence logic; marmot-ts implements the Marmot convergence policy defined in `darkmatter/spec/protocol-core/convergence.md`.
8. **SHA-256 message IDs**: `message_id = SHA-256(mls_message_bytes)` over the raw TLS-serialized `MLSMessage`. Used for dedup, replay rejection, and same-epoch commit ordering. These IDs must match byte-for-byte with darkmatter's `commit_digest`/`tip_digest` construction.

### Spec-to-TS mapping for ciphersuite 0x0001

| Spec element | ts-mls symbol | Rust counterpart |
|---|---|---|
| `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` | `ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (id: 1) | `CiphersuiteName::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` in OpenMLS |
| DHKEM-X25519-HKDF-SHA256 (KEM) | `@hpke/core` DHKEMX25519 | `openmls_rust_crypto` via `hpke-rs` |
| AES-128-GCM (AEAD) | `@hpke/core` WebCrypto AES-GCM | `openmls_rust_crypto` ring AES-GCM |
| HKDF-SHA256 (KDF) | `@hpke/core` | `openmls_rust_crypto` |
| Ed25519 (signature) | `@hpke/core` WebCrypto | `openmls_rust_crypto` ring Ed25519 |
| TLS serialization | `ts-mls/src/codec/tlsEncoder.ts`, `tlsDecoder.ts` | `tls_codec@~0.4` |

---

## Layer 2 — HPKE: @hpke/core

| Package | Locked version | Purpose | Why |
|---|---|---|---|
| `@hpke/core` | `1.9.0` (exact in ts-mls; `^1.9.0` in marmot-ts) | DHKEM-X25519-HKDF-SHA256 + AES-128-GCM HPKE for MLS handshake | RFC 9180 HPKE is mandated by MLS RFC 9420 for key encapsulation in Welcomes and UpdatePath. ts-mls uses it internally; marmot-ts imports it directly for any HPKE outside ts-mls's scope. |

`@hpke/core` relies on WebCrypto (`globalThis.crypto.subtle`) for AES-GCM. All four target runtimes (Node 20+, Bun 1.1+, Deno 2+, browser) expose WebCrypto as a global. This is safe.

The companion optional packages (`@hpke/chacha20poly1305`, `@hpke/dhkem-x448`, `@hpke/hybridkem-x-wing`, `@hpke/ml-kem`) are ts-mls dev/peer dependencies for post-quantum ciphersuites. Marmot only uses ciphersuite 0x0001, so these are only needed if post-quantum groups are supported.

---

## Layer 3 — Marmot Protocol Crypto

### @noble/ciphers@2.2.0

| Usage | Module | Algorithm | Rust counterpart |
|---|---|---|---|
| kind-445 group event encryption | `src/core/group-message-crypto.ts` | `chacha20poly1305` | `chacha20poly1305@0.10` |
| Encrypted media v1 | `src/core/media/crypto.ts` | `chacha20poly1305` | `chacha20poly1305@0.10` |
| NIP-44 v2 binary | `src/utils/nip44-binary.ts` | `chacha20` (stream, not AEAD) | custom chacha20 (NIP-44 uses stream mode + HMAC) |

The crate `chacha20poly1305@0.10` in Rust and `@noble/ciphers@2.2.0` in TS both implement RFC 8439. For byte-exact interop, the nonce size (12 bytes), tag size (16 bytes), and AAD construction must match the spec exactly. The spec (`darkmatter/spec/transports/nostr.md`) defines empty-string AAD for kind-445.

`@noble/ciphers` uses pure JavaScript with no WebCrypto dependency. It is guaranteed runtime-agnostic.

**Version constraint**: ts-mls lists `@noble/ciphers@2.2.0` as an exact-version peer. marmot-ts declares `^2.2.0` and locks to `2.2.0`. Do not upgrade without verifying ts-mls compatibility.

### @noble/curves@2.2.0

| Usage | Module | Algorithm | Rust counterpart |
|---|---|---|---|
| secp256k1 ECDH (NIP-44 conversation key) | `src/utils/nip44-binary.ts` | `secp256k1.getSharedSecret` | `k256@0.13` |
| BIP-340 Schnorr sign/verify (account identity proof) | `src/core/account-identity-proof.ts` | `schnorr.sign`, `schnorr.verify` | `k256@0.13` with `features = ["schnorr"]` |

The Rust cgka-engine uses `k256@0.13` with `features = ["schnorr"]` specifically to validate 32-byte x-only secp256k1 pubkeys in credentials and to verify BIP-340 signatures on account identity proofs. The TypeScript `schnorr` from `@noble/curves/secp256k1.js` implements the same BIP-340 standard. Byte-exact compatibility is confirmed by the shared BIP-340 test vector requirement in the spec (`foundation/account-identity-proof-v1.md`).

**Version constraint**: ts-mls lists `@noble/curves@2.2.0` as an exact-version peer. marmot-ts locks to `2.2.0`.

### @noble/hashes@2.2.0

| Usage | Module | Algorithm | Rust counterpart |
|---|---|---|---|
| SHA-256 (message IDs, account-identity-proof digest, media hash validation) | multiple | `sha256` from `@noble/hashes/sha2.js` | `sha2@0.10` |
| HKDF-SHA256 (NIP-44 key derivation, encrypted-media file key) | `src/utils/nip44-binary.ts`, `src/core/media/crypto.ts` | `expand`/`extract` from `@noble/hashes/hkdf.js` | `hkdf@0.12` |
| HMAC-SHA256 (NIP-44 MAC) | `src/utils/nip44-binary.ts` | `hmac` from `@noble/hashes/hmac.js` | `sha2@0.10` + `hkdf@0.12` |
| `hexToBytes`, `bytesToHex`, `concatBytes`, `randomBytes` | multiple | utilities | `hex@0.4`, `rand@0.8` |

`randomBytes` from `@noble/hashes/utils.js` is a wrapper over `crypto.getRandomValues()` (WebCrypto). Runtime-agnostic on all targets.

`@noble/hashes` version `2.2.0` is a **dev** dep in ts-mls (not a peer) but a direct runtime dep in marmot-ts. There is no version conflict, but the lockfile shows multiple noble versions in the graph (`@noble/hashes@1.3.1`, `1.3.2`, `1.8.0`, `2.2.0`) from transitive deps; marmot-ts code always imports from the `2.2.0` resolution.

### @scure/base@2.2.0

| Usage | Algorithm | Rust counterpart |
|---|---|---|
| Base64 encoding/decoding for kind-445 event content and KeyPackage framing | Standard RFC 4648 §4 base64 (with padding) | Rust standard `base64` crate or inline encoding |

The spec (`darkmatter/spec/transports/nostr.md`) explicitly requires "standard base64 with padding (RFC 4648, section 4)". URL-safe base64 (§5) must NOT be used for transport bytes. `@scure/base` provides `base64` (standard) and `base64url` (URL-safe) as distinct exports. The correct import is `import { base64 } from "@scure/base"`.

---

## Layer 4 — Nostr Event Shape

| Package | Locked version | Purpose | Why |
|---|---|---|---|
| `applesauce-core` | `6.2.0` | `NostrEvent` type, event store, filter model | Provides the typed Nostr event model used throughout marmot-ts for publishing and receiving group events (kind-445), KeyPackage events (kind-30443), and account events. |
| `applesauce-common` | `6.2.0` | NIP-59 gift-wrap factories | Welcome delivery uses NIP-59 gift-wrap (kind-1059). `applesauce-common` provides `createRumor`, `createSeal`, `createWrap` factories that produce the correct unsigned-inner-event shape. |

Rust counterpart: `nostr@0.44.2` (default-features disabled, with `nip49`+`nip59` features) and `nostr-sdk@0.44`.

`applesauce-accounts@6.2.0` is a **dev-only** dependency providing `PrivateKeyAccount` for integration tests. It is not a runtime dependency. The library is BYO-account; callers inject their own signing logic.

---

## Cross-Runtime Compatibility Constraints

The library targets Node 20+, Bun 1.1+, Deno 2+, and browser. All must pass Vitest.

| API | Used by | Node 20+ | Bun 1.1+ | Deno 2+ | Browser | Risk |
|---|---|---|---|---|---|---|
| `globalThis.crypto.getRandomValues` | `@noble/hashes randomBytes`, `@hpke/core` | YES (since Node 15) | YES | YES | YES | None |
| `globalThis.crypto.subtle` (WebCrypto) | `@hpke/core` AES-GCM, Ed25519 | YES | YES | YES | YES | None |
| `atob`/`btoa` | `src/utils/nip44-binary.ts` | YES (since Node 16) | YES | YES | YES | None |
| `TextEncoder`/`TextDecoder` | `src/core/binary.ts`, multiple | YES | YES | YES | YES | None |
| `DataView` | `src/utils/nip44-binary.ts` | YES | YES | YES | YES | None |
| `BigInt` | `src/core/binary.ts` (QUIC varint) | YES | YES | YES | YES | None |
| `Uint8Array` | all layers | YES | YES | YES | YES | None (explicit policy) |
| `process.env.DEBUG` | `debug@4.4.3` | YES | YES (partial) | NO | NO | LOW — `debug` gracefully falls back; no runtime break, just no debug output |

**No Node-specific APIs** appear in the critical protocol path. The `@types/node@24.x` dev dependency is for type-checking only and does not introduce runtime coupling.

**Deno 2 runs tests via**: `deno run -A --node-modules-dir=auto npm:vitest run` — the `--node-modules-dir=auto` flag is required so Deno resolves the workspace `ts-mls` local package correctly.

**Bun** runs at both `latest` and `1.1` in CI. The `1.1` minimum is the `engines.bun` declaration. No Bun-specific code paths exist.

---

## TypeScript Build Constraints

| Constraint | Value | Interop implication |
|---|---|---|
| `module` | `NodeNext` | All relative imports in `src/` need `.js` extension even when importing `.ts` files. Failure to do so breaks Deno and Bun resolution. |
| `moduleResolution` | `NodeNext` | Subpath exports in `package.json` are used for all imports of `ts-mls` and `@noble/*`. |
| `target` | `ES2022` | `BigInt` is available (used in `binary.ts` QUIC varint). `structuredClone` is NOT used (no ES2022 issue). |
| `noUnusedLocals`, `noUnusedParameters` | `true` | Any new file must not leave dead imports or parameters. Build fails otherwise. |
| `noImplicitReturns` | `true` | Every function branch must return explicitly. |
| Named exports only | convention | No default exports anywhere in `src/`. |
| `Uint8Array` for all binary | convention | Never `Buffer` (Node-only) in protocol code. |

---

## Dependency Version Compatibility Matrix

| marmot-ts dep | Version (locked) | ts-mls peer requirement | Status |
|---|---|---|---|
| `@hpke/core` | `1.9.0` | `1.9.0` (exact) | EXACT MATCH |
| `@noble/ciphers` | `2.2.0` | `2.2.0` (exact peer) | EXACT MATCH |
| `@noble/curves` | `2.2.0` | `2.2.0` (exact peer) | EXACT MATCH |
| `@noble/hashes` | `2.2.0` | `2.2.0` (dev dep, no peer constraint) | COMPATIBLE |
| `@scure/base` | `2.2.0` | not a ts-mls dependency | N/A |
| `applesauce-core` | `6.2.0` | not a ts-mls dependency | N/A |
| `applesauce-common` | `6.2.0` | not a ts-mls dependency | N/A |

**Do not bump `@noble/ciphers` or `@noble/curves` independently of ts-mls.** The peer requirement is exact (`2.2.0`, not `^2.2.0`). Bumping marmot-ts without a matching ts-mls bump will create a version split in the pnpm workspace, risking subtle serialization differences between the ts-mls-internal crypto and the marmot-ts-external crypto.

**The `@hpke/core@1.9.0` exact pin in ts-mls is intentional.** The HPKE family packages (`@hpke/common`, `@hpke/dhkem-x25519`, etc.) have strict companion-crate versioning. Mismatched `@hpke/*` versions across packages have historically caused silent HPKE failures. Do not mix.

---

## Rust Reference Crate Map

| Rust crate (darkmatter) | Purpose | TS counterpart |
|---|---|---|
| `openmls@~0.8.1` + `extensions-draft-08` | MLS group state machine | `ts-mls@2.0.0-rc.14` |
| `tls_codec@~0.4` | TLS Presentation Language serialization | `ts-mls/src/codec/tlsEncoder.ts`, `tlsDecoder.ts` |
| `openmls_basic_credential@~0.5` | `BasicCredential` (32-byte account pubkey) | ts-mls `credential.ts` |
| `openmls_rust_crypto@~0.5` | DHKEM-X25519, AES-128-GCM, Ed25519, HKDF | `@hpke/core@1.9.0` + WebCrypto |
| `k256@0.13` with `features = ["schnorr"]` | BIP-340 x-only secp256k1 validation + Schnorr | `@noble/curves@2.2.0` `secp256k1.schnorr` |
| `sha2@0.10` | SHA-256 (message IDs, proof digest, media hash) | `@noble/hashes@2.2.0` `sha256` |
| `hkdf@0.12` | HKDF-SHA256 (NIP-44 key derivation, media key) | `@noble/hashes@2.2.0` `hkdf` |
| `chacha20poly1305@0.10` | ChaCha20-Poly1305 AEAD (kind-445 + media) | `@noble/ciphers@2.2.0` `chacha20poly1305` |
| `nostr@0.44.2` (`nip49`, `nip59`) | Nostr event types, gift-wrap | `applesauce-core@6.2.0`, `applesauce-common@6.2.0` |
| `cgka-engine` crate | Convergence, fork recovery, auto-commit | `src/engine/` |
| `transport-nostr-adapter` crate | kind-445 publish, kind-30443 KeyPackage, NIP-65 | `src/client/` + `src/core/key-package-event-*.ts` |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|---|---|---|
| `Buffer` (Node.js) | Node-only; breaks Deno, Bun, browser | `Uint8Array` (used throughout) |
| URL-safe base64 (`base64url` from `@scure/base`) | Spec requires RFC 4648 §4 standard base64 for kind-445 content and KeyPackage framing | `base64` from `@scure/base` |
| `PrivateMessage` for handshake wire format | Spec pins `PublicMessage` for all commits/proposals; mixing formats breaks convergence tie-breaking and SHA-256 message ID consistency | `PublicMessage` via ts-mls `messageProtectionPublic.ts` |
| `MlsGroup::leave_group` (OpenMLS) path | Rust engine explicitly bans this; MIP-03 requires `SelfRemove` proposal | `createSelfRemoveProposal` from ts-mls |
| Default exports in `src/` | Project convention; TypeScript strict config; causes problems with `module: NodeNext` re-exports | Named exports only |

---

## Stack Gaps Relevant to This Milestone

These are not missing libraries; they are marmot-ts code that must correctly use existing libraries to close spec gaps.

| Gap | Layer | Library involved | What must change |
|---|---|---|---|
| **M9 — source-epoch media-secret retention** | Layer 3 | `ts-mls` `mlsExporter` | The media service must call `mlsExporter` using the retained `ClientState` for the message's source epoch, not always the current tip state. The library exists; the caller plumbing is missing. |
| **m8 — welcome recipient binding** | Layer 4 | `applesauce-common` NIP-59 | `src/core/welcome.ts` must verify the NIP-59 gift-wrap recipient tag matches the local account pubkey before processing. |
| **m9 (sig-before-decrypt) — kind-445 event sig** | Layer 4 | `applesauce-core` or `@noble/curves` | Nostr event `id` and `sig` on kind-445 events must be verified before AEAD decryption. The verify path must use secp256k1 Schnorr (`@noble/curves`) or a utility from `applesauce-core`. |
| **m7 — URL normalization conformance** | Layer 3 | `src/utils/relay-url.ts` | Percent-encoding / IDNA normalization for avatar-url (0x8007) and encrypted-media (0x8008) component URL fields must produce the same canonical bytes as the Rust reference. |

---

## Sources

- `package.json` (repo root) — all runtime and dev dependency declarations (HIGH confidence, read directly)
- `pnpm-lock.yaml` (repo root) — actual resolved versions for all packages (HIGH confidence, read directly)
- `ts-mls/package.json` — ts-mls version, peer deps, exact noble/hpke pin requirements (HIGH confidence, read directly)
- `darkmatter/Cargo.toml` — Rust workspace dependencies with version pins and feature flags (HIGH confidence, read directly)
- `darkmatter/crates/cgka-engine/Cargo.toml` — engine-specific Rust deps including k256 schnorr feature (HIGH confidence, read directly)
- `darkmatter/crates/transport-nostr-adapter/Cargo.toml` — Nostr transport Rust deps (HIGH confidence, read directly)
- `darkmatter/spec/foundation/mls-protocol.md` — required ciphersuite (0x0001), PublicMessage handshake pin, SHA-256 message ID construction (HIGH confidence, read directly)
- `darkmatter/spec/foundation/canonical-encoding.md` — Marmot binary profile, QUIC varint encoding rules, standard base64 requirement (HIGH confidence, read directly)
- `darkmatter/spec/foundation/wire-envelopes.md` — SHA-256(mls_message_bytes) message ID spec (HIGH confidence, read directly)
- `darkmatter/spec/transports/nostr.md` — kind-445 ChaCha20-Poly1305 construction, base64 encoding rules, nonce size (HIGH confidence, read directly)
- `src/core/account-identity-proof.ts` — actual wire encoding of 0xf2f1 extension (HIGH confidence, read directly)
- `src/utils/nip44-binary.ts` — NIP-44 v2 binary implementation and algorithm choices (HIGH confidence, read directly)
- `src/core/media/crypto.ts` — encrypted-media-v1 key derivation and AEAD construction (HIGH confidence, read directly)
- `ts-mls/src/index.ts` — full exported API surface of ts-mls (HIGH confidence, read directly)
- `ts-mls/src/crypto/ciphersuite.ts` — ciphersuite IDs and crypto algorithm bindings (HIGH confidence, read directly)

---

*Stack research for: marmot-ts dark-matter migration — single-device wire interop*
*Researched: 2026-07-01*
