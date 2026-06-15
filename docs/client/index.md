---
heroImage: /images/marmot-features.png
heroImageAlt: A pixel-art marmot surrounded by glowing icons for encryption, decentralization, key management, and relay connectivity
---

# Client Module

The Client module (`marmot-ts/client`) provides a high-level, production-ready implementation for building Marmot applications.

## What's in the Client Module

- **MarmotClient:** Multi-group orchestration with lifecycle management
- **MarmotGroup:** Group operations (messaging, proposals, commits)
- **GroupsManager:** Group creation, loading, watching, leaving, and destruction via `client.groups`
- **KeyPackageManager:** Key package creation, publishing, watching, and rotation via `client.keyPackages`
- **History Management:** Optional message storage with querying and pagination
- **Proposal System:** Type-safe builders for group operations
- **Network Abstraction:** Pluggable Nostr client integration
- **Storage Abstraction:** Pluggable persistence backends

## Architecture

```
MarmotClient (Orchestration Layer)
    ↓
MarmotGroup (Group Operations Layer)
    ↓
Core Module (Protocol Layer)
    ↓
MLS (ts-mls) + Nostr
```

## Installation

```typescript
import {
  MarmotClient,
  MarmotGroup,
  Proposals,
} from "@internet-privacy/marmot-ts";
```

## Topics

### [MarmotClient](./marmot-client)

Multi-group management, creating/joining/loading groups, lifecycle events.

### [MarmotGroup](./marmot-group)

Single group operations, sending messages, processing events, proposals and commits.

### [Proposals](./proposals)

Type-safe proposal builders for inviting users, removing users, and updating metadata.

### [History](./history)

Message storage, querying, and pagination with GroupRumorHistory.

### [Network](./network)

NostrNetworkInterface abstraction for integrating with Nostr clients.

### [Storage](./storage)

Key/value stores for persisting serialized group state, key packages, and invites.

### [Best Practices](./best-practices)

Recommended patterns for commits, state persistence, relay selection, and more.

Complete API documentation for all Client module classes and functions.

## When to Use Client

Use the Client module for:

- **Production applications** with full group management
- **Chat applications** needing message history
- **Applications** requiring reactive updates (event-driven)
- **Most use cases** - it's the recommended starting point

For fine-grained control or protocol research, use the [Core module](/core/) directly.

## Quick Example

```typescript
import {
  MarmotClient,
  createApplicationMessageIntent,
  createChatRumor,
  deserializeApplicationData,
} from "@internet-privacy/marmot-ts";

// Create client
const client = new MarmotClient({
  signer,
  network,
  groupStateStore,
  keyPackageStore,
});

// Create group
const group = await client.groups.create("My Group", {
  relays: ["wss://relay.example.com"],
  adminPubkeys: [myPubkey],
});

// Send message
const rumor = createChatRumor({ pubkey: myPubkey, content: "Hello, Marmot!" });
await client.groups.send(group.id, createApplicationMessageIntent(rumor));

// Listen for messages
group.on("applicationMessage", (message) => {
  const rumor = deserializeApplicationData(message);
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});
```

## Key Features

### Event-Driven Architecture

`GroupsManager`, `KeyPackageManager`, `InviteManager`, and `MarmotGroup` emit events for reactive UI updates.

### Type Safety

Generic type system ensures type consistency between client and groups.

### Pluggable Components

- Storage backends (in-memory, IndexedDB, filesystem)
- Network interfaces (nostr-tools, NDK, etc.)
- History implementations (custom storage)
- Crypto providers

### Performance

- Group caching and deduplication
- Lazy loading
- Efficient batch processing
- Non-blocking history operations

### Protocol Compliance

Implements all Marmot Improvement Proposals (MIP-00 through MIP-03).
