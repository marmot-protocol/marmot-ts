# Core Module

The Core module (`@internet-privacy/marmot-ts/core`) implements the Marmot v2 protocol layer, providing the fundamental building blocks for privacy-preserving group messaging. It bridges MLS (Message Layer Security) cryptographic operations with Nostr's decentralized event distribution, and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation.

## What's in the Core Module

The Core module is responsible for:

- **Protocol Implementation:** MLS group operations following the [Marmot spec](https://github.com/marmot-protocol/marmot) (`foundation/`, `protocol-core/`, `app-components/`, `transports/nostr.md`)
- **Identity Bridging:** Converting Nostr public keys to MLS credentials, including the account identity proof app component (`0x8009`, `marmot.member.account-identity-proof.v2`)
- **Message Encryption:** Group events (kind 445) carry MLS messages under an outer ChaCha20-Poly1305 layer keyed by a per-epoch MLS exporter secret ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)); Welcome messages are gift-wrapped via NIP-59
- **Key Package Management:** Creating and handling cryptographic material for member addition
- **State Serialization:** Encoding/decoding group state for persistence

## Key Dependencies

- **ts-mls** - RFC 9420 compliant MLS implementation; a fork bundled with the package and exposed through `@internet-privacy/marmot-ts/mls`
- **applesauce-core / applesauce-common** - Nostr event handling, NIP-44, and gift-wrap helpers
- **@noble/hashes, @noble/curves, @noble/ciphers** - Cryptographic primitives
- **@hpke/core** - HPKE for MLS key encapsulation

## Installation

```bash
pnpm add @internet-privacy/marmot-ts
```

```typescript
import {
  createCredential,
  generateKeyPackage,
  createGroup,
  // ... other exports
} from "@internet-privacy/marmot-ts/core"; // also re-exported from the package root
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

Query group membership and the leaves (devices) each account has in a group.

### [Welcome Messages](./welcome)

Create and process Welcome messages for new members.

### [Key Package Distribution](./distribution)

Publish and discover key packages using Nostr events.

### [Client State](./state)

Manage and serialize MLS group state for persistence.

### [API Reference](pathname:///reference/index.html)

Complete API documentation for all Core module functions.

## When to Use Core

Use the Core module when you need:

- **Fine-grained control** over MLS operations
- **Custom client implementations** with specific requirements
- **Protocol extensions** or implementing new app components / spec features
- **Research and experimentation** with the protocol
- **Understanding** of the underlying protocol layer

For most applications, use the [Client module](/client/) instead, which provides a higher-level API built on top of Core.

## Protocol Compliance

The Core module implements the topic-based Marmot spec (the old MIP numbering is deprecated; see [`mip-coverage.md`](https://github.com/marmot-protocol/marmot/blob/master/mip-coverage.md) for the mapping):

- **Identity & KeyPackages:** [`foundation/identity.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/identity.md), [`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md), [`app-components/account-identity-proof-v2.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/account-identity-proof-v2.md)
- **Group setup & state:** [`protocol-core/group-setup.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-setup.md), [`protocol-core/group-state.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-state.md), [`app-components/`](https://github.com/marmot-protocol/marmot/blob/master/app-components)
- **Joining (Welcomes):** [`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md)
- **Group messaging & departure:** [`protocol-core/group-messaging.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-messaging.md), [`protocol-core/member-departure.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/member-departure.md), [`foundation/application-messages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/application-messages.md)
- **Nostr transport:** [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)
- **Encrypted media v2:** [API and migration guide](./media.md); current policy component `0x800b`, with explicit frozen v1 history helpers.
