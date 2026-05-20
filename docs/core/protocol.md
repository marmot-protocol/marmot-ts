---
heroImage: /images/marmot-protocol.png
heroImageAlt: A pixel-art marmot in uniform holding a clipboard next to a stone tablet with checkmarks
---

# Protocol Constants & Concepts

## Protocol Constants

### Event Kinds

Marmot uses specific Nostr event kinds for different purposes:

```typescript
import {
  KEY_PACKAGE_KIND, // 443 (legacy)
  ADDRESSABLE_KEY_PACKAGE_KIND, // 30443
  WELCOME_EVENT_KIND, // 444
  GROUP_EVENT_KIND, // 445
  KEY_PACKAGE_RELAY_LIST_KIND, // 10051
} from "@internet-privacy/marmot-ts";
```

- **443 (KEY_PACKAGE_KIND):** Legacy key package advertisement events (read/delete compatibility)
- **30443 (ADDRESSABLE_KEY_PACKAGE_KIND):** Addressable key package advertisement events published by current clients
- **444 (WELCOME_EVENT_KIND):** Welcome messages for new members (wrapped in NIP-59 gift wraps)
- **445 (GROUP_EVENT_KIND):** Group messages (commits, proposals, application messages)
- **10051 (KEY_PACKAGE_RELAY_LIST_KIND):** Relay lists for key package discovery

### Extension Types

MLS extensions used by Marmot:

```typescript
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE, // 0xf2ee
  LAST_RESORT_EXTENSION_TYPE, // 0x000a
} from "@internet-privacy/marmot-ts";
```

- **0xf2ee (MARMOT_GROUP_DATA_EXTENSION_TYPE):** Custom extension containing Marmot group metadata ([MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md))
- **0x000a (LAST_RESORT_EXTENSION_TYPE):** Marks key packages as reusable

### Protocol Versions

Key package events use MLS protocol version tag value `"1.0"`. The exported `MLS_VERSIONS` name is a TypeScript type alias for supported values.

## MarmotGroupData Extension

The `MarmotGroupData` extension is the centerpiece of Marmot's integration between MLS and Nostr. It's embedded in the MLS group context and cryptographically bound to the group state.

### Structure

```typescript
interface MarmotGroupData {
  version: number; // Extension version (current: 2)
  nostrGroupId: Uint8Array; // 32-byte unique group identifier
  name: string; // Human-readable group name
  description: string; // Group description
  adminPubkeys: string[]; // Array of admin Nostr pubkeys (hex)
  relays: string[]; // WebSocket URLs for group relays
  imageHash: Uint8Array; // Empty or 32-byte SHA-256 hash of encrypted image
  imageKey: Uint8Array; // Empty or 32-byte image encryption seed
  imageNonce: Uint8Array; // Empty or 12-byte ChaCha20-Poly1305 nonce for image
  imageUploadKey: Uint8Array; // Empty or 32-byte Blossom upload identity seed
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
} from "@internet-privacy/marmot-ts";

// Create group data
const groupData: MarmotGroupData = {
  version: 2,
  nostrGroupId: crypto.getRandomValues(new Uint8Array(32)),
  name: "Developer Chat",
  description: "A group for TypeScript developers",
  adminPubkeys: ["admin-pubkey-hex"],
  relays: ["wss://relay.example.com"],
  imageHash: new Uint8Array(0),
  imageKey: new Uint8Array(0),
  imageNonce: new Uint8Array(0),
  imageUploadKey: new Uint8Array(0),
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
import { isAdmin } from "@internet-privacy/marmot-ts";

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
