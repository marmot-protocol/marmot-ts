# Groups

Groups are the foundation of Marmot messaging. A group contains members who can exchange encrypted messages.

## What is a Group?

An MLS group is a cryptographic context where:

- Members share encryption keys
- Messages are end-to-end encrypted
- Members can be added or removed
- Keys rotate with each state change (epoch)

Marmot extends MLS groups with Nostr-specific metadata via the MarmotGroupData extension.

## Creating a Group

```typescript
import { createGroup } from "@internet-privacy/marmot-ts";
import { ciphersuites, defaultCryptoProvider } from "ts-mls";

const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

const result = await createGroup({
  creatorKeyPackage: myKeyPackage,
  marmotGroupData: groupData,
  ciphersuiteImpl,
  extensions: [], // Optional additional extensions
});

// result.clientState contains the MLS group state
```

### Parameters

- **creatorKeyPackage:** Your complete key package (public + private)
- **marmotGroupData:** Group metadata (name, description, relays, admins)
- **ciphersuiteImpl:** Cryptographic implementation
- **extensions:** (Optional) Additional MLS extensions

### Returns

```typescript
interface CreateGroupResult {
  clientState: ClientState; // The MLS group state
}
```

## Simplified Creation

For testing or simple use cases:

```typescript
import { createSimpleGroup } from "@internet-privacy/marmot-ts";

const { clientState } = await createSimpleGroup(
  myKeyPackage,
  ciphersuiteImpl,
  "Group Name",
  {
    relays,
    adminPubkeys,
  },
);
```

## Group Initialization Process

When you create a group:

1. **Creates MLS Group:** Initializes MLS group with creator as sole member
2. **Embeds Metadata:** Adds Marmot Group Data Extension to group context
3. **Generates Secrets:** Creates initial encryption keys
4. **Returns State:** Provides ClientState for ongoing operations

## ClientState

The `ClientState` object contains everything needed to operate the group:

- Current encryption keys
- Member list and their credentials
- Group context (including MarmotGroupData)
- Epoch number
- Pending proposals

**Important:** ClientState must be serialized and stored for persistence. See [Client State](./state) for details.

## Example: Complete Group Creation

```typescript
import {
  generateKeyPackage,
  createGroup,
  createCredential,
  getNostrGroupIdHex,
} from "@internet-privacy/marmot-ts";
import { ciphersuites, defaultCryptoProvider } from "ts-mls";

const credential = createCredential(myPubkey);
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

// 1. Generate creator's key package
const myKeyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
});

// 2. Define group metadata
const groupData = {
  version: 2,
  nostrGroupId: crypto.getRandomValues(new Uint8Array(32)),
  name: "Developer Chat",
  description: "A group for TypeScript developers",
  adminPubkeys: [myPubkey],
  relays: ["wss://relay.damus.io", "wss://relay.snort.social"],
  imageHash: new Uint8Array(0),
  imageKey: new Uint8Array(0),
  imageNonce: new Uint8Array(0),
  imageUploadKey: new Uint8Array(0),
};

// 3. Create the group
const { clientState } = await createGroup({
  creatorKeyPackage: myKeyPackage,
  marmotGroupData: groupData,
  ciphersuiteImpl,
});

// 4. Group is ready to use!
console.log("Group created with ID:", getNostrGroupIdHex(clientState));
```

## Group Metadata

Every Marmot group has associated metadata:

```typescript
import { getMarmotGroupData } from "@internet-privacy/marmot-ts";

const groupData = getMarmotGroupData(clientState);

console.log(groupData.name); // "Developer Chat"
console.log(groupData.description); // "A group for..."
console.log(groupData.relays); // ["wss://..."]
console.log(groupData.adminPubkeys); // ["admin-hex"]
```

See [Protocol Constants & Concepts](./protocol) for MarmotGroupData details.

## Related

- [Client State](./state) - Managing and persisting group state
- [Messages](./messages) - Sending messages in groups
- [Members](./members) - Managing group membership
- [Protocol](./protocol) - MarmotGroupData extension details
