# Messages

Marmot uses a two-layer encryption approach for group messages: MLS for end-to-end encryption and NIP-44 for Nostr relay distribution.

## Encryption Strategy

### Two-Layer Encryption

1. **MLS Layer:** Encrypts application data with forward secrecy and post-compromise security
2. **NIP-44 Layer:** Encrypts the MLS message for Nostr relay distribution

```
Application Data (rumor)
  ↓ MLS Encrypt
MLSMessage
  ↓ NIP-44 Encrypt (with exporter_secret)
Nostr Event (kind 445)
```

### Key Derivation

```typescript
// Derives encryption key from current MLS epoch
exporter_secret = MLS_Exporter(clientState, "marmot group message", epoch);

// Uses exporter_secret as NIP-44 encryption key
encrypted = NIP44_Encrypt(exporter_secret, mlsMessage);
```

This approach:

- Prevents key reuse across epochs
- Provides epoch-based key rotation
- Maintains forward secrecy
- Compatible with Nostr event model

### Privacy Features

- **Ephemeral Signing:** Group events signed with ephemeral keys (not user's identity key)
- **Unlinkability:** Events cannot be tied to specific users by observers
- **Rumor-Based:** Application messages are unsigned events (can't be republished if leaked)

## Creating Group Events

### Encrypt and Create Event

```typescript
import { createGroupEvent } from "@internet-privacy/marmots/core";

const event = await createGroupEvent(
  mlsMessage, // MLSMessage from MLS operations
  nostrGroupId, // 32-byte group identifier
  clientState, // Current MLS group state
  ciphersuiteImpl, // Cryptographic implementation
  ephemeralSignerFn, // Function to sign with ephemeral key
);

// event is an unsigned NostrEvent (rumor)
// Sign it before publishing to relays
```

### Ephemeral Signer

The ephemeral signer should generate a new keypair for each event:

```typescript
async function ephemeralSigner(event: UnsignedEvent): Promise<string> {
  const ephemeralKey = generatePrivateKey();
  const signed = finishEvent(event, ephemeralKey);
  return signed.id;
}
```

## Decrypting Group Events

### Single Event Decryption

```typescript
import { decryptGroupMessageEvent } from "@internet-privacy/marmots/core";

try {
  const mlsMessage = await decryptGroupMessageEvent(
    event, // Nostr event (kind 445)
    clientState, // Current MLS group state
    ciphersuiteImpl, // Cryptographic implementation
  );
  // mlsMessage ready for MLS processing
} catch (error) {
  // Decryption failed (wrong epoch, corrupted data, etc.)
}
```

### Batch Decryption

For multiple events with error handling:

```typescript
import { readGroupMessages } from "@internet-privacy/marmots/core";

const pairs = await readGroupMessages(
  events, // Array of kind 445 events
  clientState,
  ciphersuiteImpl,
);

// pairs is an array of { event, message } objects
// Only successfully decrypted messages are included
// Failed decryptions are silently skipped
```

## Commit Ordering

When multiple admins send commits for the same epoch, Marmot uses deterministic ordering to prevent conflicts ([MIP-03](https://github.com/parres-hq/marmot/blob/main/03.md)).

### Sorting Commits

```typescript
import { sortGroupCommits } from "@internet-privacy/marmots/core";

// Sort commits by: epoch → timestamp → event ID
const sortedPairs = sortGroupCommits(messagePairs);

// Process commits in deterministic order
for (const { event, message } of sortedPairs) {
  // Process commit
}
```

### Ordering Rules

1. **Epoch number:** Lower epochs processed first
2. **Timestamp (`created_at`):** Earlier timestamp wins
3. **Event ID:** Lexicographically smallest as tiebreaker

This ensures all group members converge to the same state regardless of message arrival order.

## Application Messages

Application messages are the actual content users send (chat messages, files, etc.). They're wrapped as "rumors" (unsigned Nostr events) and encrypted within MLS messages.

### What are Rumors?

A rumor is an unsigned Nostr event:

```typescript
interface Rumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string; // Sender's real pubkey
  // No 'id' or 'sig' - unsigned!
}
```

**Why unsigned?**

- Cannot be republished if leaked (no signature to verify)
- Only valid within encrypted MLS context
- Protects against leak exploitation

### Serializing Rumors

```typescript
import { serializeApplicationRumor } from "@internet-privacy/marmots/core";

const rumor = {
  kind: 1,
  content: "Hello, group!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: senderPubkey,
};

const serialized = serializeApplicationRumor(rumor);
// Use this as MLS application data
```

### Deserializing Rumors

```typescript
import { deserializeApplicationRumor } from "@internet-privacy/marmots/core";

// After processing MLS message, extract application data
const rumor = deserializeApplicationRumor(applicationData);

console.log(rumor.content); // "Hello, group!"
console.log(rumor.pubkey); // Sender's pubkey
```

## Complete Message Flow

### Sending a Message

```typescript
import {
  serializeApplicationRumor,
  createGroupEvent,
  getNostrGroupIdHex,
} from "@internet-privacy/marmots/core";
import { createApplicationMessage } from "ts-mls";

// 1. Create rumor
const rumor = {
  kind: 1,
  content: "Hello!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: myPubkey,
};

// 2. Serialize rumor
const appData = serializeApplicationRumor(rumor);

// 3. Encrypt with MLS
const mlsMessage = createApplicationMessage(
  clientState,
  appData,
  ciphersuiteImpl,
);

// 4. Create group event
const event = await createGroupEvent(
  mlsMessage,
  hexToBytes(getNostrGroupIdHex(clientState)),
  clientState,
  ciphersuiteImpl,
  ephemeralSigner,
);

// 5. Publish to relays
await publishEvent(signEvent(event), relays);
```

### Receiving Messages

```typescript
import {
  readGroupMessages,
  sortGroupCommits,
  deserializeApplicationRumor,
} from "@internet-privacy/marmots/core";
import { processMessage } from "ts-mls";

// 1. Fetch events from relays
const events = await fetchGroupEvents(relays, groupId);

// 2. Decrypt all events
const pairs = await readGroupMessages(events, clientState, ciphersuiteImpl);

// 3. Separate commits from application messages
const commits = pairs.filter((p) => isCommit(p.message));
const appMessages = pairs.filter((p) => isApplicationMessage(p.message));

// 4. Sort and process commits first
const sortedCommits = sortGroupCommits(commits);
for (const { message } of sortedCommits) {
  clientState = processMessage(clientState, message, ciphersuiteImpl);
}

// 5. Process application messages
for (const { message } of appMessages) {
  const rumor = deserializeApplicationRumor(message.message.applicationData);
  displayMessage(rumor);
}
```

## Privacy Properties

### Ephemeral Signing

Group events are signed with ephemeral keys:

- Each event uses a different keypair
- Events cannot be linked to sender's identity
- Observers see random pubkeys, not real identities

### Encrypted Sender Identity

- Sender's real pubkey is in the rumor (inner event)
- Rumor is encrypted with MLS
- Only group members can see who sent what
- Relays and observers see only encrypted data

### Unlinkability

- Events cannot be tied to specific users
- Timing analysis is harder (many users, ephemeral keys)
- Content completely opaque to non-members

## Related

- [Groups](./groups) - Creating groups to send messages in
- [Client State](./state) - Managing group state for encryption
- [Protocol](./protocol) - MarmotGroupData and event kinds
