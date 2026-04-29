# marmot-ts

TypeScript implementation of the [Marmot protocol](https://github.com/marmot-protocol/marmot) - bringing end-to-end encrypted group messaging to Nostr using [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/).

> [!WARNING]
> This library is currently in **Alpha** and under heavy development. The API is subject to breaking changes without notice. It relies heavily on [ts-mls](https://github.com/LukaJCB/ts-mls) for MLS cryptographic guarantees. Do not use in production yet.

This library provides the building blocks for creating secure, decentralized group chat applications on Nostr. It wraps `ts-mls` with Nostr-specific functionality, similar to how [MDK](https://github.com/marmot-protocol/mdk) wraps [OpenMLS](https://github.com/openmls/openmls).

## Features

- 🔐 **End-to-end encrypted group messaging** using MLS protocol
- 🌐 **Decentralized** - groups operate across Nostr relays
- 🔑 **Key package management** - handle identity, publishing, rotation, and invitations
- 📦 **Storage-agnostic** - bring your own `GenericKeyValueStore` backend (LocalForage, IndexedDB, SQLite, in-memory, etc.)
- 🔌 **Network-agnostic** - works with any Nostr client library
- 📱 **Cross-platform** - works in browsers and Node.js (v20+)

## Installation

```bash
npm install @internet-privacy/marmot-ts
# or
pnpm add @internet-privacy/marmot-ts
```

## Marmot Protocol Compliance

Currently, `marmot-ts` supports the following [Marmot Improvement Proposals (MIPs)](https://github.com/marmot-protocol/mips):

| MIP                                                                        | Description                             | Status       |
| -------------------------------------------------------------------------- | --------------------------------------- | ------------ |
| [MIP-00](https://github.com/marmot-protocol/mips/blob/main/mips/mip-00.md) | Introduction and Basic Operations       | ✅ Supported |
| [MIP-01](https://github.com/marmot-protocol/mips/blob/main/mips/mip-01.md) | Network Transport & Relay Communication | ✅ Supported |
| [MIP-02](https://github.com/marmot-protocol/mips/blob/main/mips/mip-02.md) | Identities and Keys                     | ✅ Supported |
| [MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md) | Group State & Memberships               | ✅ Supported |

## Documentation

Comprehensive documentation is available in the `documentation/` directory:

- [Getting Started](documentation/getting-started.md) - A fast track to initializing the library.
- [Architecture](documentation/architecture.md) - High-level component overview and Nostr/MLS integration mapping.
- [MarmotClient](documentation/marmot-client.md) - Deep dive into the main entry point class, its sub-managers, and identity management.
- [Bytes-First Storage](documentation/bytes-first-storage.md) - Explaining the storage-agnostic philosophy and group state hydration.
- [Ingest Methods](documentation/ingest-methods.md) - Handling incoming messages and network input robustly.
- [Examples](documentation/examples.md) - Concise snippets for group creation, invitations, sending messages, and more.

## Quick Start Overview

To begin using the client, you need an `EventSigner` (e.g. from `applesauce-core`), a `NostrNetworkInterface` implementation, and two `GenericKeyValueStore` backends — one for serialized group state bytes and one for key package metadata.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";
import localforage from "localforage";

const client = new MarmotClient({
  signer: yourNostrSigner,
  // Any GenericKeyValueStore<SerializedClientState>. A LocalForage instance
  // works directly because it already implements the getItem/setItem/keys API.
  groupStateStore: localforage.createInstance({ name: "marmot-groups" }),
  // Any GenericKeyValueStore<StoredKeyPackage> for key package metadata.
  keyPackageStore: localforage.createInstance({ name: "marmot-keypackages" }),
  // Your NostrNetworkInterface implementation (publish, request, subscription, getUserInboxRelays).
  network: yourNetworkInterface,
  // Optional: stable slot identifier for addressable (kind 30443) key packages.
  clientId: "my-app-desktop",
});

const group = await client.groups.create("My Secret Group", {
  description: "A private discussion",
  relays: ["wss://relay.example.com"],
  // Optional: add additional admins (the creator is always included automatically)
  adminPubkeys: ["<other-admin-pubkey-hex>"],
  // Optional: override MLS ciphersuite
  ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
});
```

See [Getting Started](documentation/getting-started.md) and [Examples](documentation/examples.md) for full usage instructions.

## Development

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests (watch mode)
pnpm format    # Format code with Prettier
```
