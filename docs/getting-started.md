# Getting Started

This page walks through a complete Marmot flow with `MarmotClient`: set up a client, publish a key package, create a group, invite someone, exchange messages and join a group from an invite. For the terms used here, see [Concepts](/guide/concepts).

## Install

::: code-group

```bash [npm]
npm install @internet-privacy/marmot-ts applesauce-core
```

```bash [pnpm]
pnpm add @internet-privacy/marmot-ts applesauce-core
```

```bash [yarn]
yarn add @internet-privacy/marmot-ts applesauce-core
```

:::

The examples import Nostr types from `applesauce-core`. marmot-ts depends on it already, but strict package managers such as pnpm only let your app import packages it lists itself, so add it alongside marmot-ts (use the same major version marmot-ts depends on).

## Create stores

The client persists MLS group state and key package private material in key/value stores that you provide. The in-memory store is fine for trying things out:

```typescript
import type {
  SerializedClientState,
  StoredKeyPackage,
} from "@internet-privacy/marmot-ts";
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new InMemoryKeyValueStore<SerializedClientState>();
const keyPackageStore = new InMemoryKeyValueStore<StoredKeyPackage>();
```

Production apps need durable stores for these and the optional stores. See [Storage](/client/storage).

## Connect to relays

marmot-ts does not ship a relay client. You implement `NostrNetworkInterface` on top of the Nostr library you already use. Here `myPool` stands in for that library:

```typescript
import { getInboxRelays } from "@internet-privacy/marmot-ts";
import type { NostrNetworkInterface } from "@internet-privacy/marmot-ts/client";

// Relays used to look up other users' relay lists
const lookupRelays = ["wss://purplepag.es", "wss://relay.example.com"];

const network: NostrNetworkInterface = {
  // Resolve to { [relayUrl]: { from, ok, message? } }
  publish: (relays, event) => myPool.publish(relays, event),
  // Resolve a one-shot query to an array of events
  request: (relays, filters) => myPool.request(relays, filters),
  // Return a live subscription: { subscribe(observer) => { unsubscribe() } }
  subscription: (relays, filters) => myPool.subscription(relays, filters),
  // Where a user receives Welcomes (their newest kind 10050 list)
  async getUserInboxRelays(pubkey) {
    const lists = await myPool.request(lookupRelays, [
      { kinds: [10050], authors: [pubkey] },
    ]);
    const newest = lists.sort((a, b) => b.created_at - a.created_at)[0];
    return newest ? getInboxRelays(newest) : [];
  },
};
```

See [Network](/client/network) for complete Applesauce and nostr-tools adapters.

## Create the client

The signer must support `signEvent` and `nip44` encryption (used to seal and open gift-wrapped invites). Each install also needs a `clientId`: 32 random bytes as lowercase hex, generated once, persisted and reused. It is the `d` slot of your key package event.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

let clientId = await settings.get("marmotClientId");
if (!clientId) {
  clientId = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await settings.set("marmotClientId", clientId);
}

const client = new MarmotClient({
  signer, // applesauce EventSigner with nip44 support
  network,
  groupStateStore,
  keyPackageStore,
  clientId,
});

const myPubkey = await client.signer.getPublicKey();
```

::: warning
Never derive `clientId` from a device name or identity key, and don't regenerate it on each start. The client rejects anything other than 64 lowercase hex characters.
:::

## Publish relay lists and a key package

Peers fetch your key packages from your NIP-65 (kind 10002) **write** relays and deliver invites to your kind 10050 inbox relays. Publish both lists, then make sure an unused key package is published:

```typescript
import {
  createInboxRelayListEvent,
  createNip65RelayListEvent,
} from "@internet-privacy/marmot-ts";

const outboxRelays = ["wss://relay.example.com"];
const inboxRelays = ["wss://inbox.example.com"];

const nip65 = await client.signer.signEvent(
  createNip65RelayListEvent({ pubkey: myPubkey, relays: outboxRelays }),
);
const inbox = await client.signer.signEvent(
  createInboxRelayListEvent({ pubkey: myPubkey, relays: inboxRelays }),
);
await client.network.publish([...outboxRelays, ...lookupRelays], nip65);
await client.network.publish([...outboxRelays, ...lookupRelays], inbox);

