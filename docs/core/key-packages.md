# Key Packages

Key packages are cryptographic bundles that enable adding new members to groups. They contain public key material and supported capabilities.

## What are Key Packages?

A key package is a pre-generated cryptographic bundle that contains:

- Public key material for encryption
- Identity credential (Nostr pubkey)
- Supported capabilities and extensions
- Validity lifetime
- Signature over all the above

Think of it as a "invitation voucher" that someone can use to add you to a group.

## Structure

```typescript
type CompleteKeyPackage = {
  publicPackage: KeyPackage; // Shareable public portion
  privatePackage: PrivateKeyPackage; // Secret private portion (store securely!)
};
```

- **Public Package:** Published to Nostr relays as a kind 30443 addressable event whose content is a base64 `MLSMessage` (`wire_format = mls_key_package`) ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md))
- **Private Package:** Kept secret, used to join the group when added

## Generating Key Packages

```typescript
import { generateKeyPackage } from "@internet-privacy/marmot-ts";
import { createCredential } from "@internet-privacy/marmot-ts";
import {
  ciphersuites,
  defaultCryptoProvider,
} from "@internet-privacy/marmot-ts/mls";

const credential = createCredential(nostrPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

// signer: any applesauce EventSigner (local key, NIP-07, NIP-46) for the
// same pubkey as the credential
const keyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  isLastResort: true,
  signer, // signs the 0x8009 account identity proof
});

// keyPackage.publicPackage - publish this
// keyPackage.privatePackage - store this securely
```

## Marmot Requirements

Every Marmot KeyPackage must ([`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md), [`foundation/identity.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/identity.md)):

- Use a **basic credential** whose identity is the raw 32-byte x-only Nostr pubkey
- Carry exactly one valid account identity proof (`0x8009`) on its LeafNode, signed by the account (`signer`) over the leaf's MLS signature key, and advertise `0x8009` in the leaf's `app_components`
- Advertise the `app_data_dictionary` extension (`0x0006`) and the `app_data_update` (`0x0008`) and `self_remove` (`0x000a`) proposals; new groups require these via `required_capabilities`
- Carry an empty **`last_resort_key_package` component** (`0x0004`) in the KeyPackage's own `app_data_dictionary` extension when reusable key packages are desired (`isLastResort`, default `true`). Last-resort status is not an MLS capability, so it is not advertised in the LeafNode capabilities
- Carry a `Lifetime` no longer than 7,261,200 s (84 days + 1 h)

`generateKeyPackage()` enforces the credential type and lifetime cap (an explicit `lifetime` over the cap throws), adds the `0x8009` proof, and merges the required capabilities (via `ensureMarmotCapabilities`). By default it also:

- sets an 84-day lifetime (with `notBefore` backdated 1 h for clock skew)
- marks the package last-resort (`isLastResort` defaults to `true`; the package carries the empty `0x0004` `last_resort_key_package` component in its own `app_data_dictionary`)
- advertises the agent-text-stream `receive` role (`0xf2d1`)

The ciphersuite is whatever `ciphersuiteImpl` you pass; `0x0001` (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`) is the mandatory-to-implement default ([`foundation/mls-protocol.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/mls-protocol.md)).

## Key Package References

MLS identifies key packages by their "reference" (a hash):

```typescript
import { calculateKeyPackageRef } from "@internet-privacy/marmot-ts";

const ref = await calculateKeyPackageRef(keyPackage.publicPackage);
// ref is the RFC 9420 KeyPackageRef (Uint8Array), computed over the inner
// KeyPackage; it is published as the hex `i` tag on the kind 30443 event
```

## Default Extensions

```typescript
import { keyPackageDefaultExtensions } from "@internet-privacy/marmot-ts";

const extensions = keyPackageDefaultExtensions();
// Returns: [{ extensionType: 0x0006, extensionData: ... }]
// An app_data_dictionary holding the empty last_resort_key_package (0x0004) entry

isLastResortKeyPackage(keyPackage.publicPackage); // true
// (also true for KeyPackages carrying the legacy 0x000a last_resort extension)
```

## Capabilities

Key packages declare which MLS features they support:

```typescript
import {
  defaultCapabilities,
  ensureMarmotCapabilities,
} from "@internet-privacy/marmot-ts";

// Get Marmot-compliant default capabilities
const caps = defaultCapabilities();

// Or ensure existing capabilities include Marmot requirements
const updated = ensureMarmotCapabilities(myCapabilities);
```

`defaultCapabilities()` advertises ciphersuite `0x0001` (plus GREASE values), `basic` credentials only, the extensions `0x0006` (`app_data_dictionary`) and `0xf2d1` (agent-text-stream `receive` role), and the proposals `0x0008` (`app_data_update`) and `0x000a` (`self_remove`). `ensureMarmotCapabilities()` adds the same extensions and proposals without filtering ciphersuites or credential types.

