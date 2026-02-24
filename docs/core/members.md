# Members

Query and manage group membership, including multi-device support.

## Querying Members

### Get All Members

```typescript
import { getGroupMembers } from "@internet-privacy/marmots/core";

const members = getGroupMembers(clientState);
// Returns array of Nostr pubkeys (hex strings)

console.log(`Group has ${members.length} members`);
```

## Multi-Device Support

Users can have multiple devices (leaf nodes) in the same group with the same Nostr pubkey.

### Get Leaf Nodes for a Pubkey

```typescript
import { getPubkeyLeafNodes } from "@internet-privacy/marmots/core";

const leafNodes = getPubkeyLeafNodes(clientState, pubkey);
console.log(`${pubkey} has ${leafNodes.length} devices`);
```

### Get Leaf Node Indexes

Needed for remove operations:

```typescript
import { getPubkeyLeafNodeIndexes } from "@internet-privacy/marmots/core";

const indexes = getPubkeyLeafNodeIndexes(clientState, pubkey);
// Returns array of leaf node indexes
```

### Get Indexes by Credential

```typescript
import { getCredentialLeafNodeIndexes } from "@internet-privacy/marmots/core";

const indexes = getCredentialLeafNodeIndexes(clientState, credential);
```

## Removing Members

To remove a member, you need their leaf node indexes:

```typescript
import { getPubkeyLeafNodeIndexes } from "@internet-privacy/marmots/core";
import { createRemove } from "ts-mls";

// Get all leaf nodes for the user
const indexes = getPubkeyLeafNodeIndexes(clientState, targetPubkey);

// Create remove proposals for each leaf node
const removeProposals = indexes.map((index) =>
  createRemove(index, ciphersuiteImpl),
);

// Include in a commit to finalize removal
```

This removes all devices for a user from the group.

## Example: Multi-Device User

```typescript
import {
  getGroupMembers,
  getPubkeyLeafNodes,
  getPubkeyLeafNodeIndexes,
} from "@internet-privacy/marmots/core";

// Get all unique members
const members = getGroupMembers(clientState);

// Check each member's devices
for (const pubkey of members) {
  const leafNodes = getPubkeyLeafNodes(clientState, pubkey);
  console.log(`${pubkey}: ${leafNodes.length} device(s)`);

  if (leafNodes.length > 1) {
    // User has multiple devices
    const indexes = getPubkeyLeafNodeIndexes(clientState, pubkey);
    console.log(`  Leaf indexes: ${indexes.join(", ")}`);
  }
}
```

## Related

- [Credentials](./credentials) - Identity in MLS
- [Messages](./messages) - Sending messages to group members
