# Client State

ClientState contains all the information needed to operate an MLS group.

## What is ClientState?

ClientState is the MLS group state object containing:

- Current encryption keys
- Member list and their credentials
- Group context (including the app-component dictionary)
- Epoch number
- Pending proposals
- Tree structure

Think of it as a snapshot of the group at a specific point in time.

## Extracting Group Information

### Get the Marmot Group View

```typescript
import { getMarmotGroupView } from "@internet-privacy/marmot-ts";

const view = getMarmotGroupView(clientState);

console.log(view?.name); // "Developer Chat"
console.log(view?.adminPubkeys); // ["admin-hex"]
console.log(view?.relays); // ["wss://..."]
```

### Get Group Identifiers

```typescript
import { getGroupIdHex, getNostrGroupIdHex } from "@internet-privacy/marmot-ts";

// MLS group ID
const mlsGroupId = getGroupIdHex(clientState);

// Nostr group ID (from the transport.nostr.routing.v1 component)
const nostrGroupId = getNostrGroupIdHex(clientState);
```

### Get Group Metadata

```typescript
import { getEpoch, getMemberCount } from "@internet-privacy/marmot-ts";

const epoch = getEpoch(clientState); // Current epoch number
const memberCount = getMemberCount(clientState); // Number of members
```

## Serialization

ClientState must be serialized for storage and deserialized when loading.

### Serialize for Storage

```typescript
import { serializeClientState } from "@internet-privacy/marmot-ts";

const serialized = serializeClientState(clientState);
// serialized is Uint8Array (TLS binary format)

// Store in your preferred storage
await storage.save(groupId, serialized);
```

### Deserialize from Storage

```typescript
import { deserializeClientState } from "@internet-privacy/marmot-ts";

const serialized = await storage.load(groupId);

const clientState = deserializeClientState(serialized);
```

### Default Configuration

```typescript
import { defaultMarmotClientConfig } from "@internet-privacy/marmot-ts";

// Default ts-mls configuration used by Marmot helpers.
console.log(defaultMarmotClientConfig);
```

## State Updates

ClientState is immutable - operations return a new state:

```typescript
import { processMessage } from "ts-mls";

// Process a message (commit, proposal)
const result = await processMessage({
  context: {
    cipherSuite: ciphersuiteImpl,
    authService,
    externalPsks: {},
  },
  state: clientState,
  message: mlsMessage,
});

if (result.kind === "newState") {
  clientState = result.newState;
}

// Old state is unchanged; use result.newState going forward when returned.
```

## Epoch Advancement

The epoch advances with each commit:

```typescript
import { getEpoch } from "@internet-privacy/marmot-ts";

console.log("Before commit:", getEpoch(clientState)); // 5

// Process commit
const result = await processMessage({
  context: {
    cipherSuite: ciphersuiteImpl,
    authService,
    externalPsks: {},
  },
  state: clientState,
  message: commit,
});
if (result.kind === "newState") clientState = result.newState;

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
  createSimpleGroup,
  serializeClientState,
  deserializeClientState,
  getMarmotGroupView,
} from "@internet-privacy/marmot-ts";

// 1. Create group (seeds the default app components)
const { clientState } = await createSimpleGroup(
  creatorKeyPackage,
  ciphersuiteImpl,
  "Developer Chat",
  { adminPubkeys: [creatorPubkey], relays: ["wss://relay.example.com"] },
);

// 2. Serialize and store
const serialized = serializeClientState(clientState);
await storage.save(groupId, serialized);

// 3. Later: load from storage
const loaded = await storage.load(groupId);
let restoredState = deserializeClientState(loaded);

// 4. Use the restored state
const view = getMarmotGroupView(restoredState);
console.log("Restored group:", view?.name);
```

## Related

- [Groups](./groups) - Creating initial ClientState
- [Messages](./messages) - Using ClientState for encryption
- [Members](./members) - Querying members from ClientState
