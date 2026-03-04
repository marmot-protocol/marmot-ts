# marmot-ts

![marmot-ts header](https://blossom.primal.net/1d960c24e36f4ba0e13b3aa0a19c72bcf2d00c79a584debbf47e328c7ca4b8ca.png)

TypeScript implementation of the [Marmot protocol](https://github.com/marmot-protocol/marmot) - bringing end-to-end encrypted group messaging to Nostr using [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/).

> [!WARNING]
> This library is currently in **Alpha** and under heavy development. The API is subject to breaking changes without notice. It relies heavily on [ts-mls](https://github.com/LukaJCB/ts-mls) for MLS cryptographic guarantees. Do not use in production yet.

This library provides the building blocks for creating secure, decentralized group chat applications on Nostr. It wraps `ts-mls` with Nostr-specific functionality, similar to how [MDK](https://github.com/marmot-protocol/mdk) wraps [OpenMLS](https://github.com/openmls/openmls).

## Features

![Features](https://blossom.primal.net/574075bf6c694523e1ee8fb49a166a20e70250bfa0508f9b74d1874701a3b66a.png)

- 🔐 **End-to-end encrypted group messaging** using MLS protocol
- 🌐 **Decentralized** - groups operate across Nostr relays
- 🔑 **Key package management** - handle identity and invitations
- 📦 **Storage-agnostic** - bring your own storage backend (LocalForage, IndexedDB, etc.)
- 🔌 **Network-agnostic** - works with any Nostr client library
- 📱 **Cross-platform** - works in browsers and Node.js (v20+)

## Installation

![Installation](https://blossom.primal.net/ec3f74a4846f186dea74460216ed6cd166533af46fb2fa18b8ae82ab7b4307a0.png)

```bash
npm install @internet-privacy/marmots
# or
pnpm add @internet-privacy/marmots
```

## Marmot Protocol Compliance

![Protocol Compliance](https://blossom.primal.net/67d3d24ffd7e55ff8cf64370333305accefdac91dd36d7353d41ecf754e3b184.png)

Currently, `marmot-ts` supports the following [Marmot Improvement Proposals (MIPs)](https://github.com/marmot-protocol/mips):

| MIP                                                                        | Description                             | Status       |
| -------------------------------------------------------------------------- | --------------------------------------- | ------------ |
| [MIP-00](https://github.com/marmot-protocol/mips/blob/main/mips/mip-00.md) | Introduction and Basic Operations       | ✅ Supported |
| [MIP-01](https://github.com/marmot-protocol/mips/blob/main/mips/mip-01.md) | Network Transport & Relay Communication | ✅ Supported |
| [MIP-02](https://github.com/marmot-protocol/mips/blob/main/mips/mip-02.md) | Identities and Keys                     | ✅ Supported |
| [MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md) | Group State & Memberships               | ✅ Supported |

## Documentation

![Documentation](https://blossom.primal.net/7afdf9b3b5a5ec1011c976653ee0c661b3364c5300b85d9684d9b75c63e6ee37.png)

Comprehensive documentation is available in the `documentation/` directory:

- [Getting Started](documentation/getting-started.md) - A fast track to initializing the library.
- [Architecture](documentation/architecture.md) - High-level component overview and Nostr/MLS integration mapping.
- [MarmotClient](documentation/marmot-client.md) - Deep dive into the main entry point class, initialization, and identity management.
- [Bytes-First Storage](documentation/bytes-first-storage.md) - Explaining the storage-agnostic philosophy and group state hydration.
- [Ingest Methods](documentation/ingest-methods.md) - Handling incoming messages and network input robustly.
- [Examples](documentation/examples.md) - Concise snippets for group creation, invitations, sending messages, and more.

## Quick Start Overview

![Quick Start](https://blossom.primal.net/e31edb9865f78ee77dfb5b0c80d0dba301e4e0d238b2755ddb337a672ce10d05.png)

To begin using the client, you need an established `EventSigner` interface and proper storage backends:

```typescript
import { MarmotClient, KeyValueGroupStateBackend, KeyPackageStore } from "@internet-privacy/marmots";

// Setup backends via your choice of db (e.g. LocalForage)
const groupStateBackend = new KeyValueGroupStateBackend(/* ... */);
const keyPackageStore = new KeyPackageStore(/* ... */);

  const client = new MarmotClient({
    signer: yourNostrSigner,
    groupStateBackend,
    keyPackageStore,
    network: /* NostrNetworkInterface */,
  });

  const group = await client.createGroup("My Secret Group", {
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

![Development](https://blossom.primal.net/8f60812a956160b0fe37ce5f1ffa22ff0646e89e88ec62f984ba7f164c2c773f.png)

```bash
pnpm install   # Install dependencies
pnpm build     # Compile TypeScript
pnpm test      # Run tests (watch mode)
pnpm format    # Format code with Prettier
```
