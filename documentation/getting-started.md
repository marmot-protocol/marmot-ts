# Getting Started with marmot-ts

Welcome to the `marmot-ts` documentation! This library provides the building blocks for creating secure, decentralized group chat applications on Nostr using [Marmot Protocol](https://github.com/marmot-protocol/marmot).

## Navigating the Documentation

Depending on what you're looking to build or understand, we recommend the following learning path:

1. **[Architecture](architecture.md):** High-level component overview mapping Nostr/MLS integration.
2. **[MarmotClient](marmot-client.md):** Deep dive into initialization and identity management.
3. **[Bytes-First Storage](bytes-first-storage.md):** Explaining the storage-agnostic philosophy.
4. **[Ingest Methods](ingest-methods.md):** Processing incoming messages and network state reliably.
5. **[Examples](examples.md):** Common snippets for quick integration.

## Installation

```bash
npm install @internet-privacy/marmots applesauce-core
# or
pnpm add @internet-privacy/marmots applesauce-core
```

_Note: `marmot-ts` relies heavily on [ts-mls](https://github.com/LukaJCB/ts-mls) under the hood. You do not need to install it separately, but you will often see types propagated from it._

## 1. Setup Storage Backends

Marmot groups and key packages represent complex cryptographic state that must be saved locally to persist across sessions. Because environments (Browser, Node, React Native) handle storage differently, you must provide your own database connection through the `KeyValueGroupStateBackend` adapter.

Example using `localforage` for the browser:

```bash
npm install localforage
```

```typescript
import localforage from "localforage";
import {
  KeyValueGroupStateBackend,
  KeyPackageStore,
} from "@internet-privacy/marmots";

// Store encrypted group bytes
const groupStateBackend = new KeyValueGroupStateBackend(
  localforage.createInstance({ name: "marmot-groups" }),
);

// Store your user identity materials
const keyPackageStore = new KeyPackageStore(
  localforage.createInstance({ name: "marmot-keypackages" }),
);
```

## 2. Define Network Interface

The client needs a way to fetch and broadcast standard Nostr events. You must implement the `NostrNetworkInterface`. Here is a minimal structure wrapping standard logic:

```typescript
import type { NostrNetworkInterface } from "@internet-privacy/marmots";

const network: NostrNetworkInterface = {
  request: async (relays, filters) => {
    // Implement standard multi-relay subscription fetching
    return [];
  },
  subscription: (relays, filters) => {
    // Returns a Subscribable<NostrEvent> that emits events matching the filters
    // Implementers should return an object with a subscribe method that
    // yields NostrEvent objects to the observer
    return {
      subscribe: (observer) => {
        // Implement real-time subscription logic here
        // Call observer.next(event) when events are received
        // Call observer.error(err) on errors
        // Call observer.complete() when subscription ends
        return {
          unsubscribe: () => {
            // Implement cleanup logic here
          },
        };
      },
    };
  },
  publish: async (relays, event) => {
    // Implement event publishing logic
    return {
      /* ... */
    };
  },
  getUserInboxRelays: async (pubkey) => {
    // Implement NIP-65 routing map lookups
    return ["wss://relay.example.com"];
  },
};
```

## 3. Initialize the Client

Finally, bring your dependencies together alongside an `EventSigner` (from `applesauce-core`).

```typescript
import { MarmotClient } from "@internet-privacy/marmots";

const client = new MarmotClient({
  signer: yourApplesauceSigner,
  groupStateBackend,
  keyPackageStore,
  network,
});

// Create your first group!
const group = await client.createGroup("Welcome to Marmot", {
  description: "Secure comms.",
  adminPubkeys: [await yourApplesauceSigner.getPublicKey()],
  relays: ["wss://relay.example.com"],
});
```

To see what you can do next, check out the [Examples](examples.md) page!
