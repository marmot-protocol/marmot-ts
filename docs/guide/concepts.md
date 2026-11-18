# Concepts

This page defines the terms used across the docs, shows how the library is layered, and lists the Nostr event kinds Marmot uses.

## Key terms

- **Group**: a set of members sharing MLS encryption state. Each group has an MLS group id (`group.id`) and a separate Nostr routing id used in the `h` tag of its events.
- **Member / leaf**: one installation in a group. An account (Nostr pubkey) can have several leaves, one per device.
- **Key package**: a member's published public key material. You need someone's key package to add them to a group. Each install publishes into one addressable slot, its `clientId`.
- **Proposal**: a suggested change to the group, such as adding or removing a member or updating metadata.
- **Commit**: applies proposals and advances the group to a new **epoch** with fresh keys. Membership and metadata changes need an admin; any member can commit its own self-update or departure.
- **Welcome**: the MLS message that lets a new member join. It is delivered as a gift-wrapped invite.
- **Rumor**: an unsigned Nostr event. Application messages are rumors encrypted inside the group, so they never carry a signature that could leak outside it.
- **Convergence**: when members commit concurrently, every client deterministically picks the same winning branch. Sends are queued until the group settles.
- **App component**: a typed entry in the group's MLS app-data dictionary carrying Marmot metadata (profile, admins, relays, media policy).

## Module layering

```
your app
   │
   ▼
client   MarmotClient, MarmotGroup, managers, Nostr I/O, storage
   │
   ▼
engine   transport-independent group state machine (ingest, convergence)
   │
   ▼
core     Marmot protocol: credentials, key packages, groups, messages; no I/O
   │
   ▼
ts-mls   RFC 9420 MLS (bundled fork)
```

Most apps only need `MarmotClient`. Drop to lower layers when you need control the client does not give you; see [Low-level APIs](/advanced/low-level).

| Import                                                                 | Use it for                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@internet-privacy/marmot-ts`                                          | Everything most apps need: client, core and utils, plus the main engine classes       |
| `@internet-privacy/marmot-ts/client`                                   | `MarmotClient`, `MarmotGroup`, managers, network types, message helpers               |
| `@internet-privacy/marmot-ts/core`                                     | Protocol building blocks with no I/O                                                  |
| `@internet-privacy/marmot-ts/engine`                                   | The full engine surface, for custom transports or persistence                         |
| `@internet-privacy/marmot-ts/mls`                                      | The bundled ts-mls fork (ciphersuites, crypto provider, MLS types)                    |
| `@internet-privacy/marmot-ts/extra`                                    | Optional helpers: in-memory and encrypted key/value stores, key/value history backend |
| `@internet-privacy/marmot-ts/audit`                                    | Audit event types and helpers for forensic logging                                    |
| `@internet-privacy/marmot-ts/extra/audit/node`, `/extra/audit/browser` | Ready-made audit log writers for Node.js and browsers                                 |
| `@internet-privacy/marmot-ts/utils`                                    | Encoding, key/value, relay URL and Nostr helpers                                      |

## Event kinds

| Kind  | What it is                                                                           | Where it goes                         |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------- |
| 10002 | NIP-65 relay list; its **write** relays are where your key packages live             | Your outbox and lookup relays         |
| 10050 | Inbox relay list; where you receive invites                                          | Your outbox and lookup relays         |
| 30443 | Key package (addressable; `d` tag is your `clientId`)                                | Your NIP-65 write relays              |
| 445   | Group event: commits, proposals and encrypted application messages                   | The group's relays                    |
| 444   | Welcome rumor (unsigned), sealed inside a gift wrap                                  | Never published directly              |
| 1059  | NIP-59 gift wrap carrying a Welcome                                                  | The invitee's kind 10050 inbox relays |
| 5     | NIP-09 deletion, published when you purge key packages                               | Your NIP-65 write relays              |
| 450   | Account identity proof, a signed event embedded in each key package and leaf         | Never published directly              |
| 9     | Chat message rumor from `createChatRumor` (app convention, not part of the protocol) | Encrypted inside kind 445             |

## Security guarantees

- **End-to-end encryption**: only current group members can read application messages.
- **Forward secrecy**: compromising today's keys does not reveal earlier messages.
- **Post-compromise security**: a commit (for example `selfUpdate()`) heals the group after a key compromise.
- **Unlinkable group events**: each kind 445 event is signed by a fresh ephemeral key and its content is wrapped in an extra ChaCha20-Poly1305 layer keyed from the group's MLS exporter secret, so relays cannot tie events to members.
- **Private invites**: Welcomes travel in NIP-59 gift wraps, hiding sender and group from relays.
- **Identity binding**: every key package and leaf carries a proof signed by the member's Nostr key, so a leaf cannot claim someone else's pubkey.
- **Admin policy**: commits that change membership or metadata are rejected unless an admin made them.
- **Verified input**: inbound events have their signatures checked before they reach the protocol layer.

Your Nostr signer and your stores remain part of your trust boundary: anyone who can read the client's `storage` can read the group. See [Storage](/client/storage).
