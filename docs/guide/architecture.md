---
heroImage: /images/marmot-development.png
heroImageAlt: A pixel-art marmot engineer with a wrench standing before glowing gears and pipes in a burrow
---

# Architecture

## Overview

Marmot-TS is organized into layered modules that work together to provide privacy-preserving group messaging:

```
┌─────────────────────────────────────┐
│      Your Application               │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      Client Module                  │
│  (MarmotClient, MarmotGroup,        │
│   managers, storage, network)       │
└─────────────────────────────────────┘
                 ↓
┌─────────────────────────────────────┐
│      Engine Module                  │
│  (MarmotGroupEngine, convergence    │
│   & ingest state machine)           │
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

`MarmotGroup` is a thin facade: it owns a `GroupSession` (which wraps the
`MarmotGroupEngine` protocol state machine) and a `GroupRuntime` (which publishes
the engine's outbound effects to relays).

## Modules

### Core Module

The [Core module](/core/) implements the Marmot v2 protocol layer and provides fundamental building blocks:

- **Protocol Implementation:** MLS group operations following the Marmot v2 specifications (MIP-00 through MIP-03)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials (incl. the account-identity-proof LeafNode extension)
- **Message Encryption:** Per-epoch MIP-03 encryption for group events; NIP-59 gift wraps for Welcomes
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

### Engine Module

The [Engine module](https://github.com/marmot-protocol/marmot-ts/tree/master/src/engine) (`marmot-ts/engine`) is the protocol state machine that sits between the client and core layers. It is transport-agnostic — it knows nothing about Nostr — and is responsible for:

- **`MarmotGroupEngine`:** owns the MLS `ClientState` and drives inbound/outbound processing
- **Convergence:** deterministic resolution of concurrent commits (`convergenceStatus`: `Syncing` → `Resolving` → `Settled`/`Blocked`)
- **Lifecycle:** the publish-before-apply commit lifecycle (`Stable`, `PendingPublish`, `Merging`)
- **Ingest dispositions:** classifying every inbound envelope (`processed`, `deferred`, `unreadable`, `autoCommit`, `removed`, …)
- **Retained history & fork recovery:** bounded rewind so late or reordered events can still be processed

Outbound sends are **convergence-gated**: a `SendIntent` submitted while the group is not `Settled` is queued until convergence resolves. The client layer adds the Nostr transport (`GroupRuntime`) and persistence (`GroupSession`) around this engine.

**When to use Engine:**

- Embedding Marmot over a non-Nostr transport
- Building a custom client with bespoke persistence or scheduling
- Reasoning about convergence and commit ordering directly

## Layered Architecture

### Application Layer

Your chat UI, commands, and business logic.

### Client Layer (Orchestration)

- **MarmotClient** manages multiple groups
- Group lifecycle: create, join, load, destroy
- State persistence and caching
- Event emission for reactive UIs

### Client Layer (Group Operations)

- **MarmotGroup** facade over a `GroupSession` + `GroupRuntime`
- Message sending and receiving (Nostr kind 445 transport)
- Proposal and commit creation
- Event ingestion and processing
- History and media services

### Engine Layer (Protocol State Machine)

- **MarmotGroupEngine** owns the MLS `ClientState`
- Convergence resolution and commit lifecycle
- Ingest disposition classification
- Retained-history rewind and fork recovery
- Admin commit-policy enforcement

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
2. createGroup() → ClientState with the app-component dictionary
3. createGroupEvent() → Encrypted kind 445 event
4. Publish to Nostr relays
```

### Adding Members

```
1. Fetch recipient's key package (kind 30443 from relays)
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
2. group.ingest(events) → engine peels each into an MLSMessage
3. Engine processes commits/proposals → updates ClientState (convergence-aware)
4. Each envelope yields a disposition (processed, deferred, unreadable, …)
5. Decrypted application messages emit the `applicationMessage` event
6. deserializeApplicationData() → rumor → display in UI
```

## Design Principles

### Separation of Concerns

- **Core:** Protocol/crypto primitives, no I/O, storage, or transport
- **Engine:** Protocol state machine — convergence, lifecycle, ingest — transport-agnostic
- **Client:** I/O, storage, Nostr transport, lifecycle management, high-level APIs
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

Marmot-TS implements **Marmot v2** and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation:

- **[MIP-00](https://github.com/marmot-protocol/mips/blob/main/mips/mip-00.md):** Introduction and Basic Operations
- **[MIP-01](https://github.com/marmot-protocol/mips/blob/main/mips/mip-01.md):** Network Transport & Relay Communication
- **[MIP-02](https://github.com/marmot-protocol/mips/blob/main/mips/mip-02.md):** Identities and Keys
- **[MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md):** Group State & Memberships
- **[MIP-04](https://github.com/marmot-protocol/mips/blob/main/mips/mip-04.md):** Encrypted Media _(in progress)_

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
