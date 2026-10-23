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

The examples below also import types from `applesauce-core`. It is a dependency of marmot-ts, but package managers such as pnpm won't let your app import it unless you add it too (`pnpm add applesauce-core@^7`). marmot-ts v0.8 uses Applesauce v7; upgrade any Applesauce packages your application uses to v7 together. Nostr-specific gift-wrap helpers and factories live in `applesauce-common`.

## Setup Storage

Marmot stores serialized MLS state and key package metadata in key/value stores that your app provides. For development, use the in-memory store from the `extra` subpath:

```typescript
import type {
  SerializedClientState,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new InMemoryKeyValueStore<SerializedClientState>();
const keyPackageStore = new InMemoryKeyValueStore<StoredKeyPackage>();
```

::: tip Production storage
Production apps need durable stores: IndexedDB in the browser, the file system in Node.js, or SQLite in React Native. Also pass `ingestStateStore`, `inviteStore`, `rewindStore` and `removedMarkerStore`, backed by the same durable storage. Any store you leave out falls back to memory and is lost on restart. Without `ingestStateStore`, `client.ingestPersistence.kind` is `"ephemeral"`. See [Storage](/client/storage).
:::

## Setup Network Interface

Implement the `NostrNetworkInterface` so the client can talk to relays. It has four methods. In this sketch, `myPool` represents your adapter: its `publish` returns a record of relay outcomes and its `request` returns a promise of events. A raw Applesauce `RelayPool` needs conversion because its `publish` returns an array and its `request` returns an RxJS observable.

```typescript
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";
import { getInboxRelays } from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { Filter } from "applesauce-core/helpers/filter";

// Relays used to look up other users' relay lists (kind 10002 / 10050)
const lookupRelays = ["wss://purplepag.es", "wss://relay.example.com"];

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

  // Resolve a user's kind 10050 inbox relays (where their Welcomes are delivered).
  async getUserInboxRelays(pubkey: string): Promise<string[]> {
    const lists = await myPool.request(lookupRelays, [
      { kinds: [10050], authors: [pubkey] },
    ]);
    const newest = lists.sort((a, b) => b.created_at - a.created_at)[0];
    return newest ? getInboxRelays(newest) : [];
  },
};
```

::: tip Reference adapter
The [`opentui` example](https://github.com/marmot-protocol/marmot-ts/tree/master/examples/opentui) wraps [`applesauce-relay`](https://applesauce.build/) in a complete `NostrNetworkInterface`. See [Network](/client/network) for the full contract and Applesauce v7 authentication guidance.
:::

## Initialize the Client

The signer must implement `nip44` encryption and decryption as well as `signEvent`. Marmot uses NIP-44 to seal outgoing Welcome gift wraps and to open incoming ones. In applesauce's `EventSigner` type, `nip44` is optional, so check that your signer provides it.

Each install also needs a **KeyPackage slot id**. This is the `d` tag of your kind 30443 key package event. The spec ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)) requires 32 random bytes, written as lowercase hex. Generate it once, persist it, and reuse it. Never derive it from a device name or any identity key.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Generate once per install, persist, and reuse forever
let clientId = await settings.get("marmotKeyPackageSlot");
if (!clientId) {
  clientId = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await settings.set("marmotKeyPackageSlot", clientId);
}

const client = new MarmotClient({
  signer: yourNostrSigner, // applesauce EventSigner with nip44 support
  network,
  groupStateStore,
  keyPackageStore,
  clientId, // default kind 30443 `d` slot
});

const myPubkey = await client.signer.getPublicKey();
```

::: warning Spec deviation
The spec requires the slot id to be random 32-byte hex (`transports/nostr.md`). marmot-ts rejects identifiers unless they are exactly 64 lowercase hex characters. Persist the generated slot; migrate device labels by generating a new conformant slot.
:::

::: tip Multi-Account Applications
If your app supports multiple user accounts, give each account its own isolated storage so key material can't leak between accounts. See [MarmotClient](/client/marmot-client) for the multi-account pattern.
:::

## Publish Your Relay Lists

Peers look for your key packages on your kind 10002 (NIP-65) **write** relays. There is no dedicated key package relay list. They deliver Welcomes to your kind 10050 inbox relays. Publish both lists before you expect invites ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)):

```typescript
import {
  createInboxRelayListEvent,
  createNip65RelayListEvent,
} from "@internet-privacy/marmot-ts";

const outboxRelays = ["wss://relay.example.com"]; // your NIP-65 write relays
const inboxRelays = ["wss://inbox.example.com"]; // where you receive Welcomes

const nip65 = await client.signer.signEvent(
  createNip65RelayListEvent({ pubkey: myPubkey, relays: outboxRelays }),
);
const inbox = await client.signer.signEvent(
  createInboxRelayListEvent({ pubkey: myPubkey, relays: inboxRelays }),
);
await client.network.publish([...outboxRelays, ...lookupRelays], nip65);
await client.network.publish([...outboxRelays, ...lookupRelays], inbox);
```

## Publish a Key Package

Before others can add you to groups, publish a key package to your NIP-65 write relays:

```typescript
const keyPackage = await client.keyPackages.create({
  relays: outboxRelays, // your kind 10002 write relays
  client: "my-chat-app",
  // `d` slot defaults to the client's `clientId`
});
```

To publish on startup only when you don't already hold an unused key package, call `client.keyPackages.ensurePublished({ relays: outboxRelays })`.

::: warning Spec deviation
The kind 30443 tag set in `transports/nostr.md` has no `relays` tag. marmot-ts still adds one, listing the relays you pass.
:::

## Create a Group

```typescript
const group = await client.groups.create("Engineering Team", {
  description: "Secure team communications",
  relays: ["wss://relay.example.com"],
  // The creator is always an admin; list *additional* admins in `adminPubkeys`
});

