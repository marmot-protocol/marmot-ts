# marmot-ts

TypeScript implementation of the [Marmot protocol](https://github.com/marmot-protocol/marmot) — end-to-end encrypted group messaging on Nostr using [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/).

> [!WARNING]
> This library is in **Alpha** and under heavy development. The API is subject to breaking changes without notice. It relies on [ts-mls](https://github.com/LukaJCB/ts-mls) for MLS cryptographic guarantees. Do not use in production yet.

## Features

- 🔐 **End-to-end encrypted** group messaging using MLS (RFC 9420)
- 🌐 **Decentralized** — groups operate across Nostr relays
- 🔑 **Key package lifecycle** — publishing, rotation, deletion
- 📦 **Storage-agnostic** — bring any `GenericKeyValueStore` backend (LocalForage, IndexedDB, in-memory, …)
- 🔌 **Network-agnostic** — works with any Nostr client library
- 📱 **Cross-platform** — browsers, Node.js (v20+), Bun (v1.1+), and Deno (v2+)

## Marmot Protocol Compliance

`marmot-ts` tracks the **Marmot v2** protocol and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation — including the v2 app-component group model, MLS `PublicMessage`-framed handshakes, and the `marmot.account-identity-proof.v1` LeafNode extension.

It currently supports the following [Marmot Improvement Proposals (MIPs)](https://github.com/marmot-protocol/mips):

| MIP                                                                        | Description                             | Status         |
| -------------------------------------------------------------------------- | --------------------------------------- | -------------- |
| [MIP-00](https://github.com/marmot-protocol/mips/blob/main/mips/mip-00.md) | Introduction and Basic Operations       | ✅ Supported   |
| [MIP-01](https://github.com/marmot-protocol/mips/blob/main/mips/mip-01.md) | Network Transport & Relay Communication | ✅ Supported   |
| [MIP-02](https://github.com/marmot-protocol/mips/blob/main/mips/mip-02.md) | Identities and Keys                     | ✅ Supported   |
| [MIP-03](https://github.com/marmot-protocol/mips/blob/main/mips/mip-03.md) | Group State & Memberships               | ✅ Supported   |
| [MIP-04](https://github.com/marmot-protocol/mips/blob/main/mips/mip-04.md) | Encrypted Media                         | 🚧 In progress |

## Installation

```bash
npm install @internet-privacy/marmot-ts
# or
pnpm add @internet-privacy/marmot-ts
```

## Concepts

A `MarmotClient` needs four things to operate:

1. **A signer** (`EventSigner`, from `applesauce-core`) — signs Nostr events on behalf of the user.
2. **A network interface** (`NostrNetworkInterface`) — publishes, requests, and subscribes to events on relays.
3. **A group state store** — persists serialized MLS group state (`GenericKeyValueStore<SerializedClientState>`).
4. **A key package store** — persists local key package material (`GenericKeyValueStore<StoredKeyPackage>`).

The stores share a single interface: `GenericKeyValueStore<T>`.

You can optionally supply:

- **`accountProofSigner`** — signs the `marmot.account-identity-proof.v1` LeafNode extension. This needs raw BIP-340 access (the applesauce `EventSigner` cannot provide it) and is required for full wire interop with darkmatter, which validates the proof on every leaf.
- **`inviteStore`** — persists received invites; defaults to an in-memory store.
- **`historyFactory`** — wires a per-group message history backend (see [`GroupRumorHistory`](docs/client/history.md)).
- **`clientId`** — a stable `d`-tag slot for your published kind 30443 key packages.

The client exposes three managers — `client.groups`, `client.keyPackages`, and `client.invites` — plus `client.network` and the `joinGroupFromWelcome` entry point.

## Storage

```ts
interface GenericKeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}
```

Any backend that matches this shape works. [LocalForage](https://github.com/localForage/localForage) instances satisfy it directly:

```ts
import localforage from "localforage";

const groupStateStore = localforage.createInstance({ name: "marmot-groups" });
const keyPackageStore = localforage.createInstance({ name: "marmot-keys" });
```

For tests or short-lived processes, the library ships an in-memory implementation under the `./extra` subpath:

```ts
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new InMemoryKeyValueStore();
const keyPackageStore = new InMemoryKeyValueStore();
```

## Quick Start

### Create the client

```ts
import { MarmotClient } from "@internet-privacy/marmot-ts";

const client = new MarmotClient({
  signer, // your EventSigner (e.g. from applesauce-core)
  network, // your NostrNetworkInterface implementation
  groupStateStore, // GenericKeyValueStore<SerializedClientState>
  keyPackageStore, // GenericKeyValueStore<StoredKeyPackage>
  clientId: "my-app-desktop", // stable d-tag for kind 30443 key packages
});
```

### Publish a key package

Other users invite you by referencing a key package you've published to relays.

```ts
await client.keyPackages.create({
  relays: ["wss://relay.example.com"],
});
```

### Create a group

```ts
const group = await client.groups.create("My Secret Group", {
  description: "A private discussion",
  relays: ["wss://relay.example.com"],
  adminPubkeys: [await client.signer.getPublicKey()],
});
```

### Send a message

Messages are app-defined Nostr rumors. Build a chat rumor, wrap it in an
application-message intent, and submit it through the group's MLS session:

```ts
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts";

const rumor = createChatRumor({
  pubkey: await client.signer.getPublicKey(),
  content: "Hello, world!",
});

await client.groups.send(group.id, createApplicationMessageIntent(rumor));
```

> `createChatRumor` produces a kind 9 rumor — a chat convention, not part of the
> protocol. You can serialize any unsigned rumor as an application message.

### Invite a member

Look up their key package event on a relay, then invite by event. This adds them
in a single commit and delivers an encrypted Welcome:

```ts
const [keyPackageEvent] = await client.network.request(
  ["wss://relay.example.com"],
  [{ kinds: [30443], authors: [memberPubkey], limit: 1 }],
);

if (keyPackageEvent) {
  await client.groups.invite(group.id, keyPackageEvent);
}
```

### Join a group from an invite

Invites arrive as kind 1059 gift wraps. The `client.invites` manager ingests,
decrypts, and stores them for you:

```ts
// Feed gift-wrap events in as they arrive from relays
await client.invites.ingestEvent(giftWrapEvent);

// Decrypt pending gift wraps into kind 444 Welcome rumors
await client.invites.decryptGiftWraps();

// getUnread() returns the decrypted kind 444 Welcome rumors directly
const [welcomeRumor] = await client.invites.getUnread();
if (welcomeRumor) {
  const { group } = await client.joinGroupFromWelcome({ welcomeRumor });
  await client.invites.markAsRead(welcomeRumor.id);
}
```

If you already hold a decrypted kind 444 Welcome rumor, you can join directly:

```ts
const { group } = await client.joinGroupFromWelcome({ welcomeRumor });
```

### Receive messages

Decrypted application messages surface through the group's `applicationMessage`
event as serialized rumors — deserialize them with `deserializeApplicationData`:

```ts
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

group.on("applicationMessage", (data) => {
  const rumor = deserializeApplicationData(data);
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});
```

To deliver inbound traffic, subscribe to the group's relays for kind 445 events
and feed them to `group.ingest`. The async generator drives MLS processing and
yields a disposition per event (`processed`, `unreadable`, `deferred`, …);
readable application messages are emitted via the event above:

```ts
import { bytesToHex } from "@noble/hashes/utils.js";

const subscription = client.network.subscription(group.relays, [
  { kinds: [445], "#h": [bytesToHex(group.groupData.nostrGroupId)] },
]);

subscription.subscribe({
  next: async (event) => {
    for await (const result of group.ingest([event])) {
      if (result.kind === "unreadable")
        console.warn("dropped an unreadable event");
    }
  },
});
```

## Package entrypoints

The `exports` map exposes the library as focused subpaths:

| Import path                          | Contents                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `@internet-privacy/marmot-ts`        | The common surface — re-exports `./client`, `./core`, and `./utils`         |
| `@internet-privacy/marmot-ts/client` | `MarmotClient`, `MarmotGroup`, managers, intents, history, network          |
| `@internet-privacy/marmot-ts/core`   | Protocol/crypto/state primitives with no app I/O                            |
| `@internet-privacy/marmot-ts/engine` | `MarmotGroupEngine` and the convergence/ingest state machine                |
| `@internet-privacy/marmot-ts/extra`  | Optional stores — `InMemoryKeyValueStore`, encrypted store, history backend |
| `@internet-privacy/marmot-ts/utils`  | Encoding, key-value, Nostr, relay-url, and timestamp helpers                |
| `@internet-privacy/marmot-ts/mls`    | Re-export of [`ts-mls`](https://github.com/LukaJCB/ts-mls)                  |

## Documentation

Full documentation is in `docs/` and served via VitePress. Run `pnpm docs:dev` to browse locally.

- **[Getting Started](docs/getting-started.md)** — first-run walkthrough
- **[Architecture](docs/guide/architecture.md)** — component overview and Nostr/MLS mapping
- **[Client Module](docs/client/)** — `MarmotClient`, `MarmotGroup`, storage, network, UI integration
- **[Core Module](docs/core/)** — protocol, credentials, key packages, groups, messages, welcome

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Compile TypeScript
pnpm test       # Run tests (watch mode)
pnpm format     # Format code with Prettier
pnpm docs:dev   # Serve documentation locally
pnpm docs:build # Build documentation
```
