# Client State

ClientState contains all the information needed to operate an MLS group.

## What is ClientState?

ClientState is the MLS group state object containing:

- Current encryption keys
- Member list and their credentials
- Group context (including MarmotGroupData)
- Epoch number
- Pending proposals
- Tree structure

Think of it as a snapshot of the group at a specific point in time.

## Extracting Group Information

### Get Marmot Group Data

```typescript
import { extractMarmotGroupData } from "@internet-privacy/marmots";

const groupData = extractMarmotGroupData(clientState);

console.log(groupData.name); // "Developer Chat"
console.log(groupData.adminPubkeys); // ["admin-hex"]
console.log(groupData.relays); // ["wss://..."]
```

### Get Group Identifiers

```typescript
import { getGroupIdHex, getNostrGroupIdHex } from "@internet-privacy/marmots";

// MLS group ID
const mlsGroupId = getGroupIdHex(clientState);

// Nostr group ID (from MarmotGroupData)
const nostrGroupId = getNostrGroupIdHex(clientState);
```

### Get Group Metadata

```typescript
import { getEpoch, getMemberCount } from "@internet-privacy/marmots";

const epoch = getEpoch(clientState); // Current epoch number
const memberCount = getMemberCount(clientState); // Number of members
```

## Serialization

ClientState must be serialized for storage and deserialized when loading.

### Serialize for Storage

```typescript
import { serializeClientState } from "@internet-privacy/marmots";

const serialized = serializeClientState(clientState);
// serialized is Uint8Array (TLS binary format)

// Store in your preferred storage
await storage.save(groupId, serialized);
```

### Deserialize from Storage

```typescript
import { deserializeClientState } from "@internet-privacy/marmots";
import { CipherSuite, getCipherSuiteById } from "ts-mls";

const serialized = await storage.load(groupId);

const clientState = deserializeClientState(
  serialized,
  getCipherSuiteById(CipherSuite.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519),
  defaultMarmotClientConfig, // Includes credential validation
);
```

### Default Configuration

```typescript
import { defaultMarmotClientConfig } from "@internet-privacy/marmots";

// Includes marmotAuthService for credential validation
const clientState = deserializeClientState(
  data,
  ciphersuite,
  defaultMarmotClientConfig,
);
```

## State Updates

ClientState is immutable - operations return a new state:

```typescript
import { processMessage } from "ts-mls";

// Process a message (commit, proposal)
const newState = processMessage(clientState, mlsMessage, ciphersuiteImpl);

// Old state is unchanged, use newState going forward
clientState = newState;
```

## Epoch Advancement

The epoch advances with each commit:

```typescript
import { getEpoch } from "@internet-privacy/marmots";

console.log("Before commit:", getEpoch(clientState)); // 5

// Process commit
clientState = processMessage(clientState, commit, ciphersuiteImpl);

console.log("After commit:", getEpoch(clientState)); // 6
```

Each epoch has unique encryption keys. Messages from epoch N can only be decrypted by members in epoch N.

## Storage Considerations

### Security

- ClientState contains secret key material
- Store encrypted and access-controlled
- Never transmit over unencrypted channels

### Size

- Grows with group history and member count
- Binary format is compact (~few KB for typical groups)
- Consider periodic re-initialization for very large groups

### Backup

- Always back up ClientState after changes
- Loss means inability to decrypt future messages
- Cannot recover old states (forward secrecy)

## Example: Full State Lifecycle

```typescript
import {
  createGroup,
  serializeClientState,
  deserializeClientState,
  extractMarmotGroupData,
  defaultMarmotClientConfig,
} from "@internet-privacy/marmots";

// 1. Create group
const { clientState } = await createGroup({
  creatorKeyPackage,
  marmotGroupData,
  ciphersuiteImpl,
});

// 2. Serialize and store
const serialized = serializeClientState(clientState);
await storage.save(groupId, serialized);

// 3. Later: load from storage
const loaded = await storage.load(groupId);
let restoredState = deserializeClientState(
  loaded,
  ciphersuiteImpl,
  defaultMarmotClientConfig,
);

// 4. Use the restored state
const groupData = extractMarmotGroupData(restoredState);
console.log("Restored group:", groupData.name);
```

## Related

- [Groups](./groups) - Creating initial ClientState
- [Messages](./messages) - Using ClientState for encryption
- [Members](./members) - Querying members from ClientState
