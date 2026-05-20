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

- **Public Package:** Published to Nostr relays (kind 30443 addressable events; legacy kind 443 is read/delete compatible)
- **Private Package:** Kept secret, used to join the group when added

## Generating Key Packages

```typescript
import { generateKeyPackage } from "@internet-privacy/marmot-ts";
import { createCredential } from "@internet-privacy/marmot-ts";
import { ciphersuites, defaultCryptoProvider } from "ts-mls";

const credential = createCredential(nostrPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

const keyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  isLastResort: true,
});

// keyPackage.publicPackage - publish this
// keyPackage.privatePackage - store this securely
```

## Marmot Requirements

All Marmot key packages must:

- Use **basic credentials** (Nostr pubkeys)
- Support **Marmot Group Data Extension** (0xf2ee)
- Include **last_resort extension** (0x000a) when reusable key packages are desired
- Only use `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` ciphersuite
- Have default lifetime of 3 months (configurable)

These requirements are automatically enforced by `generateKeyPackage()`.

## Key Package References

MLS identifies key packages by their "reference" (a hash):

```typescript
import { calculateKeyPackageRef } from "@internet-privacy/marmot-ts";

const ref = calculateKeyPackageRef(keyPackage.publicPackage, ciphersuiteImpl);

// ref is a Uint8Array used as the key package identifier
```

## Default Extensions

```typescript
import { keyPackageDefaultExtensions } from "@internet-privacy/marmot-ts";

const extensions = keyPackageDefaultExtensions();
// Returns: [{ extensionType: 0x000a, extensionData: ... }]
// Includes last_resort extension
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

## Lifecycle

1. **Generate:** Create key package with public/private parts
2. **Publish:** Share public package via Nostr (kind 30443 event)
3. **Store:** Securely store private package locally
4. **Consume:** When someone adds you to a group, use private package to join
5. **Rotate:** Generate new key packages periodically or after use

## Security Considerations

### Private Package Storage

- **Never publish** the private package
- Store encrypted and access-controlled
- Treat like private keys
- Delete after use (or keep for last_resort)

### Rotation Strategy

- Generate new key packages after joining groups
- Rotate every 30-90 days for security
- Delete old private packages after use

### Last Resort Extension

- Marks key package as reusable
- Prevents key exhaustion attacks
- Required by Marmot protocol

## Example: Full Workflow

```typescript
import {
  generateKeyPackage,
  calculateKeyPackageRef,
  createCredential,
  createKeyPackageEvent,
} from "@internet-privacy/marmot-ts";
import { ciphersuites, defaultCryptoProvider } from "ts-mls";

const credential = createCredential(myPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

// 1. Generate key package
const kp = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
});

// 2. Calculate reference for storage
const ref = await calculateKeyPackageRef(kp.publicPackage);

// 3. Store private package securely
await client.keyPackages.add(kp);

// 4. Publish public package to Nostr
const event = await createKeyPackageEvent({
  keyPackage: kp.publicPackage,
  identifier: "my-app-desktop",
  relays: myRelays,
});
const signed = await signer.signEvent(event);
await network.publish(myRelays, signed);

// 5. Someone adds me to a group using this key package
// 6. I receive Welcome message and use private package to join
```

## Related

- [Key Package Distribution](./distribution) - Publishing and discovering key packages
- [Welcome Messages](./welcome) - Using key packages to join groups
- [Credentials](./credentials) - Identity in key packages
