---
heroImage: /images/marmot-header.png
heroImageAlt: A pixel-art marmot in a wizard hat pointing a wand at a glowing code editor in an underground burrow
---

# Core Module

The Core module (`marmot-ts/core`) implements the Marmot v2 protocol layer, providing the fundamental building blocks for privacy-preserving group messaging. It bridges MLS (Message Layer Security) cryptographic operations with Nostr's decentralized event distribution, and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation.

## What's in the Core Module

The Core module is responsible for:

- **Protocol Implementation:** MLS group operations following the Marmot v2 specifications (MIP-00 through MIP-03)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials, including the `marmot.account-identity-proof.v1` LeafNode extension
- **Message Encryption:** Group events (kind 445) encrypted with a per-epoch MIP-03 key; Welcome messages gift-wrapped via NIP-59
- **Key Package Management:** Creating and handling cryptographic material for member addition
- **State Serialization:** Encoding/decoding group state for persistence

## Key Dependencies

- **ts-mls** - RFC 9420 compliant MLS implementation
- **applesauce-core / applesauce-common** - Nostr event handling, NIP-44, and gift-wrap helpers
- **@noble/hashes, @noble/curves, @noble/ciphers** - Cryptographic primitives
- **@hpke/core** - HPKE for MLS key encapsulation

## Installation

```typescript
import {
  createCredential,
  generateKeyPackage,
  createGroup,
  // ... other exports
} from "@internet-privacy/marmot-ts";
```

## Topics

### [Protocol Constants & Concepts](./protocol)

Learn about Nostr event kinds, extension types, and core protocol concepts like app components.

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

- **[MIP-00](https://github.com/marmot-protocol/mips/blob/main/mips/mip-00.md):** Introduction and Basic Operations
- **[MIP-01](https://github.com/marmot-protocol/mips/blob/main/mips/mip-01.md):** Network Transport & Relay Communication
- **[MIP-02](https://github.com/marmot-protocol/mips/blob/main/mips/mip-02.md):** Identities and Keys
- **[MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md):** Group State & Memberships
- **[MIP-04](https://github.com/marmot-protocol/mips/blob/main/mips/mip-04.md):** Encrypted Media _(in progress)_
