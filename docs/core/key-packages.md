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

- **Public Package:** Published to Nostr relays (kind 443 events)
- **Private Package:** Kept secret, used to join the group when added

## Generating Key Packages

```typescript
import { generateKeyPackage } from "@internet-privacy/marmots";
import { CipherSuite } from "ts-mls";

const keyPackage = await generateKeyPackage({
  pubkey: nostrPubkey,
  ciphersuite: CipherSuite.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
  lifetime: 7776000, // 90 days in seconds (optional)
});

// keyPackage.publicPackage - publish this
// keyPackage.privatePackage - store this securely
```

## Marmot Requirements

All Marmot key packages must:

- Use **basic credentials** (Nostr pubkeys)
- Support **Marmot Group Data Extension** (0xf2ee)
- Include **last_resort extension** (0x000a) for reusability
- Only use `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` ciphersuite
- Have default lifetime of 3 months (configurable)

These requirements are automatically enforced by `generateKeyPackage()`.

## Key Package References

MLS identifies key packages by their "reference" (a hash):

```typescript
import { calculateKeyPackageRef } from "@internet-privacy/marmots";

const ref = calculateKeyPackageRef(keyPackage.publicPackage, ciphersuiteImpl);

// ref is a Uint8Array used as the key package identifier
```

## Default Extensions

```typescript
import { keyPackageDefaultExtensions } from "@internet-privacy/marmots";

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
} from "@internet-privacy/marmots";

// Get Marmot-compliant default capabilities
const caps = defaultCapabilities();

// Or ensure existing capabilities include Marmot requirements
const updated = ensureMarmotCapabilities(myCapabilities);
```

## Lifecycle

1. **Generate:** Create key package with public/private parts
2. **Publish:** Share public package via Nostr (kind 443 event)
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
} from "@internet-privacy/marmots";
import { CipherSuite } from "ts-mls";

// 1. Generate key package
const kp = await generateKeyPackage({
  pubkey: myPubkey,
  ciphersuite: CipherSuite.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
});

// 2. Calculate reference for storage
const ref = calculateKeyPackageRef(kp.publicPackage, ciphersuiteImpl);

// 3. Store private package securely
await keyPackageStore.set(ref, kp);

// 4. Publish public package to Nostr
const event = createKeyPackageEvent({
  keyPackage: kp.publicPackage,
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