// Idempotent: only publishes when no unused, current key package exists
await client.keyPackages.ensurePublished({
  relays: outboxRelays,
  client: "my-chat-app",
});
```

## Create a group

```typescript
const group = await client.groups.create("Engineering Team", {
  description: "Secure team communications",
  relays: ["wss://relay.example.com"],
});
```

You are the group's admin. A group created without invitees exists only locally until you invite someone or send a message.

## Invite a member

Fetch the invitee's key packages from their NIP-65 write relays, keep one this group can accept, and invite with it. After relays accept the commit, the client gift-wraps a Welcome to the invitee's inbox relays.

```typescript
import { getNip65Relays } from "@internet-privacy/marmot-ts";

const memberPubkey = "<64-char hex pubkey>";

const [relayList] = (
  await client.network.request(lookupRelays, [
    { kinds: [10002], authors: [memberPubkey] },
  ])
).sort((a, b) => b.created_at - a.created_at);
const keyPackageRelays = relayList ? getNip65Relays(relayList, "write") : [];

const candidates = await client.network.request(keyPackageRelays, [
  { kinds: [30443], authors: [memberPubkey] },
]);
const keyPackageEvent = candidates
  .sort((a, b) => b.created_at - a.created_at)
  .find((event) => group.evaluateKeyPackage(event).eligible);

if (keyPackageEvent) await client.groups.invite(group.id, keyPackageEvent);
```

See [Groups](/client/groups) for founding invitees, removals and other membership changes.

## Send a message

```typescript
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts/client";

const rumor = createChatRumor({ pubkey: myPubkey, content: "Hello team!" });
await client.groups.send(group.id, createApplicationMessageIntent(rumor));
```

## Receive messages

`connectAll()` backfills and subscribes every loaded group, including groups created or joined later. Decrypted messages arrive as `applicationMessage` events:

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

group.on("applicationMessage", (data) => {
  const message = deserializeApplicationData(data);
  console.log(`${message.pubkey}: ${message.content}`);
});

// Start once at app startup; call groupSync.unsubscribe() on shutdown
const groupSync = client.groups.connectAll();
```

See [Messages](/client/messages) for custom message kinds and ingest results.

## Join a group

Listen for gift-wrapped invites on your inbox relays and join from the decrypted Welcome. After joining, rotate your leaf key with `selfUpdate()` and replace the consumed key package so others can still invite you.

```typescript
const inviteSync = await client.invites.listen(inboxRelays);

for await (const invites of client.watchInvites()) {
  for (const { invite, joinable } of invites) {
    if (!joinable) continue; // we no longer hold the key package it targets

    const preview = await client.previewWelcome(invite);
    console.log(`Invited to ${preview.group?.name ?? "a group"}`);

    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await client.invites.markAsRead(invite.id);

    // Post-join: rotate leaf key material for forward secrecy
    await group.selfUpdate();

    // Replace the consumed key package
    for (const kp of await client.keyPackages.list()) {
      if (kp.used) await client.keyPackages.rotate(kp.keyPackageRef);
    }
    await client.keyPackages.ensurePublished({ relays: outboxRelays });
  }
}
```

A real app should show the preview and let the user accept or decline rather than joining every invite automatically. See [Invites](/client/invites).

## Next steps

- [Concepts](/guide/concepts): terms, module layering and event kinds
- [Storage](/client/storage) and [Network](/client/network): production setup
- [Key packages](/client/key-packages): publishing, rotating and purging
- [Groups](/client/groups): membership, metadata and lifecycle
- [Invites](/client/invites): previewing and joining
- [Messages](/client/messages): sending, receiving and custom transports
- [History](/client/history), [Media](/client/media) and [Group images](/client/group-images)
- [UI frameworks](/client/ui-frameworks): React, Svelte, Solid, Vue and vanilla JS
- [Production checklist](/client/best-practices)
- [API reference](pathname:///reference/index.html)
