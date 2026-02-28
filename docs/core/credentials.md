# Credentials

MLS uses credentials to identify group members. Marmot uses the "basic" credential type, storing Nostr public keys as identities.

## What are MLS Credentials?

In MLS, every group member has a credential that identifies them. Marmot maps Nostr public keys (used for signing Nostr events) to MLS basic credentials.

### Identity vs Signature Keys

MLS separates two concepts:

- **Identity:** Who you are (Nostr pubkey stored in credential)
- **Signature Public Key:** Key used to sign MLS messages (separate from identity)

This separation allows for key rotation and device-specific signing keys while maintaining a stable identity.

## Creating Credentials

```typescript
import { createCredential } from "@internet-privacy/marmots";

// Create MLS credential from Nostr pubkey (hex string)
const credential = createCredential(nostrPubkey);
```

The credential embeds the Nostr public key as the identity.

## Extracting Pubkeys

```typescript
import { getCredentialPubkey } from "@internet-privacy/marmots";

// Get Nostr pubkey from MLS credential
const pubkey = getCredentialPubkey(credential);
```

Returns the Nostr public key as a hex string.

## Comparing Credentials

```typescript
import { isSameCredential } from "@internet-privacy/marmots";

if (isSameCredential(credential1, credential2)) {
  // Same identity (same Nostr pubkey)
}
```

## Identity Format

- **Current Format:** 32-byte Nostr public key (hex-encoded)
- **Legacy Format:** UTF-8 encoded pubkey (backward compatible)
- **Credential Type:** Always "basic" (no x509 support)

## Example: Full Flow

```typescript
import {
  createCredential,
  getCredentialPubkey,
  isSameCredential,
} from "@internet-privacy/marmots";

// User's Nostr pubkey
const myPubkey = "0x1234...";

// Create credential for group membership
const myCredential = createCredential(myPubkey);

// Later: verify it's me
const extractedPubkey = getCredentialPubkey(myCredential);
assert(extractedPubkey === myPubkey);

// Compare with another credential
const otherCredential = createCredential("0x5678...");
assert(!isSameCredential(myCredential, otherCredential));
```

## Authentication

Credentials are validated by the `marmotAuthService`:

```typescript
import { marmotAuthService } from "@internet-privacy/marmots";

// Used internally by MLS library
const isValid = await marmotAuthService.validateCredential(
  credential,
  signaturePublicKey,
);
```

**Current Implementation:**

- Validates credential type is "basic"
- Accepts all valid basic credentials
- MLS library handles cryptographic signature verification

**Future Extensions:**

- Could add Nostr-specific validation (e.g., NIP-05 verification)
- Could integrate with web-of-trust systems
- Could require additional attestations

## Related

- [Key Packages](./key-packages) - Use credentials in key package generation
- [Members](./members) - Query members by credential
