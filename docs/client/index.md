# Client Module

The Client module (`marmot-ts/client`) provides a high-level, production-ready implementation for building Marmot applications.

## What's in the Client Module

- **MarmotClient:** Multi-group orchestration with lifecycle management
- **MarmotGroup:** Group operations (messaging, proposals, commits)
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
} from "@internet-privacy/marmots/client";
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

GroupStateStore and KeyPackageStore for persisting group state and key packages.

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
import { MarmotClient } from "@internet-privacy/marmots/client";

// Create client
const client = new MarmotClient({
  signer,
  network,
  groupStateStore,
  keyPackageStore,
});

// Create group
const group = await client.createGroup("My Group", {
  relays: ["wss://relay.example.com"],
  adminPubkeys: [myPubkey],
});

// Send message
await group.sendApplicationRumor({
  kind: 1,
  content: "Hello, Marmot!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: myPubkey,
});

// Listen for messages
group.on("applicationMessage", ({ rumor }) => {
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});
```

## Key Features

### Event-Driven Architecture

Both MarmotClient and MarmotGroup emit events for reactive UI updates.

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
