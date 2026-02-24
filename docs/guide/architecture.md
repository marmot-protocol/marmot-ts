# Architecture

## Overview

Marmot-TS is organized into two main modules that work together to provide privacy-preserving group messaging:

```
┌─────────────────────────────────────┐
│      Your Application               │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      Client Module                  │
│  (MarmotClient, MarmotGroup)        │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      Core Module                    │
│  (Protocol, Crypto, Messages)       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      MLS (ts-mls) + Nostr           │
└─────────────────────────────────────┘
```

## Modules

### Core Module

The [Core module](/core/) implements the Marmot protocol layer and provides fundamental building blocks:

- **Protocol Implementation:** MLS group operations following Marmot specifications (MIP-00 through MIP-03)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials
- **Message Encryption:** NIP-44 encryption layered over MLS for group messages
- **Key Package Management:** Creating and handling cryptographic material for member addition
- **State Serialization:** Encoding/decoding group state for persistence

**When to use Core directly:**

- Building custom clients with specific requirements
- Implementing protocol extensions or MIPs
- Research and experimentation
- Fine-grained control over MLS operations

### Client Module

The [Client module](/client/) provides a high-level, production-ready implementation:

- **MarmotClient:** Multi-group orchestration with lifecycle management
- **MarmotGroup:** Group operations (messaging, proposals, commits)
- **History Management:** Optional message storage with querying and pagination
- **Proposal System:** Type-safe builders for group operations
- **Network Abstraction:** Pluggable Nostr client integration
- **Storage Abstraction:** Pluggable persistence backends

**When to use Client:**

- Building production applications
- Need for group lifecycle management
- Want history and message storage
- Prefer high-level, opinionated APIs

## Layered Architecture

### Application Layer

Your chat UI, commands, and business logic.

### Client Layer (Orchestration)

- **MarmotClient** manages multiple groups
- Group lifecycle: create, join, load, destroy
- State persistence and caching
- Event emission for reactive UIs

### Client Layer (Group Operations)

- **MarmotGroup** handles single group operations
- Message sending and receiving
- Proposal and commit creation
- Event ingestion and processing
- Admin policy enforcement

### Core Layer (Protocol)

- Protocol constants and types
- Credentials and key packages
- Group creation and initialization
- Message encryption/decryption
- Member management
- Welcome message handling
- State serialization

### Foundation Layer

- **ts-mls:** RFC 9420 compliant MLS implementation
- **Nostr:** Decentralized event distribution
- **Cryptography:** Noble libraries for hashing and encryption

## Data Flow

### Creating a Group

```
1. generateKeyPackage() → CompleteKeyPackage
2. createGroup() → ClientState with MarmotGroupData
3. createGroupEvent() → Encrypted kind 445 event
4. Publish to Nostr relays
```

### Adding Members

```
1. Fetch recipient's key package (kind 443 from relays)
2. MLS add proposal + commit → Welcome + MLSMessage
3. createWelcomeRumor() → kind 444 rumor
4. createGiftWrap() → kind 1059 encrypted gift wrap
5. createGroupEvent() → kind 445 commit event
6. Publish both events to relays
```

### Sending Messages

```
1. Create rumor (unsigned event)
2. serializeApplicationRumor() → Uint8Array
3. MLS encrypt application data → MLSMessage
4. createGroupEvent() → kind 445 encrypted event
5. Publish to group relays
```

### Receiving Messages

```
1. Fetch kind 445 events from relays
2. decryptGroupMessageEvent() → MLSMessage
3. Process commits/proposals → Update ClientState
4. Extract application data → deserializeApplicationRumor()
5. Display message in UI
```

## Design Principles

### Separation of Concerns

- **Core:** Protocol implementation, no I/O or storage
- **Client:** I/O, storage, lifecycle management, high-level APIs
- **Application:** UI, user interactions, business logic

### Composability

- Small, focused functions with clear contracts
- Minimal side effects
- Easy to test and reason about

### Privacy by Default

- Ephemeral keys for signing group events
- Gift wraps for sensitive messages (Welcome)
- Rumors prevent leak exploitation
- Unlinkable events

### Type Safety

- Strong TypeScript typing throughout
- Generic types for flexibility (history, storage)
- Branded types for domain concepts
- Exhaustive pattern matching

### Extensibility

- Pluggable storage backends
- Pluggable network interfaces
- Pluggable crypto providers
- Pluggable history implementations
- MLS extension system

### Nostr Integration

- Event-based distribution (no central server)
- Relay-based discovery (decentralized)
- Compatible with existing Nostr infrastructure
- Uses standard NIPs (NIP-44, NIP-59, etc.)

### MLS Compliance

- RFC 9420 conformance via ts-mls
- Proper extension handling
- Credential validation hooks
- Forward secrecy and post-compromise security

## Protocol Compliance

Marmot-TS implements the following Marmot Improvement Proposals:

- **[MIP-00](https://github.com/parres-hq/marmot/blob/main/00.md):** Gift Wrap for Welcome Messages (NIP-59)
- **[MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md):** Marmot Group Data Extension (0xf2ee)
- **[MIP-02](https://github.com/parres-hq/marmot/blob/main/02.md):** Welcome Message Ordering (commit before welcome)
- **[MIP-03](https://github.com/parres-hq/marmot/blob/main/03.md):** Admin Policy & Commit Ordering

## Security Properties

### MLS Properties

- **Forward Secrecy:** Past messages remain secure even if current keys are compromised
- **Post-Compromise Security:** Security is restored after a compromise through key rotation (commits)
- **Authenticated Encryption:** All messages are authenticated and encrypted
- **Group Key Agreement:** Efficient key agreement for large groups

### Marmot Additions

- **Ephemeral Signing:** Group events signed with ephemeral keys, not user identity keys
- **Unlinkability:** Events cannot be linked to specific users by observers
- **Gift-Wrapped Welcome:** Welcome messages wrapped in NIP-59 gift wraps for privacy
- **Admin Policy:** Only designated admins can send commits (configurable)
- **Deterministic Ordering:** Commit conflicts resolved deterministically

### Nostr Properties

- **Censorship Resistance:** Multiple relays, no single point of control
- **Relay Independence:** Choose your own relays
- **Event Authenticity:** All events are cryptographically signed
- **Permissionless:** No registration or approval required
