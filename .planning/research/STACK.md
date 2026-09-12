# Stack Research

**Domain:** MLS-over-Nostr (Marmot) protocol library — account identity proof v2 cutover (component `0x8009`)
**Researched:** 2026-09-12
**Confidence:** HIGH — every claim below was verified by reading `./ts-mls/src/*.ts` (vendored rc.14 fork source,
not just its `.d.ts`), `node_modules/.pnpm` copies of `@noble/curves@2.2.0` and `nostr-tools@2.19.4` (the package
`applesauce-core@6.2.0` re-exports `getEventHash`/`serializeEvent` from), and the existing marmot-ts call sites in
`src/core/` and `src/engine/`. No new library research was needed — this milestone's answer is "the current stack is
already sufficient"; the work is wiring, not acquisition.

## Headline Finding

**No new package needs to be installed.** ts-mls rc.14, `@noble/curves`, `@noble/hashes`, and
`applesauce-core`'s re-exported `getEventHash` already expose everything the `0x8009` component needs:
LeafNode-level `app_data_dictionary` read/write, a self-update vehicle that carries custom LeafNode extensions,
NIP-01 event-id computation that is exact up to `2^53-1`, and BIP-340 verification that already fails closed on an
invalid x-only public key. The gaps are all **marmot-ts-side integration code** (new `src/core` module + two small
generic-typing workarounds against ts-mls's LeafNode-vs-GroupContext extension unions), not stack gaps.

## Recommended Stack

### Core Technologies (unchanged — confirmed sufficient, not newly added)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `ts-mls` (local fork, `hzrd149/ts-mls`) | `2.0.0-rc.14` (submodule pinned `af6d1c5`, 12 commits ahead of the rc.14 tag) | MLS engine; owns LeafNode/KeyPackage/Commit wire structures | Already exposes the exact primitives this milestone needs (see integration table below); it's the user's own fork, so a patch is *possible* if ever needed, but this research found none required |
| `@noble/curves` | `^2.2.0` (resolved `2.2.0`) | BIP-340 Schnorr sign/verify for the proof signature | `schnorr.verify` (`src/secp256k1.ts`) wraps `lift_x` in a `try/catch` and returns `false` — not a thrown error — for any x-only pubkey that isn't a valid on-curve point. This *is* the spec's "reject a signer_pubkey that is not a valid x-only secp256k1 public key" check; no separate validity library is needed |
| `@noble/hashes` | `^2.2.0` | `bytesToHex`/`hexToBytes`, SHA-256 (via nostr-tools' `getEventHash`) | Unchanged from v1 usage |
| `applesauce-core` | `^6.2.0` | Re-exports `getEventHash`, `UnsignedEvent` from `nostr-tools/pure` | Confirmed below to compute the exact NIP-01 id for `created_at` up to `2^53-1` |

### Supporting Libraries — none new

No supporting library is required. The 104-byte envelope codec is a straight `BinaryReader`/`BinaryWriter` use
(`src/core/binary.ts`), already proven capable (see "Binary codec" below).

### Development Tools — unchanged

No new dev tooling. Existing `pnpm`/`vitest`/`prettier`/`tsc` setup is unaffected.

## Installation

```bash
# No new dependencies. This milestone adds no package.json entries.
```

## ts-mls Integration Points (verified against `./ts-mls/src`)

| Need | ts-mls export | File | Verified behavior |
|------|---------------|------|--------------------|
| LeafNode/KeyPackage `app_data_dictionary` container | `appDataDictionaryExtensionType` (=6), `ComponentData`, `AppDataDictionary`, `makeAppDataDictionaryExtension`, `getAppDataDictionary` | `ts-mls/src/appDataDictionary.ts` | Generic container: `ComponentData[]` sorted+unique by `componentId`, wrapped as a `CustomExtension` (extension type 6). marmot-ts already uses this exact mechanism for GroupContext components (`0x8001`..`0x800c`) and for the LeafNode `app_components`(`0x0001`)/SafeAAD(`0x0002`) advertisement (`makeLeafAppComponentsExtension`, `src/core/components/dictionary.ts:141`) — `0x8009` is one more `ComponentData` entry in that *same* leaf dictionary, not a new mechanism |
| Carry the dictionary on a KeyPackage's LeafNode | `generateKeyPackage`/`generateKeyPackageWithKey({ leafNodeExtensions?: LeafNodeExtension[] })` | `ts-mls/src/keyPackage.ts:131,180` | `leafNodeExtensions` accepts any `CustomExtension`; marmot-ts's `generateKeyPackage` (`src/core/key-package.ts:124`) already builds `leafNodeExtensions: CustomExtension[]` this way — today it pushes the app-components dictionary *and, separately, the raw `0xf2f1` extension*. For v2 the proof must move **into** the same dictionary object as a `componentEntry(0x8009, …)`, not stay a sibling raw extension |
| Carry the dictionary through a self-update (Update proposal) | `createUpdateProposal({ leafNodeExtensions?: LeafNodeExtension[] })` | `ts-mls/src/createMessage.ts:144` | This is the **only** ts-mls-supported vehicle for changing a member's own LeafNode extensions without a full remove+re-add. Defaults to `ownLeaf.extensions` when omitted (see next row for why that default is usually correct) |
| Carry the dictionary through a Commit's own path-update leaf | `createUpdatePath` (invoked internally by `createCommit` for every committer that includes a path update) | `ts-mls/src/updatePath.ts:105-115` | Hardcodes `extensions: originalLeafNode.leaf.extensions` and `signaturePublicKey: originalLeafNode.leaf.signaturePublicKey` — **not parameterized**. A path-update commit always carries the leaf's existing extensions and signature key forward byte-for-byte. This means the `0x8009` proof survives every ordinary commit automatically with zero extra code, and confirms self-update (the row above) is the only place proof *replacement* logic is needed |
| Validate `0x8009` on `processMessage`/`joinGroup` | *(none — by design)* | `ts-mls/src/processMessages.ts`, `ts-mls/src/clientState.ts` | ts-mls treats `app_data_dictionary` contents as opaque bytes; it never inspects component ids. marmot-ts already validates every other component (group-profile, admin-policy, …) as an **external, post-processMessage layer** — this milestone's proof validation follows the identical, already-established pattern (see next section) |

### Where existing marmot-ts validation already runs *outside* ts-mls (the pattern to extend)

Confirmed by grep — these are the only current call sites of `verifyLeafAccountIdentityProof`/`verifyAllLeafAccountIdentityProofs`, and they are the model for where `0x8009` validation must plug in:

- `src/client/group/proposals/invite-user.ts:22` — before inviting, on the candidate KeyPackage's LeafNode
- `src/engine/admin-policy.ts:51` — per-commit, on resulting member leaves (a "legality seam")
- `src/client/groups-manager.ts:724` — once, after a full `joinGroup`, over every member (`verifyAllLeafAccountIdentityProofs` calls ts-mls's `getGroupMembers(state)`)

None of these call into ts-mls internals; they read `LeafNode.extensions`/`LeafNode.credential` after ts-mls has already produced a `ClientState`. The same three seams are where `0x8009` validation must be added (plus the GroupContext-level "requires `0x8009`" check, which is a `getAppComponents(groupContext.extensions)` read — already-existing machinery, see below).

### GroupContext "requires 0x8009" — already-existing generic machinery, additive only

`src/core/group.ts:69-83` (`createGroup`) builds the required-components list from `DEFAULT_GROUP_COMPONENT_IDS` plus whatever the caller passes, and seeds the `app_components` (`0x0001`) entry automatically. Adding the new component id to `DEFAULT_GROUP_COMPONENT_IDS` (`src/core/components/ids.ts:61`) makes every newly created group require it with **no other code change** in `group.ts`. The read side (`getAppComponents`, `src/core/components/dictionary.ts:242`) is already called from `src/core/components/integrity.ts:304`, `disband-validation.ts:95/97/188`, and `src/engine/group-engine.ts:688/762` — the same call sites that already enforce `0x8001`/`0x8003`/etc. presence are the ones that must also gate on `0x8009`.

### A genuinely new integration wrinkle: reading a *LeafNode's* dictionary is untested territory

Grepped every existing call of `getAppDataDictionary`/`getAppComponents`/`getComponentData` in `src/` (10 call sites, `integrity.ts`, `disband-validation.ts`, `state-notifications.ts`, `group-engine.ts`, `client-state.ts`) — **all of them read `groupContext.extensions`**. None reads a `LeafNode.extensions` or `KeyPackage.leafNode.extensions` back out. That's new for this milestone (validating `0x8009` requires reading the dictionary off a LeafNode, not just building one — see "What Must NOT Be Added" for the exact type wrinkle this causes).

## Nostr/crypto primitives already sufficient (verified, not assumed)

### NIP-01 event id, `created_at` up to `2^53-1`

`applesauce-core`'s `getEventHash` is a re-export of `nostr-tools@2.19.4`'s `pure.js`:

```js
function serializeEvent(evt) {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}
function getEventHash(event) {
  return bytesToHex2(sha256(utf8Encoder.encode(serializeEvent(event))));
}
```

`created_at` is serialized as a plain JS `number` via `JSON.stringify`. JS numbers are exact integers up to
`Number.MAX_SAFE_INTEGER = 2^53-1` — precisely the spec's upper bound (chosen, per
`authorization-proofs.md`, "so the value is represented exactly by interoperable JSON implementations"). This
already round-trips correctly with no extra library. The one thing marmot-ts must do itself: `BinaryReader.uint64()`
(`src/core/binary.ts:298`) decodes the envelope's `created_at` as a `bigint` — it must be converted with
`Number(bigintValue)` before use in the event object (safe because validation rejects `>2^53-1` before conversion,
which must also be added as an explicit range check — `authorization-proofs.md` step 3 — since neither ts-mls nor
`applesauce-core` performs it for you).

### x-only secp256k1 pubkey validity

`@noble/curves@2.2.0`'s `schnorr.verify` (`src/secp256k1.ts:217-247`) calls `lift_x` inside a `try/catch` and
returns `false` (not a thrown error) on an invalid x-coordinate. Calling `schnorr.verify(signature, digest,
signerPubkey)` and treating a `false` return as rejection satisfies the spec's "reject a signer_pubkey that is not
a valid x-only secp256k1 public key" step as a side effect of normal verification — no separate curve-point-validity
call is required. (An explicit early check is available too, if a clearer error message than "signature invalid" is
wanted: `schnorr.utils.lift_x(bytesToNumberBE(pubkeyBytes))` throws synchronously on an invalid point — this is a
public, documented member of the `schnorr` export, not an internal.)

### Binary codec

`src/core/binary.ts`'s `BinaryWriter`/`BinaryReader` already have `uint8`, big-endian `uint16`/`uint32`, and
big-endian `uint64` (`number | bigint` in, `bigint` out) methods — exactly what the fixed-width 104-byte envelope
(`32-byte pubkey ‖ 8-byte BE uint64 created_at ‖ 64-byte signature`) needs. No new codec code beyond a
straight-line encode/decode function is required (same shape as the existing, now-superseded
`encodeAccountIdentityProof`/`decodeAccountIdentityProof` in `src/core/account-identity-proof.ts`).

## What Must NOT Be Added

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| A new npm dependency for "x-only pubkey validation" or "BIP-340 verify" | `@noble/curves` `schnorr.verify`/`schnorr.utils.lift_x` already do this correctly (verified above) | The existing `@noble/curves` import |
| A new npm dependency for NIP-01 event-id / canonical JSON serialization | `applesauce-core`'s re-exported `getEventHash` already produces the exact byte-for-byte id, including at `2^53-1` | The existing `applesauce-core/helpers/event` import, unchanged from the legacy proof module |
| Patching `ts-mls` to add a `0x8009`-aware validator, a generic-version field, or a new MLS extension type for the proof | The spec is explicit: "the component data is exactly 104 bytes and has no component-specific wrapper or version field," and MDK's own `capabilities.rs` (`ProtocolProfile::Current` branch) registers `0x8009` only as `CTCapability::AppComponent(...)`, never as an `ExtensionType` — confirming the proof is *purely* app-component-layer, requiring **zero** ts-mls-level (MLS extension/capability) changes | Keep validation entirely in `src/core`/`src/engine`, exactly where `verifyLeafAccountIdentityProof` already lives; ts-mls stays a dumb byte carrier |
| Registering `0x8009` as an MLS `Capabilities.extensions` entry (the way legacy `0xf2f1` is registered today in `ensureMarmotCapabilities`, `src/core/capabilities.ts:58-59`) or in `marmotRequiredCapabilitiesExtension`'s `extensionTypes` (`src/core/capabilities.ts:101`) | `0x8009` is a component id inside the already-capability-covered `app_data_dictionary` (extension type 6), not its own MLS extension type — mirrors MDK exactly (see row above) | Register `0x8009` only in `SUPPORTED_APP_COMPONENT_IDS` / `DEFAULT_GROUP_COMPONENT_IDS` (`src/core/components/ids.ts`), the same list `0x8001`/`0x8003`/etc. already use |
| Casting/forking ts-mls's exported TypeScript types (`GroupContextExtension[]` param on `getAppDataDictionary`) to accept `LeafNodeExtension[]` by editing `ts-mls/src/appDataDictionary.ts` | The function's *runtime* behavior is generic (`extensions.find(e => e.extensionType === 6)`) — only the compile-time parameter type is narrower than needed, and only because no existing marmot-ts code has ever read a dictionary off a LeafNode before (confirmed: all 10 current call sites read `groupContext.extensions`) | Add a small local marmot-ts helper (e.g. `getLeafComponentData(extensions: LeafNodeExtension[], id)`) that duplicates the two-line find+decode, or a documented `as GroupContextExtension[]` cast at the 2-3 new call sites (KeyPackage leaf, Update-proposal leaf, Commit update-path leaf) — this is app-code, not a fork patch |
| A "signature-key rotation" path for self-update | ts-mls's `createUpdateProposal` (`createMessage.ts:167`) and `createUpdatePath` (`updatePath.ts:111`) both hardcode reuse of the existing leaf `signaturePublicKey` — neither supports installing a new MLS signature key as part of an Update. This is not a gap: per `authorization-proofs.md`, a proof "MAY be reused only while all signed inputs remain byte-for-byte identical" (same signature key, ciphersuite, identity) — so ts-mls's fixed behavior means the common self-update case can (and should) simply **carry the existing valid `0x8009` proof forward unchanged** rather than mint a new one | Default `leafNodeExtensions` to the current leaf's extensions (proof included) unless the caller is deliberately building a fresh dictionary; only mint a new proof when something the proof binds to (rare: ciphersuite/account identity — signature key can't actually change here) changes |
| Removing `0xf2f1` handling piecemeal / leaving a dual-write | Spec (`account-identity-proof-v2.md`, "Migration from v1") and this milestone's decision are both explicit: no mixed v1/v2 fallback | Delete `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE` usage from `ensureMarmotCapabilities`, `marmotRequiredCapabilitiesExtension`, and `generateKeyPackage`'s extra `leafNodeExtensions.push(...)` call (`src/core/key-package.ts:131-140`) in the same change that adds `0x8009` |

## Stack Patterns by Variant

**If encoding/decoding the 104-byte envelope:**
- Use `BinaryWriter`/`BinaryReader` from `src/core/binary.ts` exactly as the legacy `encodeAccountIdentityProof`/`decodeAccountIdentityProof` did, just with the new fixed layout (no version byte, no length-prefixed key — the LeafNode's own `signaturePublicKey` supplies the key length implicitly since it's not stored in the proof).
- Because the spec fixes the layout at exactly 104 bytes with "no component-specific wrapper or version field" — matching the codec's existing fixed-width methods with no new abstraction needed.

**If building the KeyPackage-time or founding-leaf dictionary:**
- Extend the existing `makeLeafAppComponentsExtension`-style builder (`src/core/components/dictionary.ts`) to add one more `componentEntry(0x8009, encodedProof)` into the *same* dictionary as `app_components`(`0x0001`)/SafeAAD(`0x0002`), sorted by id.
- Because ts-mls's dictionary is a single sorted `ComponentData[]` per extension — one dictionary per LeafNode, not one extension per component.

**If building a self-update (replacement leaf) that keeps the same account identity:**
- Call `createUpdateProposal` with `leafNodeExtensions` set to the current dictionary (proof reused unchanged) unless the account identity itself is changing — the spec explicitly says an account-identity change "is not a self-update; it requires removing the old membership and separately authorizing a new membership," so that case never reaches this proposal type at all.
- Because ts-mls's own-leaf update path structurally cannot rotate the signature key, so "fresh proof" only ever means "same proof, carried forward, revalidated."

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| `ts-mls@2.0.0-rc.14` (submodule `af6d1c5`, 12 commits past the rc.14 tag) | `@internet-privacy/marmot-ts` current `src/` | Already the pinned version for all validated v1.0 capabilities; no version bump needed for this milestone. It's a user-owned fork (`hzrd149/ts-mls`) and has been patched directly before (`bb425f6`, "expose canonical GroupContext encoder"), so a patch remains *available* if a future finding requires one — none was found here |
| `@noble/curves@^2.2.0` | resolved `2.2.0` in `node_modules/.pnpm` | `schnorr.verify`/`schnorr.utils.lift_x` behavior verified directly against this exact installed version, not just the API surface implied by the semver range |
| `applesauce-core@^6.2.0` → `nostr-tools@~2.19` (resolved `2.19.4`) | transitive, not a direct marmot-ts dependency | `getEventHash`/`serializeEvent` behavior verified against the resolved `2.19.4` copy in `node_modules/.pnpm/nostr-tools@2.19.4_typescript@6.0.3` |

## Sources

- `./ts-mls/src/appDataDictionary.ts`, `leafNode.ts`, `extension.ts`, `keyPackage.ts`, `createMessage.ts`, `updatePath.ts` — read directly (vendored submodule, HIGH confidence, primary source)
- `refs/mdk/crates/cgka-engine/src/account_identity_proof.rs`, `capabilities.rs`, `refs/mdk/crates/traits/src/app_components/mod.rs` — read directly (Rust reference, HIGH confidence, primary source)
- `refs/marmot/app-components/account-identity-proof-v2.md`, `refs/marmot/foundation/authorization-proofs.md` — read directly (adopted spec, HIGH confidence, primary source)
- `node_modules/.pnpm/@noble+curves@2.2.0/node_modules/@noble/curves/src/secp256k1.ts` — read directly (installed dependency, HIGH confidence)
- `node_modules/.pnpm/nostr-tools@2.19.4_typescript@6.0.3/node_modules/nostr-tools/lib/esm/pure.js` — read directly (resolved transitive dependency, HIGH confidence)
- `src/core/account-identity-proof.ts`, `capabilities.ts`, `key-package.ts`, `components/{ids,dictionary,app-components-list}.ts`, `group.ts`; `src/engine/admin-policy.ts`; `src/client/{groups-manager,group/proposals/invite-user}.ts` — existing marmot-ts source, read directly (HIGH confidence, establishes the integration pattern to extend)

---
*Stack research for: marmot-ts v2.0 Account identity proof v2 (component `0x8009`)*
*Researched: 2026-09-12*
