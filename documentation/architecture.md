# Architecture & Protocol Design

`marmot-ts` is a Typescript implementation of the [Marmot Protocol](https://github.com/marmot-protocol/marmot). It bridges the [Nostr network](https://github.com/nostr-protocol/nips) with the cryptographic guarantees of [MLS (Messaging Layer Security)](https://messaginglayersecurity.rocks/) provided by `ts-mls`.

## High-Level Component Overview

The architecture splits responsibilities across two main abstractions:

1. **`MarmotClient`:** Handles global user identity operations (like discovering groups from welcome messages), acts as the main entry point to load or create groups, and manages global event listeners (`watchGroups()`, `watchKeyPackages()`). It relies directly on `ts-mls` for state management context.
2. **`MarmotGroup`:** Represents a single cryptographic session instance. It orchestrates MLS operations specific to a set of participants—such as generating proposals, committing changes (adds/removes), and exposing the application layer messaging interface (`sendApplicationRumor()`, `ingest()`).

### Cryptography & Storage

- **`ts-mls`:** The core engine ensuring forward secrecy, post-compromise security, and tree math. `marmot-ts` passes storage inputs recursively up to `ts-mls` objects (`ClientState`, `Group`).
- **Nostr Signer (`EventSigner`):** The standard Nostr keypair used to sign public Nostr events (Kind `443` and `445`), verifying the outer layer of the packet before it is parsed by `ts-mls`.
- **Storage Backends:** The state of groups (`GroupStateStore`) and users (`KeyPackageStore`) are deeply integrated using a ["Bytes-First Storage"](bytes-first-storage.md) approach to remain framework agnostic.

## Mapping MLS to Nostr (MIPs 00-03)

The Marmot Protocol dictates how standard MLS constructs are transmitted securely over Nostr. Currently, the library supports MIPs 00-03.

### 1. Key Packages (Identities and Keys - MIP-02)

In MLS, participants advertise "Key Packages" allowing others to unilaterally add them to groups asynchronously. In Nostr, `marmot-ts` publishes these packages as events (Kind `443`) whose content is the base64-encoded MLS KeyPackage.

- **Event Kind:** `443` (Marmot Key Package)
- **Tags:** `"mls_protocol_version"`, `"mls_ciphersuite"`, plus `"encoding"` (must be `base64`).
- **Content:** The base64-encoded bytes of the MLS Key Package.

### 2. Group Events (Network Transport - MIP-01)

MLS produces `MLSMessage` binary blobs. Because these blobs contain sensitive protocol metadata (who added whom, commit hashes), `marmot-ts` wraps them using NIP-44 authenticated encryption with an exporter secret bound to the group's current epoch.

- **Event Kind:** `445` (Marmot Group Event)
- **Tags:** `"h"` (Group ID hash), `"expiration"` (if applicable).
- **Content:** NIP-44 encrypted payload.

When parsing, the library leverages the robust [`ingest()`](ingest-methods.md) pipeline to decode the outer envelope and submit the inner MLS blob to the state engine.

### 3. Invites (Group State & Memberships - MIP-03)

When an admin creates a group and adds participants, MLS generates a "Welcome" message. Because the Welcome message contains the symmetric keys required to decrypt the initial state, it must be shared privately.

- **Transport:** Standard Nostr Gift Wraps (NIP-59 / Kind `1059`).
- **Rumor Kind:** `444` (Marmot Group Welcome Message).
- **Process:** The admin fetches a participant's `443` Key Package, generates the `444` Welcome, and wraps it in a NIP-59 payload directed at the user's NIP-65 inbox relays. The invited user decrypts the `1059` and uses `client.joinGroupFromWelcome({ welcomeRumor })`.

---

Next, explore how to initialize the [`MarmotClient`](marmot-client.md) to manage this state.
