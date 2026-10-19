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

- **Protocol Implementation:** MLS group operations following the Marmot v2 spec (`foundation/`, `protocol-core/`)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials (incl. the account identity proof app component, `0x8009`)
- **Message Encryption:** kind 445 outer ChaCha20-Poly1305 layer keyed from the MLS exporter (`transports/nostr.md`); NIP-59 gift wraps for Welcomes
- **Key Package Management:** Creating and handling cryptographic material for member addition
- **State Serialization:** Encoding/decoding group state for persistence

**When to use Core directly:**

- Building custom clients with specific requirements
- Implementing protocol extensions or app components
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

The [Engine module](https://github.com/marmot-protocol/marmot-ts/tree/master/src/engine) (`@internet-privacy/marmot-ts/engine`) is the protocol state machine that sits between the client and core layers. It is transport-agnostic (generic over an envelope type via an injected `GroupPeeler`; only audit metadata assumes Nostr-shaped envelopes) and is responsible for:

- **`MarmotGroupEngine`:** owns the MLS `ClientState` and drives inbound/outbound processing
- **Convergence:** deterministic resolution of concurrent commits (`convergenceStatus`: `Syncing` → `Resolving` → `Settled`/`Blocked`)
- **Lifecycle:** the publish-before-apply commit lifecycle (`Stable` → `PendingPublish` → `Merging` → `Stable`, plus `Recovering`, `Disbanded`, `Unrecoverable`)
- **Ingest classification:** every inbound envelope yields a result (`processed`, `deferred`, `unreadable`, `autoCommit`, `removed`, …) tagged with a `Disposition` (`accepted`, `stale`, `deferred`, `invalidated`)
- **Retained history & fork recovery:** bounded rewind so late or reordered events can still be processed

Outbound sends are **convergence-gated**, but the engine itself holds no outbound queue: it reports convergence status and arms a settle-window callback. `MarmotGroup.submitIntent()` (and `client.groups.send()`) queue intents while the group is not `Settled` and release them when convergence settles; `leave()` and the self_remove auto-commit bypass the gate. The client layer adds the Nostr transport (`GroupRuntime`) and persistence (`GroupSession`) around this engine.

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
1. generateKeyPackage() → creator's CompleteKeyPackage (with 0x8009 identity proof)
2. createSimpleGroup() → ClientState with profile, admin-policy and nostr-routing components
3. Persist state locally — nothing is published for a solo create
4. (Founding create with invitees) merge one Add commit to epoch 1 locally,
   then gift-wrap Welcomes; no kind 445 is published
```

### Adding Members

```
1. Fetch recipient's key package (kind 30443 from their kind 10002 write relays)
2. MLS add proposal + commit → Welcome + MLSMessage
3. createGroupEvent() → kind 445 commit event (MLS PublicMessage, ephemeral signer)
4. Publish the commit and wait for relay acks
5. Only after the commit is acked: createWelcomeRumor() → kind 444 rumor
6. createGiftWrap() → kind 1059, published to the invitee's kind 10050 inbox relays
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
1. client.groups.connect()/connectAll() fetches + subscribes to kind 445 events
   and verifies each event's signature and `h` tag
2. group.ingest(events) → engine peels each into an MLSMessage
3. Engine processes commits/proposals → updates ClientState (convergence-aware)
4. Each envelope yields a result (processed, deferred, unreadable, …) carrying a disposition (accepted, stale, deferred, invalidated)
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

Marmot-TS implements the **Marmot v2** specification ([marmot-protocol/marmot](https://github.com/marmot-protocol/marmot)) and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation:

- **Identity & key packages:** [`foundation/identity.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/identity.md), [`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md), [`app-components/account-identity-proof-v2.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/account-identity-proof-v2.md)
- **Group setup & app components:** [`protocol-core/group-setup.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-setup.md), [`app-components/`](https://github.com/marmot-protocol/marmot/tree/master/app-components)
- **Joining (Welcomes):** [`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md)
- **Group messaging, convergence & departure:** [`protocol-core/group-messaging.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-messaging.md), [`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md), [`protocol-core/member-departure.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/member-departure.md)
- **Nostr transport binding:** [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)
- **Encrypted media:** [`features/encrypted-media.md`](https://github.com/marmot-protocol/marmot/blob/master/features/encrypted-media.md) and [`app-components/group-encrypted-media-v2.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/group-encrypted-media-v2.md) (v2; frozen v1 references still decode)

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
- **Admin Policy:** group-changing commits (add/remove/metadata) require an admin listed in `marmot.group.admin-policy.v1`; any member may commit its own self-update or a self_remove departure
- **Deterministic Ordering:** Commit conflicts resolved deterministically

### Nostr Properties

- **Censorship Resistance:** Multiple relays, no single point of control
- **Relay Independence:** Choose your own relays
- **Event Authenticity:** All events are cryptographically signed
- **Permissionless:** No registration or approval required
