# Signing Marmot MLS account identity proofs (NIP-07 / NIP-46)

Status: **draft implementer guide** — intended as the basis for a Nostr NIP and for signer authors (browser extensions, bunkers, mobile signers).

## Abstract

Marmot (MLS over Nostr) requires every MLS KeyPackage and group member leaf to carry an **account identity proof**: a BIP-340 Schnorr signature by the user's Nostr account key, binding that account to a specific MLS device signature key.

This document specifies how **NIP-07** (`window.nostr`) and **NIP-46** (Nostr Connect) signers should expose that operation. The API **must accept the variable MLS binding fields** (proof version, device public key, and ciphersuite) so the user can see what they authorize, and so signers can dispatch to the correct encoding when future proof versions are defined. Fixed protocol constants and the signer's own account pubkey are resolved on the signer side when building the hash.

Signers **must not** expose a digest-only or arbitrary-hash signing primitive for this purpose.

Normative Marmot protocol bytes are defined in the Marmot v2 draft [`account-identity-proof-v1`](../../darkmatter/spec/foundation/account-identity-proof-v1.md).

---

## Background

### Two keys on every MLS leaf

| Key | Role | Typical algorithm |
| --- | --- | --- |
| **Account identity** | Marmot / Nostr account (32-byte x-only secp256k1 pubkey in the MLS `BasicCredential`) | BIP-340 public key |
| **MLS signature key** | Per-device leaf key used for MLS protocol messages | Often Ed25519 (depends on MLS ciphersuite) |

The credential alone only *claims* an account pubkey. The identity proof proves the account owner authorized **this** MLS signature public key for **this** ciphersuite.

### What is being signed

The user is **not** signing a Nostr event. The proof is embedded in MLS LeafNode extension bytes (`marmot.account-identity-proof.v1`, MLS extension type `0xF2F1`). It is never published to relays as its own artifact.

The account key signs a **domain-separated canonical byte string**, hashed with SHA-256, then signed with **BIP-340 Schnorr** using the account's x-only public key. This reuses the same curve and signature scheme as Nostr event signatures, but **not** the Nostr event-id construction (`[0, pubkey, created_at, kind, tags, content]`).

### Why `signEvent` is insufficient

`signEvent` always commits to an event template. No event template can produce the identity-proof digest. Signers therefore need a dedicated method that takes the MLS binding fields, displays them to the user, recomputes the digest locally, and signs with BIP-340.

---

## API request (what callers send)

Callers pass **only the fields that vary per authorization** (or per proof-version upgrade). Everything else is filled in by the signer when encoding the canonical message.

### Where `version` comes from

The `version` byte is defined by the Marmot account identity proof spec ([`account-identity-proof-v1.md`](../../darkmatter/spec/foundation/account-identity-proof-v1.md)):

- It is the **first byte of the MLS extension payload** on the leaf (`uint8 version = 1`).
- It is also embedded in the **canonical signing preimage** (after `extension_type`).

The MLS client building the KeyPackage knows which proof version it is assembling into the leaf. Callers **must pass that same `version`** to the signer so:

1. The user sees which proof format they authorize (e.g. “proof v1” vs a future “proof v2”).
2. The signer selects the correct canonical message layout and constants for that version.
3. Unsupported versions fail explicitly instead of silently using v1 encoding.

When Marmot defines a v2 proof, it may also change the domain string, extension type, or signing algorithm. Signers implement a **version dispatch** table; this NIP method name can stay the same while `version` selects the handler.

### Required caller fields

| Field | Type | Description |
| --- | --- | --- |
| `version` | number | Account identity proof version. **Must be `1` today** (see Marmot spec). Future values select v2+ encodings when defined. |
| `mls_ciphersuite` | number | MLS ciphersuite id (unsigned 16-bit). Marmot currently uses **`1` (`0x0001`, Ed25519)**. |
| `mls_signature_public_key` | hex string | Exact serialized MLS leaf signature public key bytes from the LeafNode being authorized. |

### Signer-supplied constants (never passed by callers)

The signer **must** resolve these from `version` and local key material when building the signing input:

