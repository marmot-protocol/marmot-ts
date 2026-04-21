# Architecture & Protocol Design

`marmot-ts` is a Typescript implementation of the [Marmot Protocol](https://github.com/marmot-protocol/marmot). It bridges the [Nostr network](https://github.com/nostr-protocol/nips) with the cryptographic guarantees of [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/) provided by `ts-mls`.

## High-Level Component Overview

The architecture splits responsibilities across one entry-point class and a small family of sub-managers:

1. **`MarmotClient`:** The root object. Holds the user's `EventSigner`, MLS `Capabilities`, `CryptoProvider`, and `NostrNetworkInterface`. It owns three sub-managers (`groups`, `keyPackages`, `invites`) and exposes `joinGroupFromWelcome` / `readInviteGroupInfo` as higher-level helpers that combine key package lookup with MLS join logic.
2. **`GroupsManager` (`client.groups`):** Manages the lifecycle of `MarmotGroup` instances — persistence, in-memory caching, creation, loading, unloading, destroying, leaving, and watching (`client.groups.watch()`).
3. **`KeyPackageManager` (`client.keyPackages`):** Handles local private key material and the Nostr key package events that advertise this client to potential inviters. Creates, rotates, and purges key packages, and tracks events observed on relays (`client.keyPackages.track(event)`).
4. **`InviteManager` (`client.invites`):** Accepts gift-wrapped (kind 1059) events, stores them, decrypts them into kind 444 Welcome rumors, and exposes them to your UI via `watchUnread()` / `getUnread()`.
5. **`MarmotGroup`:** Represents a single MLS session. It orchestrates MLS operations for a set of participants — generating proposals (`propose`), committing changes (`commit`), sending (`sendApplicationRumor`, `sendChatMessage`) and receiving (`ingest`) application-layer messages, and publishing the resulting kind 445 events.

### Cryptography & Storage

- **`ts-mls`:** The core engine ensuring forward secrecy, post-compromise security, and tree math. `marmot-ts` passes serialized `ClientState` bytes to/from storage, re-hydrating them through the active `CryptoProvider` and a fixed `marmotAuthService` whenever a group is loaded.
- **Nostr Signer (`EventSigner`):** The standard Nostr keypair used to sign outer Nostr events (kind `30443`, `444`, `445`, `1059`). The signer's identity is bound into the MLS leaf node via a `basic` credential whose `identity` bytes are the 32-byte x-only Nostr pubkey.
- **Storage Backends:** Group state (`client.groupStateStore`) and key packages (`client.keyPackageStore`) live behind the `GenericKeyValueStore<T>` interface using a ["Bytes-First Storage"](bytes-first-storage.md) approach to remain framework-agnostic.

## Mapping MLS to Nostr (MIPs 00-03)

The Marmot Protocol dictates how standard MLS constructs are transmitted securely over Nostr. Currently, the library supports MIPs 00-03.

### 1. Key Packages (Identities and Keys - MIP-02)

In MLS, participants advertise "Key Packages" allowing others to unilaterally add them to groups asynchronously. In Nostr, `marmot-ts` publishes these packages as addressable events (kind `30443`) whose content is the base64-encoded MLS KeyPackage.

- **Event Kinds:** `30443` (addressable Marmot Key Package) is used for all new publishes. Legacy non-addressable `443` events are still recognised for reading and NIP-09 deletion.
- **Tags:** `"d"` (slot identifier, required on kind 30443), `"mls_protocol_version"`, `"mls_ciphersuite"`, `"mls_extensions"`, `"encoding"` (must be `base64`), `"i"` (MIP-00 KeyPackageRef as hex), plus optional `"relays"`, `"client"`, and `"-"` (NIP-70).
- **Content:** The base64-encoded bytes of the MLS Key Package.

Because kind 30443 is addressable, rotating a key package under the same `d` slot causes relays to automatically replace the old event. `KeyPackageManager.rotate()` exploits this so callers rarely need to emit NIP-09 deletions explicitly (deletions are only issued for legacy kind 443 events on the entry).

### 2. Group Events (Network Transport - MIP-01)

MLS produces `MLSMessage` binary blobs. Because these blobs contain sensitive protocol metadata (who added whom, commit hashes), `marmot-ts` wraps them using NIP-44 authenticated encryption with an exporter secret bound to the group's current epoch.

- **Event Kind:** `445` (Marmot Group Event)
- **Tags:** `"h"` (hex-encoded `nostrGroupId` from the Marmot Group Data extension).
- **Content:** NIP-44 encrypted payload containing the serialized MLSMessage.

When parsing, the library leverages the robust [`ingest()`](ingest-methods.md) pipeline to decode the outer envelope and submit the inner MLS blob to the state engine.

### 3. Invites (Group State & Memberships - MIP-03)

When an admin creates a group and adds participants, MLS generates a "Welcome" message. Because the Welcome message contains the symmetric keys required to decrypt the initial state, it must be shared privately.

- **Transport:** Standard Nostr Gift Wraps (NIP-59 / kind `1059`).
- **Rumor Kind:** `444` (Marmot Group Welcome Message).
- **Process:** The admin commits an Add proposal via `group.inviteByKeyPackageEvent(kp)` (or the lower-level `group.commit({ extraProposals, welcomeRecipients })`), which produces the `444` Welcome rumor, wraps it in a NIP-59 gift wrap, and delivers it to each recipient's NIP-65 inbox relays. The invited user feeds the received gift wrap into `client.invites.ingestEvent()`, decrypts it via `client.invites.decryptGiftWraps()`, and finally calls `client.joinGroupFromWelcome({ welcomeRumor })`. The client locates the matching local KeyPackage by comparing RFC 9420 `KeyPackageRef`s against `welcome.secrets[*].newMember` — the old `keyPackageEventId` parameter is no longer required.

---

Next, explore how to initialize the [`MarmotClient`](marmot-client.md) to manage this state.
