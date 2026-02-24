# Core Module

The Core module (`marmot-ts/core`) implements the Marmot protocol layer, providing the fundamental building blocks for privacy-preserving group messaging. It bridges MLS (Message Layer Security) cryptographic operations with Nostr's decentralized event distribution.

## What's in the Core Module

The Core module is responsible for:

- **Protocol Implementation:** MLS group operations following Marmot specifications (MIP-00 through MIP-03)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials
- **Message Encryption:** NIP-44 encryption layered over MLS for group messages
- **Key Package Management:** Creating and handling cryptographic material for member addition
- **State Serialization:** Encoding/decoding group state for persistence

## Key Dependencies

- **ts-mls** - RFC 9420 compliant MLS implementation
- **nostr-tools** - Nostr event handling and NIP-44 encryption
- **@noble/hashes** - Cryptographic hashing

## Installation

```typescript
import {
  createCredential,
  generateKeyPackage,
  createGroup,
  // ... other exports
} from "@internet-privacy/marmots/core";
```

## Topics

### [Protocol Constants & Concepts](./protocol)

Learn about Nostr event kinds, extension types, and core protocol concepts like MarmotGroupData.

### [Credentials](./credentials)

Understand how Nostr identities are converted to MLS credentials.

### [Key Packages](./key-packages)

Generate and manage key packages for adding members to groups.

### [Groups](./groups)

Create and initialize MLS groups with Marmot metadata.

### [Messages](./messages)

Handle message encryption, decryption, commit ordering, and application messages.

### [Members](./members)

Query and manage group membership, including multi-device support.

### [Welcome Messages](./welcome)

Create and process Welcome messages for new members.

### [Key Package Distribution](./distribution)

Publish and discover key packages using Nostr events.

### [Client State](./state)

Manage and serialize MLS group state for persistence.

Complete API documentation for all Core module functions.

## When to Use Core

Use the Core module when you need:

- **Fine-grained control** over MLS operations
- **Custom client implementations** with specific requirements
- **Protocol extensions** or implementing new MIPs
- **Research and experimentation** with the protocol
- **Understanding** of the underlying protocol layer

For most applications, use the [Client module](/client/) instead, which provides a higher-level API built on top of Core.

## Protocol Compliance

The Core module implements the following Marmot Improvement Proposals:

- **[MIP-00](https://github.com/parres-hq/marmot/blob/main/00.md):** Gift Wrap for Welcome Messages (NIP-59)
- **[MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md):** Marmot Group Data Extension (0xf2ee)
- **[MIP-02](https://github.com/parres-hq/marmot/blob/main/02.md):** Welcome Message Ordering (commit before welcome)
- **[MIP-03](https://github.com/parres-hq/marmot/blob/main/03.md):** Admin Policy & Commit Ordering