## Lifecycle

1. **Generate:** Create the key package (public/private parts)
2. **Publish:** Kind 30443 event in a stable random `d` slot, to your NIP-65 write relays
3. **Store:** Keep the private package locally
4. **Consume:** An admin adds you; you process the Welcome with the private package (see [Welcome Messages](./welcome))
5. **Replace:** After a _successful_ Welcome, publish a fresh KeyPackage in the **same** `d` slot (`client.keyPackages.rotate(ref)`), which then deletes the old private material
   - a non-last-resort `init_key` MUST be deleted after the successful Welcome
   - a last-resort `init_key` MUST be deleted at the earlier of confirmed replacement or `Lifetime.not_after`
6. **On failure:** if Welcome processing fails, do NOT rotate or delete; the inviter may retry

After joining, also call `group.selfUpdate()` promptly to refresh your leaf key material ([`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md)). The library does not do this automatically.

::: warning Spec deviation
[`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md) requires deleting a consumed KeyPackage's private material (above). `client.joinGroupFromWelcome` only marks the consumed package as used; your app must call `client.keyPackages.rotate(ref)` (or `remove` / `purge`) itself, for example for each entry in `(await client.keyPackages.list()).filter((p) => p.used)`.
:::

## Security Considerations

### Private Package Storage

- **Never publish** the private package; treat it like a private key
- Store it encrypted and access-controlled
- Delete a consumed single-use package's private material after a successful Welcome (MUST)
- Delete a last-resort package's private material once a replacement is confirmed published, or at `not_after`, whichever comes first (MUST)

### Rotation Strategy

- Publish a replacement after each successful join (SHOULD), reusing the same `d` slot
- Replace well before the 84-day lifetime expires
- Use `client.keyPackages.purge(refs)` to retire a slot entirely (publishes a NIP-09 delete)

### Last Resort

- Optional: marks a KeyPackage as reusable for multiple joins, which avoids exhaustion while the account is offline
- A non-last-resort KeyPackage MUST NOT carry the marker; inviters prefer non-last-resort candidates when available
- Reuse widens the exposure if the `init_key` is compromised: every Welcome encrypted to it becomes decryptable

## Example: Full Workflow

```typescript
import {
  generateKeyPackage,
  calculateKeyPackageRef,
  createCredential,
  createKeyPackageEvent,
} from "@internet-privacy/marmot-ts";
import {
  ciphersuites,
  defaultCryptoProvider,
} from "@internet-privacy/marmot-ts/mls";
import type { EventSigner } from "applesauce-core/factories";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

// Stubs for your app's own environment:
declare const myPubkey: string;
declare const signer: EventSigner; // same pubkey as myPubkey
declare const myWriteRelays: string[]; // getNip65Relays(myRelayList, "write")
declare function loadSetting(key: string): Promise<string | undefined>;
declare function saveSetting(key: string, value: string): Promise<void>;
// plus `client` (MarmotClient) and `network` (NostrNetworkInterface)

const credential = createCredential(myPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

// 1. Generate key package
const kp = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  signer, // signs the 0x8009 account identity proof
});

// 2. Calculate reference for storage
const ref = await calculateKeyPackageRef(kp.publicPackage);

// The `d` slot id: 32 random bytes as lowercase hex, generated ONCE per
// installation, persisted, and reused for every replacement. Never derive it
// from a device label or identity material.
const slotId =
  (await loadSetting("keyPackageSlot")) ?? bytesToHex(randomBytes(32));
await saveSetting("keyPackageSlot", slotId);

// 3. Store private package securely
await client.keyPackages.add({ ...kp, identifier: slotId });

// 4. Publish public package to your NIP-65 write relays
const event = await createKeyPackageEvent({
  keyPackage: kp.publicPackage,
  identifier: slotId,
});
const signed = await signer.signEvent(event);
await network.publish(myWriteRelays, signed);

// 5. Someone adds me to a group using this key package
// 6. I receive Welcome message and use private package to join
```

The manual flow above leaves the store without a publish record, so `rotate()` and `purge()` cannot find the event later. Prefer `client.keyPackages.create(...)`, which generates, stores, signs, publishes, and records the event in one call:

```typescript
// Pass the persisted slot id per call, or once via `clientId` on MarmotClient
await client.keyPackages.create({
  relays: myWriteRelays,
  identifier: slotId,
});
```

::: warning Spec deviation
The kind 30443 tag set in [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md) has no `relays` tag ("KeyPackage events do not repeat those relays"). `createKeyPackageEvent` emits one whenever `relays` is passed, and `client.keyPackages.create` / `rotate` always pass it (`rotate` reads it back to pick relays).
:::

## Related

- [Key Package Distribution](./distribution) - Publishing and discovering key packages
- [Welcome Messages](./welcome) - Using key packages to join groups
- [Credentials](./credentials) - Identity in key packages
