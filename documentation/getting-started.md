# Getting Started with marmot-ts

Welcome to the `marmot-ts` documentation! This library provides the building blocks for creating secure, decentralized group chat applications on Nostr using [Marmot Protocol](https://github.com/marmot-protocol/marmot).

## Navigating the Documentation

Depending on what you're looking to build or understand, we recommend the following learning path:

1. **[Architecture](architecture.md):** High-level component overview mapping Nostr/MLS integration.
2. **[MarmotClient](marmot-client.md):** Deep dive into the client, its sub-managers, and identity management.
3. **[Bytes-First Storage](bytes-first-storage.md):** Explaining the storage-agnostic philosophy.
4. **[Ingest Methods](ingest-methods.md):** Processing incoming messages and network state reliably.
5. **[Examples](examples.md):** Common snippets for quick integration.

## Installation

```bash
npm install @internet-privacy/marmot-ts
# or
pnpm add @internet-privacy/marmot-ts
```

You will also want a Nostr signer implementation. The example below uses
[`applesauce-core`](https://github.com/hzrd149/applesauce) for its `EventSigner`
interface, but any compliant signer will work.

_Note: `marmot-ts` relies heavily on [ts-mls](https://github.com/LukaJCB/ts-mls) under the hood. You do not need to install it separately, but you will often see types propagated from it._

## 1. Setup Storage Backends

Marmot groups and key packages represent complex cryptographic state that must be saved locally to persist across sessions. Because environments (Browser, Node, React Native) handle storage differently, you must provide two objects that implement the `GenericKeyValueStore<T>` interface:

- `groupStateStore`: stores serialized MLS `ClientState` bytes for each group.
- `keyPackageStore`: stores locally-generated key package metadata (including private material) plus publish-tracking for observed relay events.

Any object with `getItem`, `setItem`, `removeItem`, `clear`, and `keys` methods will satisfy `GenericKeyValueStore<T>` — including a plain [`localforage`](https://localforage.github.io/localForage/) instance.

```bash
npm install localforage
```

```typescript
import localforage from "localforage";

// Store encrypted group state bytes
const groupStateStore = localforage.createInstance({ name: "marmot-groups" });

// Store your user identity materials and key-package metadata
const keyPackageStore = localforage.createInstance({
  name: "marmot-keypackages",
});
```

If you don't need persistence, the package ships with `InMemoryKeyValueStore`
(re-exported from the root) which is useful for tests and ephemeral sessions.

## 2. Define Network Interface

The client needs a way to fetch and broadcast standard Nostr events. You must implement the `NostrNetworkInterface`:

```typescript
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts";

const network: NostrNetworkInterface = {
  request: async (relays, filters) => {
    // Implement standard multi-relay REQ fetching. Should resolve with the
    // accumulated events after the relays return EOSE.
    return [];
  },
  subscription: (relays, filters) => {
    // Return a Subscribable<NostrEvent> that emits events one at a time as
    // they arrive. Implementers should return an object with a
    // subscribe(observer) method.
    return {
      subscribe: (observer) => {
        // Call observer.next?.(event) when events are received.
        // Call observer.error?.(err) on errors.
        // Call observer.complete?.() when subscription ends.
        return {
          unsubscribe: () => {
            // Cleanup logic
          },
        };
      },
    };
  },
  publish: async (relays, event) => {
    // Implement event publishing logic. Should resolve with a map of
    // Record<string, PublishResponse> keyed by relay URL.
    return {};
  },
  getUserInboxRelays: async (pubkey) => {
    // Implement NIP-65 inbox relay lookup (kind 10050 / 10002) so the client
    // can deliver gift-wrapped welcome messages to invited users.
    return ["wss://relay.example.com"];
  },
};
```

## 3. Initialize the Client

Finally, bring your dependencies together alongside an `EventSigner`.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const client = new MarmotClient({
  signer: yourApplesauceSigner,
  groupStateStore,
  keyPackageStore,
  network,
  // Optional: a stable per-device slot identifier (`d` tag) used for
  // addressable (kind 30443) key package events. Lets you rotate your own
  // key packages in-place on relays.
  clientId: "my-app-desktop",
});

// Create your first group!
const group = await client.groups.create("Welcome to Marmot", {
  description: "Secure comms.",
  relays: ["wss://relay.example.com"],
});
```

`MarmotClient` exposes three sub-managers you will use for most day-to-day
operations:

- `client.groups` — lifecycle of {@link MarmotGroup} instances (create, load,
  import, leave, destroy, watch).
- `client.keyPackages` — create / rotate / purge local key packages and track
  ones observed on relays.
- `client.invites` — ingest incoming gift wraps (kind 1059) and unwrap them
  into kind 444 welcome rumors ready for `client.joinGroupFromWelcome`.

To see what you can do next, check out the [Examples](examples.md) page!