console.log(`Created group (MLS group_id): ${group.idStr}`);
console.log(`Routing tag (nostr_group_id): ${group.info.nostr.groupIdHex}`);
```

A solo create only builds local state. Nothing is published until you invite someone or send a message.

## Invite a Member

Get the invitee's key packages from their kind 10002 write relays. Then choose one that the group can actually add:

```typescript
import { getNip65Relays } from "@internet-privacy/marmot-ts";

const memberPubkey = "<64-char hex pubkey>";

// 1. Their NIP-65 write relays are where their key packages live
const relayLists = await client.network.request(lookupRelays, [
  { kinds: [10002], authors: [memberPubkey] },
]);
const relayList = relayLists.sort((a, b) => b.created_at - a.created_at)[0];
const keyPackageRelays = relayList ? getNip65Relays(relayList, "write") : [];

// 2. Fetch their key packages and keep the newest one this group can add
const candidates = await client.network.request(keyPackageRelays, [
  { kinds: [30443], authors: [memberPubkey] },
]);
const keyPackageEvent = candidates
  .sort((a, b) => b.created_at - a.created_at)
  .find((event) => group.evaluateKeyPackage(event).eligible);

// 3. Commit the Add. Once relays ack the commit, the Welcome is gift-wrapped
//    to the invitee's kind 10050 inbox relays (via network.getUserInboxRelays)
if (keyPackageEvent) await client.groups.invite(group.id, keyPackageEvent);
```

`client.groups.invite()` builds the commit with `createInviteIntent()`. The commit verifies the key package event's signature, tags and lifetime before anything is published. To add several people at once, or to add the first members while creating a group, see [MarmotClient](/client/marmot-client) and [Proposals](/client/proposals).

## Send a Message

Build the chat rumor in your app, turn it into an application-message intent, and send it with the manager's `send` helper:

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

If the group is still resolving concurrent commits, `send()` queues the message and sends it once the group settles.

## Receive Messages

`client.groups.connectAll()` connects every loaded group to its relays. It fetches past kind 445 events, subscribes for new ones, verifies each event's signature and `h` tag, drops duplicates, and feeds the rest to the group. Decrypted messages are emitted as `applicationMessage` events:

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

group.on("applicationMessage", (data) => {
  const message = deserializeApplicationData(data);
  console.log(`${message.pubkey}: ${message.content}`);
});

// Start once at app startup; groups created or joined later connect automatically
const groupSync = client.groups.connectAll();
// On shutdown: groupSync.unsubscribe();
```

See [MarmotGroup](/client/marmot-group) for ingest results and other group events.

## Join a Group

Listen for gift-wrapped Welcomes on your kind 10050 inbox relays, then join from the decrypted invite:

```typescript
const inviteSync = await client.invites.listen(inboxRelays);

for await (const invites of client.watchInvites()) {
  for (const { invite, joinable } of invites) {
    if (!joinable) continue; // we no longer hold the key package it was sent to

    const preview = await client.previewWelcome(invite);
    console.log(`Invited to ${preview.group?.name ?? "a group"}`);

    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await client.invites.markAsRead(invite.id);

    // Rotate your leaf key for forward secrecy. connectAll() catches the group up;
    // the commit is queued until the group settles.
    await group.selfUpdate();

    // Replace the consumed key package. This also deletes its private material.
    for (const kp of await client.keyPackages.list()) {
      if (kp.used) await client.keyPackages.rotate(kp.keyPackageRef);
    }

    console.log(`Joined group: ${group.idStr}`);
  }
}
```

`joinGroupFromWelcome()` does not do either post-join step for you. [`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md) asks joiners to self-update as soon as practical, before sending application messages. They should also rotate the consumed key package.

::: warning Spec deviation
`foundation/key-packages.md` requires deleting a consumed key package's private material. `joinGroupFromWelcome()` only marks the key package as `used`. Call `client.keyPackages.rotate()` or `remove()` to delete it, as shown above.
:::

## Next Steps

- **[Client Module](/client/)**: the full client API (groups, key packages, invites, history)
- **[UI Framework Integration](/client/ui-frameworks)**: using MarmotClient with React, Svelte, or vanilla JavaScript
- **[Best Practices](/client/best-practices)**: commits, persistence, and relay selection
- **[Core Module](/core/)**: the protocol layer and its building blocks
- **[Protocol Specs](https://github.com/marmot-protocol/marmot)**: the Marmot protocol specification (start with `layout.md`)

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
│      Engine Module                  │
│  (convergence & ingest)             │
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

The **Client Module** gives you the high-level APIs and Nostr I/O. The **Engine** is a transport-independent group state machine that handles convergence and ingest. The **Core Module** implements the Marmot protocol on top of MLS and Nostr primitives. See [Architecture](/guide/architecture) for details.
