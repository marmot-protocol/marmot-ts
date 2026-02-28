# Getting Started

## What is Marmot?

Marmot is a privacy-preserving group messaging protocol that combines **MLS (Message Layer Security)** for end-to-end encryption with **Nostr** for decentralized message distribution.

**Key Features:**

- **End-to-End Encrypted:** Messages are encrypted using MLS, providing forward secrecy and post-compromise security
- **Decentralized:** Built on Nostr relays, no central server required
- **Privacy-First:** Ephemeral signing keys and gift-wrapped welcome messages protect metadata

## Core Concepts

### MLS (Message Layer Security)

MLS is an IETF standard (RFC 9420) for group messaging security. It provides:

- **Forward Secrecy:** Past messages remain secure even if current keys are compromised
- **Post-Compromise Security:** Security is restored after a compromise through key rotation
- **Efficient Group Operations:** Add/remove members without re-encrypting for everyone

### Nostr

Nostr is a decentralized protocol for distributing signed events over relays. Marmot uses Nostr for:

- **Key Package Distribution:** Publishing cryptographic material for adding members
- **Message Delivery:** Distributing encrypted group messages
- **Welcome Messages:** Onboarding new members to groups

### Key Terms

- **Group:** A collection of members who can exchange encrypted messages
- **Key Package:** Cryptographic material needed to add someone to a group
- **Proposal:** A suggested change to the group (add member, remove member, update metadata)
- **Commit:** A finalized set of proposals that advances the group's encryption state
- **Welcome:** A message sent to new members containing the group state
- **Rumor:** An unsigned Nostr event used as application message content

## Installation

::: code-group

```bash [npm]
npm install @internet-privacy/marmots
```

```bash [pnpm]
pnpm add @internet-privacy/marmots
```

```bash [yarn]
yarn add @internet-privacy/marmots
```

:::

## Setup Storage

Marmot uses a bytes-first storage approach. You'll need to provide storage backends for group state and key packages:

```typescript
import { EventEmitter } from "eventemitter3";

// Minimal in-memory GroupStateStoreBackend for development.
// Notes:
// - IDs are *bytes-first*; the backend receives `Uint8Array`, not hex strings.
// - Implementations are expected to emit "updated" when state changes.
class MemoryGroupStateBackend extends EventEmitter {
  private states = new Map<string, Uint8Array>();

  async get(groupId: Uint8Array): Promise<Uint8Array | null> {
    return this.states.get(bytesToHex(groupId)) ?? null;
  }

  async set(groupId: Uint8Array, state: Uint8Array): Promise<void> {
    this.states.set(bytesToHex(groupId), state);
    this.emit("updated");
  }

  async remove(groupId: Uint8Array): Promise<void> {
    this.states.delete(bytesToHex(groupId));
    this.emit("updated");
  }

  async list(): Promise<Uint8Array[]> {
    return Array.from(this.states.keys()).map((hex) => hexToBytes(hex));
  }
}

const groupStateBackend = new MemoryGroupStateBackend();

// For KeyPackageStore, use the library's store with an app-provided key/value backend.
// See the Storage docs for a complete example.
const keyPackageStore = yourKeyPackageStore;
```

::: tip Production Storage
For production apps, use IndexedDB (browser), file system (Node.js), or SQLite (React Native). See [Storage](/client/storage) for examples.
:::

## Setup Network Interface

Implement the `NostrNetworkInterface` to connect to Nostr relays:

```typescript
import { SimplePool } from "nostr-tools/pool";

const pool = new SimplePool();

const network = {
  async publish(relays: string[], event: NostrEvent) {
    const results = await Promise.allSettled(pool.publish(relays, event));
    return { success: results.some((r) => r.status === "fulfilled") };
  },

  async request(relays: string[], filters: NostrFilter[]) {
    return pool.querySync(relays, filters);
  },

  subscription(relays: string[], filters: NostrFilter[]) {
    // Return observable that emits Nostr events
    // See Network docs for full implementation
  },

  async getUserInboxRelays(pubkey: string) {
    // Fetch NIP-65 relay list for the user
    return ["wss://relay.example.com"];
  },
};
```

## Initialize the Client

```typescript
import { MarmotClient } from "@internet-privacy/marmots";

const client = new MarmotClient({
  signer: yourNostrSigner, // EventSigner from applesauce-core or similar
  network,
  groupStateBackend,
  keyPackageStore,
});
```