| Value | Source |
| --- | --- |
| `domain` | From proof version — v1: `"marmot.account-identity-proof.v1"` |
| `extension_type` | From proof version — v1: `62193` (`0xF2F1`) |
| `account_identity` | Signer's own 32-byte x-only pubkey from `getPublicKey()` (normalized to x-only bytes) |
| `mls_signature_scheme` | Derived from `mls_ciphersuite` using the [mapping table](#mls-ciphersuite--signature-scheme-mapping) (v1) |

Callers **must not** pass `domain`, `extension_type`, `account_identity`, or `mls_signature_scheme`. Signers **must ignore or reject** requests that include them.

### Version dispatch (signer implementation)

| `version` | Status | Signer behavior |
| --- | --- | --- |
| `1` | Defined | Use v1 domain, extension type, and canonical message layout in this document; BIP-340 signature |
| other | Future / unknown | **Reject** with an explicit unsupported-version error until the signer implements that version |

When a new Marmot proof version is published, signer authors update their dispatch table (and approval UI copy) to match the new spec. Clients pass the `version` byte they embed in the MLS extension payload.

### Fields signers must reject

| Condition | Error |
| --- | --- |
| `version` missing | reject |
| `version` not implemented by this signer (only `1` today) | reject |
| `mls_ciphersuite` missing or unknown (not in mapping table) | reject |
| `mls_signature_public_key` missing or invalid hex | reject |
| `mls_signature_public_key` length inconsistent with ciphersuite (e.g. ≠ 32 bytes for ciphersuite `1`) | reject |
| Request contains **only** a `digest` / `hash` field | reject |
| Request asks signer to sign a precomputed digest without `version`, `mls_ciphersuite`, and `mls_signature_public_key` | reject |
| Extra fields such as `account_identity`, `extension_type`, or `domain` | reject (recommended) or ignore |

Signers **may** accept an optional `digest` field for cross-checking only: if present, it **must** equal the digest the signer recomputes from the caller fields plus signer-supplied constants. If it differs, reject.

### MLS ciphersuite → signature scheme mapping

Signers **must** look up `mls_signature_scheme` from `mls_ciphersuite` before signing:

| `mls_ciphersuite` | Name (informative) | `mls_signature_scheme` | Name (informative) |
| --- | --- | --- | --- |
| `1` | MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519 | `0x0807` (2055) | Ed25519 |
| `2` | MLS_256_DHKEMP256_AES128GCM_SHA256_P256 | `0x0403` (1027) | ecdsa_secp256r1_sha256 |
| `3` | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 | `0x0807` (2055) | Ed25519 |
| `4` | MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448 | `0x0808` (2056) | Ed448 |
| `5` | MLS_256_DHKEMP521_AES256GCM_SHA512_P521 | `0x0603` (1539) | ecdsa_secp521r1_sha512 |
| `6` | MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448 | `0x0808` (2056) | Ed448 |
| `7` | MLS_256_DHKEMP384_AES256GCM_SHA384_P384 | `0x0503` (1283) | ecdsa_secp384r1_sha384 |

For ciphersuite `1`, `mls_signature_public_key` must be **32 bytes** after hex decode.

### Human-readable approval text (required for interactive signers)

Before signing, interactive signers (extensions, bunkers, OS prompts) **must** show at least:

1. **Action**: e.g. “Authorize an MLS device key for Marmot”
2. **Proof version**: `version` (e.g. “v1”)
3. **Your account**: signer's own pubkey as `npub` (from local key, not from caller params)
4. **MLS device public key**: full hex of `mls_signature_public_key`
5. **MLS ciphersuite**: numeric id and informative name from the table above
6. **Signature scheme**: derived name from the table above

Optionally show the recomputed **digest** (64 hex chars) on an advanced / developer panel. Do **not** show the digest alone as the primary prompt.

Example primary copy:

> **Authorize MLS device (proof v1)**  
> Your account: `npub1…`  
> Device key: `ababcdcd…` (32 bytes)  
> Ciphersuite: 1 (Ed25519 / X25519)  
> This lets the device join Marmot groups as you. It does not publish a Nostr event.

---

## Canonical message and digest (normative)

Signers **must** compute the digest themselves. Never trust a caller-supplied digest as the sole input.

### Step 1 — Resolve inputs

From the **caller**:

- `version` — from request; selects proof encoding (see [version dispatch](#version-dispatch-signer-implementation))
- `mls_ciphersuite` — from request
- `mls_key_bytes` — from hex `mls_signature_public_key`

From the **signer** (resolved from `version` + local key):

- `domain_bytes` — v1: ASCII `"marmot.account-identity-proof.v1"` (32 bytes, no length prefix)
- `extension_type` — v1: `0xF2F1` (62193)
- `account_identity_bytes` — 32-byte x-only pubkey of the signing account
- `mls_signature_scheme` — from [mapping table](#mls-ciphersuite--signature-scheme-mapping) (v1)
- `account_identity_len` — `32` (constant; still encoded on the wire)
- `mls_key_len` — `mls_key_bytes.length` (must fit in `uint16`)

### Step 2 — Build `canonical_message` (fixed-width big-endian integers)

Concatenate, in order:

```text
opaque domain[]                     // ASCII "marmot.account-identity-proof.v1" (32 bytes), NO length prefix
uint8  0x00                       // separator after domain
uint16 extension_type             // 0xF2F1 (62193), big-endian
uint8  version                    // from caller (0x01 for v1)
uint16 mls_ciphersuite            // big-endian
uint16 mls_signature_scheme       // big-endian, derived by signer
uint16 account_identity_len       // MUST be 32 (0x0020), big-endian
opaque account_identity[32]       // signer's x-only pubkey
uint16 mls_signature_public_key_len
opaque mls_signature_public_key[mls_signature_public_key_len]
```

**Important:** This preimage is **not** the same as the MLS extension payload on the leaf. The extension payload omits the domain prefix, separator, `extension_type`, and `account_identity_len`; the signing input includes them for domain separation.

### Step 3 — Digest

```text
digest = SHA-256(canonical_message)   // 32 bytes
```

### Step 4 — BIP-340 Schnorr signature

Sign `digest` with the account's secp256k1 secret key using **BIP-340** Schnorr:

- Public key: x-only 32-byte `account_identity_bytes` (signer's own key)
- Message: the 32-byte `digest` directly (prehashed message; **do not** apply Nostr event-id serialization)
- Output: 64-byte signature (`r_x || s`), hex-encoded as 128 characters for JSON APIs

Verification uses BIP-340 with the same `digest` and x-only pubkey.

Reference cryptography (implementers choose their own stack):

- **BIP-340 Schnorr** on secp256k1 with x-only 32-byte public keys
- **SHA-256** for the canonical message digest
- Any correct BIP-340 implementation is acceptable (e.g. libsecp256k1, `@noble/curves/secp256k1`, `nostr-sdk` Schnorr helpers)

### Pseudocode

```javascript
const PROOF_V1 = {
  domain: "marmot.account-identity-proof.v1",
  extensionType: 0xf2f1,
};

function proofConstants(version) {
  if (version === 1) return PROOF_V1;
  throw new Error(`unsupported account identity proof version ${version}`);
}

function mlsSignatureScheme(ciphersuite) {
  // lookup from mapping table; throw if unknown
}

function mlsIdentityProofDigest(callerParams, accountIdentityBytes) {
  assert(accountIdentityBytes.length === 32);
  const { domain, extensionType } = proofConstants(callerParams.version);

  const mlsKey = hexToBytes(callerParams.mls_signature_public_key);
  const scheme = mlsSignatureScheme(callerParams.mls_ciphersuite);

  const writer = new BinaryWriter(); // uint8/uint16 big-endian, raw bytes
  writer.bytes(new TextEncoder().encode(domain));
  writer.uint8(0);
  writer.uint16(extensionType);
  writer.uint8(callerParams.version);
  writer.uint16(callerParams.mls_ciphersuite);
  writer.uint16(scheme);
  writer.uint16(32);
  writer.bytes(accountIdentityBytes);
  writer.uint16(mlsKey.length);
  writer.bytes(mlsKey);

  return sha256(writer.build()); // 32 bytes
}

async function signMlsIdentityProof(secretKey, callerParams) {
  const accountIdentity = xOnlyPubkey(await getPublicKey(secretKey));
  const digest = mlsIdentityProofDigest(callerParams, accountIdentity);
  return schnorr.sign(digest, secretKey); // 64 bytes, BIP-340
}
```

### Test vector

**Caller params:**

| Field | Value |
| --- | --- |
| `version` | `1` |
| `mls_ciphersuite` | `1` |
| `mls_signature_public_key` | `ababababababababababababababababababababababababababababababab` |

**Signer-resolved values for v1** (not passed by caller):

| Value | Source |
| --- | --- |
| `domain` | `"marmot.account-identity-proof.v1"` |
| `extension_type` | `62193` (`0xF2F1`) |
| `mls_signature_scheme` | `2055` (`0x0807`) — derived from ciphersuite `1` |
| `account_identity` | `9d948d4dbd92fe2b7c3ace1cdf99f7f79cbb23f0ac10edf323b8bae36c58ea91` (x-only pubkey of test secret key `0x01…01` last byte `0x07`) |

**Expected outputs:**

| Output | Value |
| --- | --- |
| `digest` | `9035a57a3156c220cefc0318762cdbed8adbf155f54455151bc779d2a31c021e` |
| `signature` | `3fd87ca37ddf056521dfcfe4749ef2169c5b423ac472a9af92abdc7aa532e94a01a1294d7bcc2abfba626efbfc0d08787893560b21b3ecd31b7d84e6d6c81496` |

Implementers should verify `schnorr.verify(signature, digest, account_identity)` succeeds for the test vector before shipping.

---

## NIP-07 extension

### Method

Add to `window.nostr`:

```typescript
async window.nostr.signMlsIdentityProof(
  params: MlsIdentityProofParams,
): Promise<string>; // 64-byte BIP-340 signature as hex (128 characters)

type MlsIdentityProofParams = {
  version: number;
  mls_ciphersuite: number;
  mls_signature_public_key: string; // hex
};
```

### Behavior

1. Reject if required caller fields are missing or invalid (see rejection table).
2. Dispatch on `version`; reject unsupported versions.
3. Resolve `account_identity` from the signer's own key (`getPublicKey()`, normalized to x-only bytes).
4. Derive `mls_signature_scheme` from `mls_ciphersuite` (for v1).
5. Show the [human-readable approval](#human-readable-approval-text-required-for-interactive-signers) UI.
6. Compute `canonical_message` → `digest` → BIP-340 signature as specified above.
7. Return signature hex.

### Feature detection

Clients should treat the method as optional:

```javascript
if (typeof window.nostr?.signMlsIdentityProof === "function") {
  // use structured signing
} else {
  // fall back or error; do not silently sign opaque digests
}
```

---

## NIP-46 remote signer

### Method name

`sign_mls_identity_proof`

### Request

Same JSON-RPC envelope as other NIP-46 methods (kind `24133`, NIP-44 encrypted content). Params array contains **one element**: a JSON string of the caller object:

```jsonc
{
  "id": "<random_string>",
  "method": "sign_mls_identity_proof",
  "params": [
    "{\"version\":1,\"mls_ciphersuite\":1,\"mls_signature_public_key\":\"ababababababababababababababababababababababababababababababab\"}"
  ]
}
```

This mirrors `sign_event`, which passes the unsigned event as a JSON string in `params[0]`.

### Response

`result`: hex string, 128 characters — the 64-byte BIP-340 signature.

### Permissions

Connection URIs and `connect` optional permissions should support:

```text
sign_mls_identity_proof
```

in the same comma-separated `method[:constraint]` format as `sign_event:4`. Implementers **may** constrain by proof version, e.g. `sign_mls_identity_proof:1`, so a connection can allow v1 proofs only.

Bunkers **must** show the same structured approval UI as NIP-07 before signing.

### `describe` / capability advertisement

Remote signers that implement this method should include `"sign_mls_identity_proof"` in the `describe` result method list so clients can probe support before requesting a KeyPackage operation.

---

## Client (app) responsibilities

Marmot-capable **clients** (not signers) that build MLS KeyPackages or leaves should:

1. Read the proof `version`, MLS leaf signature public key, and ciphersuite from the generated leaf / KeyPackage.
2. Call `signMlsIdentityProof` / `sign_mls_identity_proof` with `version`, `mls_ciphersuite`, and `mls_signature_public_key`.
3. Embed the returned 64-byte signature in MLS LeafNode extension `0xF2F1` per [account-identity-proof-v1](../../darkmatter/spec/foundation/account-identity-proof-v1.md) (extension payload layout). The extension payload still includes `account_identity`, ciphersuite, scheme, and signature — the **client** fills those from the leaf and signer result when assembling MLS bytes; the signer API does not take them as input.
4. **Not** read raw secret keys when a signer API is available.
5. **Not** ask the user to sign an unexplained 32-byte hash.

Example client call (pseudocode):

```javascript
const signatureHex = await window.nostr.signMlsIdentityProof({
  version: 1,
  mls_ciphersuite: 1,
  mls_signature_public_key: "<leaf signature key hex>",
});
// Pack signatureHex into extension 0xF2F1 per Marmot spec
```

---

## Security considerations

- **Domain separation** prevents a proof signature from being reinterpreted as consent to something else (including Nostr events).
- **Structured prompts** prevent malicious apps from passing off an unrelated hash as a harmless operation.
- **Account identity from local key** prevents callers from supplying another user's pubkey; the binding always uses the signer's own account.
- **Explicit proof version** lets users consent to v1 vs future v2 encodings; signers reject versions they do not implement.
- **Version-derived constants** (`domain`, `extension_type`) prevent silently signing with the wrong proof format when a new Marmot version ships.
- **Ciphersuite-derived signature scheme** prevents callers from claiming an inconsistent algorithm pairing.
- **No digest-only API** closes the “sign arbitrary hash” footgun that would defeat user auditability.

---

## Related specifications

| Document | Content |
| --- | --- |
| [Marmot account-identity-proof-v1](../../darkmatter/spec/foundation/account-identity-proof-v1.md) | Extension payload, validation rules |
| [Marmot identity](../../darkmatter/spec/foundation/identity.md) | Account vs MLS leaf keys |
| [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md) | `window.nostr` |
| [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | Nostr Connect JSON-RPC |
| [BIP-340](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki) | Schnorr signatures for secp256k1 |

---

## Changelog

- **2026-06-10**: Initial draft implementer guide for Marmot MLS account identity proof signing on NIP-07 and NIP-46.
- **2026-06-10**: Reduced caller params; signer resolves domain, extension type, and account identity from version + local key.
- **2026-06-10**: Added required caller `version` (from Marmot proof spec) for v1/v2 dispatch and user auditability.
