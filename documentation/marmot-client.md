# The `MarmotClient`

The `MarmotClient` acts as the root factory and supervisor for all MLS operations over Nostr. It holds the local identity, network transport, and storage backends, and exposes three sub-managers (`groups`, `keyPackages`, `invites`) for day-to-day work.

## Initialization

You instantiate the client by passing an `options` object. The options include the dependencies required to link Nostr signatures and persistence together:

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const client = new MarmotClient({
  signer: myApplesauceSigner,
  groupStateStore: myGroupStateStore,
  keyPackageStore: myKeyPackageStore,
  network: myNostrNetwork,
  // Optional:
  inviteStore: myInviteStore,
  capabilities: myMlsCapabilities,
  cryptoProvider: myCryptoProvider,
  clientId: "my-app-desktop",
  historyFactory: myHistoryFactory,
  mediaFactory: myMediaFactory,
});
```

### Options Breakdown

- **`signer`:** A compliant `EventSigner` (e.g. from `applesauce-core`). This is the root Nostr identity (npub).
- **`groupStateStore`:** A `GenericKeyValueStore<SerializedClientState>` where the serialized MLS `ClientState` bytes for every group are written. See [Bytes-First Storage](bytes-first-storage.md).
- **`keyPackageStore`:** A `GenericKeyValueStore<StoredKeyPackage>` that holds locally-generated key packages (including their private material) and publish records for any observed relay events.
- **`network`:** A `NostrNetworkInterface` (`request`, `subscription`, `publish`, `getUserInboxRelays`) linking the client to the Nostr relay network.
- **`inviteStore`:** Optional `GenericKeyValueStore<StoredInviteEntry>` used by `client.invites`. Defaults to an `InMemoryKeyValueStore` when omitted.
- **`capabilities`:** Optional MLS `Capabilities` override. Defaults to `defaultCapabilities()` which enables the MLS 1.0 protocol version, the x25519/AES128GCM/SHA256/Ed25519 ciphersuite family, and the Marmot Group Data + last_resort extensions.
- **`cryptoProvider`:** Optional MLS `CryptoProvider`. Defaults to `defaultCryptoProvider` from `ts-mls`.
- **`clientId`:** Optional default value for the addressable (kind 30443) `d` tag used by `client.keyPackages.create()` when no explicit `d` is supplied. Set this to a stable per-device string (e.g. `"my-app-desktop"`) so all key packages from this client share a single addressable slot on relays.
- **`historyFactory`:** Optional `(groupId) => BaseGroupHistory` factory. When provided, each loaded `MarmotGroup` is given its own history store so decrypted application messages can be persisted (see `GroupRumorHistory` in the examples folder for a reference implementation).
- **`mediaFactory`:** Optional `(groupId) => BaseGroupMedia` factory for caching decrypted media attachments (MIP-04). Defaults to in-memory.

## Managing Key Packages

Before someone can invite you to a group, they must fetch one of your "Key Package" events (kind 443 or kind 30443). Key Packages are MLS structures that bind your Nostr identity to single-use or last-resort (reusable) cryptographic material that an inviter can use to seed a new group for you.

### High-level: `client.keyPackages.create()`

The recommended way to publish a key package is through the manager — it generates the key material, persists the private half, signs the kind 30443 event, publishes it, and records the publish metadata in one call.

```typescript
const stored = await client.keyPackages.create({
  relays: ["wss://relay.example.com"],
  // Uses MarmotClient.clientId as the default `d` slot if set; otherwise
  // you must pass `d` explicitly here, or a MissingSlotIdentifierError is thrown.
  identifier: "my-app-desktop",
  // Optional extras:
  ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
  isLastResort: true, // default
  client: "my-chat-app",
  protected: false, // NIP-70 opt-in (many relays reject protected events)
});

console.log("Published key package ref:", stored.keyPackageRef);
```

Because kind 30443 is addressable, re-publishing under the same `d` slot automatically supersedes the previous event on relays. `KeyPackageManager.rotate(ref)` wraps this flow and also scrubs any legacy kind 443 events via NIP-09.

```typescript
const rotated = await client.keyPackages.rotate(stored.keyPackageRef);
```

### Low-level: manual generation

If you need precise control over the lifecycle (waiting for extension approvals, staged relay publishing, custom lifetimes, etc.), you can still use the core helpers directly:

```typescript
import {
  createCredential,
  generateKeyPackage,
  createKeyPackageEvent,
} from "@internet-privacy/marmot-ts";
import { defaultCryptoProvider, ciphersuites } from "ts-mls";

const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  ciphersuites.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
);

const credential = createCredential(myPubkey);

const completeKeyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  // - true (default): include MLS `last_resort` extension (reusable)
  // - false: omit it (single-use)
  isLastResort: true,
});

