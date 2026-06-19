# Messages

Marmot uses MLS for end-to-end encryption and an epoch-scoped group event envelope for Nostr relay distribution.

## Encryption Strategy

### Two-Layer Encryption

1. **MLS Layer:** Encrypts application data with forward secrecy and post-compromise security
2. **Group Event Envelope:** Encrypts the serialized MLS message with a ChaCha20-Poly1305 key derived from the MLS exporter secret

```
Application Data (rumor)
  ↓ MLS Encrypt
MLSMessage
  ↓ group-event encryption (with exporter_secret)
Nostr Event (kind 445)
```

### Key Derivation

```typescript
// Derives encryption key from current MLS epoch
key = MLS_Exporter(exporter_secret, "marmot", "group-event", 32);

// Uses the derived key as a ChaCha20-Poly1305 key
encrypted = ChaCha20Poly1305_Encrypt(key, mlsMessage);
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
import { createGroupEvent } from "@internet-privacy/marmot-ts";

const event = await createGroupEvent({
  message: mlsMessage, // MLSMessage from MLS operations
  state: clientState, // Current MLS ClientState
  ciphersuite: ciphersuiteImpl, // Cryptographic implementation
});

// event is a fully formed Nostr event (including signature)
```

### Ephemeral Signer

The ephemeral signer should generate a new keypair for each event:

```typescript
The Marmot implementation handles per-event ephemeral signing internally.
```

## Decrypting Group Events

### Single Event Decryption

```typescript
import { decryptGroupMessageEvent } from "@internet-privacy/marmot-ts";

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
import { decryptGroupMessages } from "@internet-privacy/marmot-ts";

const { read, unreadable } = await decryptGroupMessages(
  events, // Array of kind 445 events
  clientState,
  ciphersuiteImpl,
);

// `read` contains successfully decrypted `{ event, message }` pairs.
// `unreadable` contains events that could not be decrypted in the current epoch.
```

## Commit Ordering

When multiple admins send commits for the same epoch, Marmot uses deterministic convergence to prevent conflicts ([MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md)).

### Sorting Commits

```typescript
import { sortGroupCommits } from "@internet-privacy/marmot-ts";

// Sort commits by: timestamp → event ID
const sortedPairs = sortGroupCommits(messagePairs);

// Process commits in deterministic order
for (const { event, message } of sortedPairs) {
  // Process commit
}
```

### Ordering Rules

1. **Timestamp (`created_at`):** Earlier timestamp wins
2. **Event ID:** Lexicographically smallest as tiebreaker

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
  id: string; // Required (Nostr event id), even though the rumor is unsigned
  // No 'sig' - unsigned!
}
```

**Why unsigned?**

- Cannot be republished if leaked (no signature to verify)
- Only valid within encrypted MLS context
- Protects against leak exploitation

### Serializing Rumors

```typescript
import { serializeApplicationRumor } from "@internet-privacy/marmot-ts";

const rumor = {
  kind: 1,
  content: "Hello, group!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: senderPubkey,
  id: rumorId,
};

const serialized = serializeApplicationRumor(rumor);
// Use this as MLS application data
```

### Deserializing Rumors

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

// After processing MLS message, extract application data
const rumor = deserializeApplicationData(applicationData);

console.log(rumor.content); // "Hello, group!"
console.log(rumor.pubkey); // Sender's pubkey
```

## Complete Message Flow

### Sending a Message

```typescript
import {
  serializeApplicationRumor,
  createGroupEvent,
} from "@internet-privacy/marmot-ts";
import { createApplicationMessage } from "ts-mls";

// 1. Create rumor
const rumor = {
  kind: 1,
  content: "Hello!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: myPubkey,
  id: rumorId,
};

// 2. Serialize rumor
const appData = serializeApplicationRumor(rumor);

// 3. Encrypt with MLS
const { newState, message } = await createApplicationMessage({
  context: {
    cipherSuite: ciphersuiteImpl,
    authService,
    externalPsks: {},
  },
  state: clientState,
  message: appData,
});

// 4. Create group event
const event = await createGroupEvent({
  message,
  state: clientState,
  ciphersuite: ciphersuiteImpl,
});

// 5. Publish to relays
await network.publish(relays, event);
clientState = newState;
```

### Receiving Messages

```typescript
import {
  decryptGroupMessages,
  sortGroupCommits,
  deserializeApplicationData,
  isApplicationMessage,
  isCommitMessage,
} from "@internet-privacy/marmot-ts";
import { processMessage } from "ts-mls";

// 1. Fetch events from relays
const events = await fetchGroupEvents(relays, groupId);

// 2. Decrypt all events
const { read: pairs, unreadable } = await decryptGroupMessages(
  events,
  clientState,
  ciphersuiteImpl,
);

// 3. Separate commits from application messages
const commits = pairs.filter(isCommitMessage);
const appMessages = pairs.filter(isApplicationMessage);

// 4. Sort and process commits first
const sortedCommits = sortGroupCommits(commits);
for (const { message } of sortedCommits) {
  const result = await processMessage({
    context: {
      cipherSuite: ciphersuiteImpl,
      authService,
      externalPsks: {},
    },
    state: clientState,
    message,
  });
  if (result.kind === "newState") clientState = result.newState;
}

// 5. Process application messages
for (const { message } of appMessages) {
  const result = await processMessage({
    context: {
      cipherSuite: ciphersuiteImpl,
      authService,
      externalPsks: {},
    },
    state: clientState,
    message,
  });
  if (result.kind === "applicationMessage") {
    clientState = result.newState;
    displayMessage(deserializeApplicationData(result.message));
  }
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
- [Protocol](./protocol) - app components and event kinds
