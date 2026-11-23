# marmot-ts

TypeScript implementation of the [Marmot protocol](https://github.com/marmot-protocol/marmot) — end-to-end encrypted group messaging on Nostr using [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/).

> [!WARNING]
> This library is in **Alpha** and under heavy development. The API is subject to breaking changes without notice. It relies on [ts-mls](https://github.com/LukaJCB/ts-mls) for MLS cryptographic guarantees. Do not use in production yet.

## Features

- 🔐 **End-to-end encrypted** group messaging using MLS (RFC 9420)
- 🌐 **Decentralized** — groups operate across Nostr relays
- 🔑 **Key package lifecycle** — publishing, rotation, deletion
- 📦 **Storage-agnostic** — one typed database per group plus an account database, with built-in IndexedDB, SQLite and in-memory adapters; message history is queryable through real indexes
- 🔌 **Network-agnostic** — works with any Nostr client library
- 📱 **Cross-platform** — browsers, Node.js (v20+), Bun (v1.1+), and Deno (v2+)

## Marmot Protocol Compliance

`marmot-ts` tracks the **Marmot v2** protocol and is wire-compatible with the [darkmatter](https://github.com/parres-hq/darkmatter) reference implementation — including the v2 app-component group model, MLS `PublicMessage`-framed handshakes, and the account identity proof app component (`0x8009`, `marmot.member.account-identity-proof.v2`).

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

1. **A signer** (`EventSigner`, from `applesauce-core`) — signs Nostr events on behalf of the user, including the `0x8009` account identity proof carried on every key package's LeafNode.
2. **A network interface** (`NostrNetworkInterface`) — publishes, requests, and subscribes to events on relays.
3. **A database** (`MarmotDatabase`) — persists each group's state, fork history and message history, plus key packages (with private keys) and invites.

You can optionally supply:

- **`clientId`** — a stable `d`-tag slot: 32 random bytes encoded as 64 lowercase hex characters, persisted and reused for your kind 30443 key packages.

The client exposes three managers — `client.groups`, `client.keyPackages`, and `client.invites` — plus `client.network` and the `joinGroupFromWelcome` entry point.

## Storage

```ts
import { memoryDatabase } from "@internet-privacy/marmot-ts";
import {
  indexedDBDatabase,
  sqliteDatabase,
} from "@internet-privacy/marmot-ts/extra";

const database = memoryDatabase(); // tests and short-lived processes
// const database = indexedDBDatabase({ prefix: `marmot:${pubkey}` });
// const database = sqliteDatabase({ execute: (sql, params) => ... });
```

Each group gets its own database of typed tables (state, fork history, processed events, messages and their deliveries), and the account database holds key packages, invites and the group list. See [Storage](docs/client/storage.md) for the contract and for writing your own adapter.

## Quick Start

### Create the client

```ts
import { MarmotClient } from "@internet-privacy/marmot-ts";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

// Generate once per installation, persist it, and load the same slot on restart.
const clientId = bytesToHex(randomBytes(32));

const client = new MarmotClient({
  signer, // your EventSigner (e.g. from applesauce-core)
  network, // your NostrNetworkInterface implementation
  database, // MarmotDatabase
  clientId, // persisted random slot; arbitrary device labels are rejected
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

| Import path                          | Contents                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `@internet-privacy/marmot-ts`        | The common surface — re-exports `./client`, `./core`, and `./utils`                             |
| `@internet-privacy/marmot-ts/client` | `MarmotClient`, `MarmotGroup`, managers, intents, history, network                              |
| `@internet-privacy/marmot-ts/core`   | Protocol/crypto/state primitives with no app I/O                                                |
| `@internet-privacy/marmot-ts/engine` | `MarmotGroupEngine` and the convergence/ingest state machine                                    |
| `@internet-privacy/marmot-ts/extra`  | Storage adapters — `indexedDBDatabase` and `sqliteDatabase` — and audit writers                 |
| `@internet-privacy/marmot-ts/utils`  | Encoding, Nostr, relay-url, and timestamp helpers                                               |
| `@internet-privacy/marmot-ts/mls`    | The forked [`ts-mls`](https://github.com/hzrd149/ts-mls) MLS engine, bundled inside the package |

Import MLS primitives (ciphersuites, `ClientState`, `processMessage`, and so on) from
`@internet-privacy/marmot-ts/mls`, not from a separately installed `ts-mls`. npm `ts-mls`
is the upstream build; it lacks the fork's additions (`app_data_dictionary`, self-remove,
`senderLeafIndex`, the `GroupContext` encoder), and its classes and types are distinct
from the copy marmot-ts uses. The X448, ChaCha20-Poly1305, ML-KEM, X-Wing and ML-DSA
backends are optional peer dependencies, needed only for those ciphersuites.

## Documentation

Full documentation is in `docs/` and served via VitePress. Run `pnpm docs:dev` to browse locally.

- **[Getting Started](docs/getting-started.md)** — first-run walkthrough
- **[Concepts](docs/guide/concepts.md)** — terms, module layers, and event kinds
- **Setup** — [network](docs/client/network.md), [storage](docs/client/storage.md), [multiple accounts](docs/client/multi-account.md)
- **Guides** — [key packages](docs/client/key-packages.md), [groups](docs/client/groups.md), [invites](docs/client/invites.md), [messages](docs/client/messages.md), [history](docs/client/history.md), [media](docs/client/media.md), [UI frameworks](docs/client/ui-frameworks.md), [production checklist](docs/client/best-practices.md)
- **[Low-level API](docs/advanced/low-level.md)** — using `core` and `engine` directly

`pnpm docs:build` also generates the TypeDoc API reference beside the guides.

## Development

Use Node.js 20+ and pnpm 10. Test-source typing is an explicit command, separate
from runtime tests and watch mode; the Node 20/22/24 CI matrix enforces it.

```bash
pnpm install --frozen-lockfile # Install declared dependencies
pnpm build                    # Compile and vendor the ts-mls fork
pnpm typecheck:tests           # Strictly check all src tests and helpers
pnpm vitest run               # Run runtime tests once
pnpm test                     # Run runtime tests in watch mode
pnpm format                   # Format code with Prettier
pnpm docs:dev                 # Serve topic guides locally
pnpm docs:build               # Build guides and generate the API reference
```

See [Contributing](CONTRIBUTING.md) for the complete validation workflow.