const unsignedEvent = await createKeyPackageEvent({
  keyPackage: completeKeyPackage.publicPackage,
  identifier: "my-app-desktop",
  relays: ["wss://relay.example.com"],
  client: "my-chat-app",
});

const signedEvent = await client.signer.signEvent(unsignedEvent);

await client.network.publish(["wss://relay.example.com"], signedEvent);

// Store the private half locally AND record the published event so future
// deletions/rotations can target it.
await client.keyPackages.add({
  publicPackage: completeKeyPackage.publicPackage,
  privatePackage: completeKeyPackage.privatePackage,
  identifier: "my-app-desktop",
});
await client.keyPackages.track(signedEvent);
```

### Watching local key packages

`KeyPackageManager` emits `added`, `removed`, `updated`, and `published` events, and exposes a convenience async generator:

```typescript
for await (const localPackages of client.keyPackages.watchKeyPackages()) {
  const unused = localPackages.filter((p) => !p.used);
  if (unused.length === 0) {
    console.warn(
      "Out of fresh key packages. Consider calling client.keyPackages.create().",
    );
  }
}
```

After a successful `joinGroupFromWelcome`, the key package that consumed the Welcome is marked `used: true` automatically. List `(await client.keyPackages.list()).filter(p => p.used)` to decide when to rotate.

## Managing Groups

Group lifecycle lives on `client.groups`. It keeps an in-memory cache of hydrated `MarmotGroup` instances and emits lifecycle events (`created`, `loaded`, `imported`, `joined`, `left`, `unloaded`, `destroyed`, `updated`).

### Creating & Loading

```typescript
// 1. Create a brand new group. The creator is automatically added to the admin list.
const group = await client.groups.create("Engineering Team", {
  description: "Dev ops.",
  relays: ["wss://relay.a", "wss://relay.b"],
  adminPubkeys: ["<other-admin-pubkey-hex>"],
  ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
});

// 2. Load a previously saved group from the store (returns the cached instance
//    on subsequent calls).
const loadedGroup = await client.groups.get(group.id); // accepts Uint8Array or hex string

// 3. Load *all* persisted groups at once.
const allGroups = await client.groups.loadAll();

// 4. Unload a group from memory (keeps the DB record intact).
await client.groups.unload(group.id);

// 5. Destroy a group entirely (removes from memory AND local storage).
await client.groups.destroy(group.id);

// 6. Leave a group: publishes a self-remove proposal and, once at least one
//    relay acknowledges it, purges local state.
await client.groups.leave(group.id);
```

You can react to store-level changes with the `watch()` async generator:

```typescript
for await (const groups of client.groups.watch()) {
  console.log(`Groups updated: ${groups.length} loaded`);
}
```

### Joining a Group (From a Welcome Message)

When an admin invites you, they wrap a `Welcome` message inside a NIP-59 Gift Wrap. Once you have unwrapped the Gift Wrap and retrieved the inner kind `444` rumor (see `client.invites` below), pass it to the client.

The client iterates every local key package with a matching ciphersuite, prioritises the ones whose `keyPackageRef` matches a `welcome.secrets[*].newMember` entry (per RFC 9420), and tries `joinGroup` with each until one succeeds.

```typescript
const { group } = await client.joinGroupFromWelcome({
  welcomeRumor: myKind444Rumor,
});
```

On success, the consumed key package is marked `used: true` so you can rotate it later. Callers **should** call `group.selfUpdate()` shortly after joining to rotate their own leaf key material for forward secrecy (MIP-02 SHOULD).

### Inspecting an invite before joining

If you want to show the user group metadata (name, description, relays, admins) before committing to a join, use:

```typescript
const groupInfo = await client.readInviteGroupInfo(myKind444Rumor);
if (groupInfo) {
  // groupInfo.groupContext.extensions contains the Marmot Group Data extension —
  // decode with getMarmotGroupData(groupInfo) for readable fields.
}
```

## Managing Invites

`client.invites` (an `InviteManager`) turns raw gift wrap events into unread kind 444 rumors ready for `joinGroupFromWelcome`. A typical flow:

```typescript
// 1. Feed kind 1059 events from your relay sync into the manager.
await client.invites.ingestEvents(giftWrapEvents);

// 2. Decrypt all received gift wraps. This prompts the signer for each,
//    so trigger it from a deliberate user action.
const newlyDecrypted = await client.invites.decryptGiftWraps();

// 3. Consume unread invites.
for (const invite of await client.invites.getUnread()) {
  const preview = await client.readInviteGroupInfo(invite);
  // ...present to the user, let them accept...
  const { group } = await client.joinGroupFromWelcome({ welcomeRumor: invite });
  await client.invites.markAsRead(invite.id);
}

// Or subscribe reactively:
for await (const invites of client.invites.watchUnread()) {
  console.log(`${invites.length} unread invite(s)`);
}
```

---

Next, read about how group states are persisted in [Bytes-First Storage](bytes-first-storage.md).
