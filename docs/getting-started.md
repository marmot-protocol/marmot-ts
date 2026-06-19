---
heroImage: /images/marmot-quickstart.png
heroImageAlt: A pixel-art marmot wizard conjuring code in a underground burrow
---

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
npm install @internet-privacy/marmot-ts
```

```bash [pnpm]
pnpm add @internet-privacy/marmot-ts
```

```bash [yarn]
yarn add @internet-privacy/marmot-ts
```

:::

## Setup Storage

Marmot stores serialized MLS state and key package metadata in app-provided key/value stores. For development, use the in-memory store from the `extra` subpath:

```typescript
import type {
  SerializedClientState,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new InMemoryKeyValueStore<SerializedClientState>();
const keyPackageStore = new InMemoryKeyValueStore<StoredKeyPackage>();
```

::: tip Production Storage
For production apps, use IndexedDB (browser), file system (Node.js), or SQLite (React Native). See [Storage](/client/storage) for examples.
:::

## Setup Network Interface

Implement the `NostrNetworkInterface` so the client can talk to relays. It has four methods:

```typescript
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

const network: NostrNetworkInterface = {
  // Publish an event and report the per-relay outcome.
  async publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>> {
    // { [relayUrl]: { from, ok, message? } }
    return await myPool.publish(relays, event);
  },

  // Resolve a one-shot query to an array of events.
  async request(
    relays: string[],
    filters: Filter | Filter[],
  ): Promise<NostrEvent[]> {
    return await myPool.request(relays, filters);
  },

  // Open a live subscription that emits events as they arrive.
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent> {
    return myPool.subscription(relays, filters);
  },

  // Resolve a user's kind 10050 inbox relays (where they receive gift wraps).
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    return ["wss://relay.example.com"];
  },
};
```

::: tip Reference adapter
The [`opentui` example](https://github.com/marmot-protocol/marmot-ts/tree/master/examples/opentui) wraps [`applesauce-relay`](https://hzrd149.github.io/applesauce/) in a complete `NostrNetworkInterface`. See [Network](/client/network) for the full contract.
:::

## Initialize the Client

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const client = new MarmotClient({
  signer: yourNostrSigner, // EventSigner from applesauce-core or similar
  network,
  groupStateStore,
  keyPackageStore,
  clientId: "my-chat-app-desktop", // default key package slot identifier
});

const myPubkey = await client.signer.getPublicKey();
```

::: tip Multi-Account Applications
If your app supports multiple user accounts, each account must have isolated storage to prevent key material from leaking between accounts. See [Multi-Account Support](/client/marmot-client#multi-account-support) for implementation patterns.
:::

## Publish a Key Package

Before others can add you to groups, publish a key package:

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";

const keyPackage = await client.keyPackages.create({
  relays: ["wss://relay.example.com"],
  identifier: "my-chat-app-desktop", // kind 30443 `d` tag; optional if clientId is set
  client: "my-chat-app",
});

console.log(`Published key package ${bytesToHex(keyPackage.keyPackageRef)}`);
```

## Create a Group

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";

const group = await client.groups.create("Engineering Team", {
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
    [{ kinds: [30443], authors: [memberPubkey], limit: 1 }],
  )
  .then((events) => events[0]);

// Invite them (adds them in a commit and delivers an encrypted Welcome)
if (keyPackageEvent) {
  await client.groups.invite(group.id, keyPackageEvent);
  console.log("User invited!");
}
```

## Send a Message

Build the chat rumor at the app level, turn it into an application-message
intent, then drive it through the group's session/runtime seam (here via the
manager's `send` helper):

```typescript
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";

const rumor = createChatRumor({
  pubkey: myPubkey,
  content: "Hello team!",
});

await client.groups.send(group.id, createApplicationMessageIntent(rumor));
```

## Receive Messages

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";
import { bytesToHex } from "@noble/hashes/utils.js";

// Subscribe to group events
const subscription = client.network.subscription(group.relays, [
  { kinds: [445], "#h": [bytesToHex(group.groupData.nostrGroupId)] },
]);

subscription.subscribe({
  next: async (event) => {
    const results = group.ingest([event]);

    for await (const result of results) {
      if (
        result.kind === "processed" &&
        result.result.kind === "applicationMessage"
      ) {
        const message = deserializeApplicationData(result.result.message);
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
const { group } = await client.joinGroupFromWelcome({
  welcomeRumor: inviteRumor,
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