::: tip Multi-Account Applications
If your app supports multiple user accounts, each account must have isolated storage to prevent key material from leaking between accounts. See [Multi-Account Support](/client/marmot-client#multi-account-support) for implementation patterns.
:::

## Publish a Key Package

Before others can add you to groups, publish a key package:

```typescript
import {
  createCredential,
  generateKeyPackage,
  createKeyPackageEvent,
} from "@internet-privacy/marmots";
import { defaultCryptoProvider } from "ts-mls";

// Get ciphersuite implementation
const ciphersuiteImpl = await defaultCryptoProvider.getCipherSuiteById(
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
);

// Create credential from your Nostr pubkey
const myPubkey = await client.signer.getPublicKey();
const credential = createCredential(myPubkey);

// Generate key package
const completeKeyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  isLastResort: true, // Reusable
});

// Create and publish event (kind 443)
const unsignedEvent = await createKeyPackageEvent({
  keyPackage: completeKeyPackage.publicPackage,
  relays: ["wss://relay.example.com"],
  client: "my-chat-app",
});

const signedEvent = await client.signer.signEvent(unsignedEvent);
await client.network.publish(["wss://relay.example.com"], signedEvent);

// Save private material locally
await client.keyPackageStore.add(completeKeyPackage);
```

## Create a Group

```typescript
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const group = await client.createGroup("Engineering Team", {
  description: "Secure team communications",
  relays: ["wss://relay.nostr.info"],
  adminPubkeys: [myPubkey],
});

console.log(`Created group (MLS group_id): ${bytesToHex(group.id)}`);
console.log(
  `Routing tag (nostr_group_id): ${bytesToHex(group.groupData.nostrGroupId)}`,
);
```

## Invite a Member

```typescript
// Fetch their key package from relays
const memberPubkey = "abc123...";
const keyPackageEvent = await client.network
  .request(
    ["wss://relay.example.com"],
    [{ kinds: [443], authors: [memberPubkey], limit: 1 }],
  )
  .then((events) => events[0]);

// Invite them (sends encrypted Welcome message)
if (keyPackageEvent) {
  await group.inviteByKeyPackageEvent(keyPackageEvent);
  console.log("User invited!");
}
```

## Send a Message

```typescript
import { getEventHash } from "applesauce-core/helpers";

const rumor = {
  kind: 9, // Chat message
  pubkey: myPubkey,
  created_at: Math.floor(Date.now() / 1000),
  content: "Hello team!",
  tags: [],
  id: rumorId,
};
const rumorId = getEventHash(rumor);

await group.sendApplicationRumor(rumor);
```

## Receive Messages

```typescript
import { deserializeApplicationRumor } from "@internet-privacy/marmots";
import { bytesToHex } from "@noble/hashes/utils.js";

// Subscribe to group events
const subscription = client.network.subscription(group.relays, [
  { kinds: [445], "#h": [bytesToHex(group.groupData.nostrGroupId)] },
]);

subscription.subscribe({
  next: async (event) => {
    const results = group.ingest([event]);

    for await (const result of results) {
      if (result.kind === "applicationMessage") {
        const message = deserializeApplicationRumor(result.message);
        console.log(`${message.pubkey}: ${message.content}`);
      }
    }
  },
});
```

## Join a Group

```typescript
// When someone invites you, you'll receive a gift wrap (kind 1059)
// After decrypting it to get the inner kind 444 rumor:

const inviteRumor = decryptedGiftWrap;
const keyPackageEventId = inviteRumor.tags.find((t) => t[0] === "e")?.[1];

const group = await client.joinGroupFromWelcome({
  welcomeRumor: inviteRumor,
  keyPackageEventId,
});

console.log(`Joined group: ${bytesToHex(group.id)}`);
```

## Next Steps

- **[UI Framework Integration](/client/ui-frameworks)** - Learn how to integrate MarmotClient with React, Svelte, or vanilla JavaScript
- **[Client Module](/client/)** - Explore the high-level client implementation for building applications
- **[Core Module](/core/)** - Learn about the protocol layer and fundamental building blocks
- **[Protocol Specs](https://github.com/parres-hq/marmot)** - Dive deep into the Marmot protocol specifications

## Architecture Overview

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

The **Client Module** provides high-level APIs for building applications, while the **Core Module** implements the Marmot protocol specifications on top of MLS and Nostr primitives.
