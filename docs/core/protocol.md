# Protocol Constants & Concepts

## Protocol Constants

### Event Kinds

Marmot uses specific Nostr event kinds for different purposes:

```typescript
import {
  KEY_PACKAGE_KIND, // 443
  WELCOME_EVENT_KIND, // 444
  GROUP_EVENT_KIND, // 445
  KEY_PACKAGE_RELAY_LIST_KIND, // 10051
} from "@internet-privacy/marmots";
```

- **443 (KEY_PACKAGE_KIND):** Key package advertisement events
- **444 (WELCOME_EVENT_KIND):** Welcome messages for new members (wrapped in NIP-59 gift wraps)
- **445 (GROUP_EVENT_KIND):** Group messages (commits, proposals, application messages)
- **10051 (KEY_PACKAGE_RELAY_LIST_KIND):** Relay lists for key package discovery

### Extension Types

MLS extensions used by Marmot:

```typescript
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE, // 0xf2ee
  LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE, // 0x000a
} from "@internet-privacy/marmots";
```

- **0xf2ee (MARMOT_GROUP_DATA_EXTENSION_TYPE):** Custom extension containing Marmot group metadata ([MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md))
- **0x000a (LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE):** Marks key packages as reusable

### Protocol Versions

```typescript
import { MLS_VERSIONS } from "@internet-privacy/marmots";

console.log(MLS_VERSIONS); // "1.0"
```

## MarmotGroupData Extension

The `MarmotGroupData` extension is the centerpiece of Marmot's integration between MLS and Nostr. It's embedded in the MLS group context and cryptographically bound to the group state.

### Structure

```typescript
interface MarmotGroupData {
  version: number; // Extension version (current: 1)
  nostrGroupId: Uint8Array; // 32-byte unique group identifier
  name: string; // Human-readable group name
  description: string; // Group description
  adminPubkeys: string[]; // Array of admin Nostr pubkeys (hex)
  relays: string[]; // WebSocket URLs for group relays
  imageHash: Uint8Array | null; // SHA-256 hash of encrypted image
  imageKey: Uint8Array | null; // ChaCha20-Poly1305 encryption key for image
  imageNonce: Uint8Array | null; // ChaCha20-Poly1305 nonce for image
}
```

### Purpose

- **Links MLS groups to Nostr:** Provides Nostr group ID and relay information
- **Defines admin policy:** Specifies which pubkeys can send commits
- **Stores metadata:** Group name, description, and image information accessible to all members
- **Enables relay routing:** Tells clients where to publish/fetch group messages

### Encoding/Decoding

```typescript
import {
  encodeMarmotGroupData,
  decodeMarmotGroupData,
  marmotGroupDataToExtension,
} from "@internet-privacy/marmots";

// Create group data
const groupData: MarmotGroupData = {
  version: 1,
  nostrGroupId: crypto.getRandomValues(new Uint8Array(32)),
  name: "Developer Chat",
  description: "A group for TypeScript developers",
  adminPubkeys: ["admin-pubkey-hex"],
  relays: ["wss://relay.example.com"],
  imageHash: null,
  imageKey: null,
  imageNonce: null,
};

// Convert to MLS extension
const extension = marmotGroupDataToExtension(groupData);

// Encode to binary (for storage or transmission)
const encoded = encodeMarmotGroupData(groupData);

// Later: decode from binary
const decoded = decodeMarmotGroupData(encoded);
```

### Admin Verification

```typescript
import { isAdmin } from "@internet-privacy/marmots";

const userIsAdmin = isAdmin(groupData, userPubkey);
if (userIsAdmin) {
  // User can send commits
}
```

### Forward Compatibility

The `decodeMarmotGroupData` function handles future versions gracefully:

- Unknown fields are ignored
- Version field indicates structure version
- Warnings are logged for newer versions

## Specification Reference

See [MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md) for the complete MarmotGroupData extension specification.
