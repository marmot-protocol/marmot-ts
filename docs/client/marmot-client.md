# Marmot Client

`MarmotClient` is the orchestration layer for your Marmot application. It manages the lifecycle of multiple encrypted groups, coordinates between your Nostr network and local storage, and provides reactive APIs for building real-time user interfaces.

## Role in Your Application

Think of `MarmotClient` as the central hub that:

- **Creates and joins groups** - Handles the cryptographic ceremony required to establish new groups or join existing ones
- **Manages group lifecycle** - Exposes `client.groups` for loading groups from storage on demand, caching them in memory, and cleanup
- **Coordinates I/O** - Bridges between the [network interface](/client/network) (Nostr relays) and [storage backends](/client/storage) (IndexedDB, filesystem, etc.)
- **Exposes managers** - Provides `client.groups`, `client.keyPackages`, and `client.invites` for reactive streams and lifecycle events

Once you have a client instance, you'll use it to get [`MarmotGroup`](/client/marmot-group) instances that handle the actual messaging, member management, and cryptographic operations.

## Initialization

Setting up a client requires providing the infrastructure adapters:

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

// KeyPackage slot id: 32 random bytes as lowercase hex, generated once per
// install, persisted, and reused on every start. `loadSetting`/`saveSetting`
// stand in for your app's own settings storage.
let clientId = await loadSetting("keyPackageSlot");
if (!clientId) {
  clientId = bytesToHex(randomBytes(32));
  await saveSetting("keyPackageSlot", clientId);
}

const client = new MarmotClient({
  signer: yourNostrSigner,
  network: yourNostrNetworkInterface,
  groupStateStore: yourGroupStateStore,
  keyPackageStore: yourKeyPackageStore,
  clientId,
});
```

**Required dependencies:**

- **`signer`** - Signs Nostr events; an `EventSigner` from `applesauce-core` (compatible with NIP-07, `applesauce-signers`, etc.). Also signs the `0x8009` account identity proof carried on every key package's LeafNode.
- **`network`** - Publishes/fetches events from Nostr relays (see [Network Interface](/client/network))
- **`groupStateStore`** - Persists serialized MLS group state, `GenericKeyValueStore<SerializedClientState>` (see [Storage](/client/storage))
- **`keyPackageStore`** - Stores key package private material and publish tracking, `GenericKeyValueStore<StoredKeyPackage>` (see [Storage](/client/storage))

**Optional dependencies:**

- **`inviteStore`** - `GenericKeyValueStore<StoredInviteEntry>` backing `client.invites`; defaults to an in-memory store.
- **`ingestStateStore`**, **`rewindStore`**, **`removedMarkerStore`**, **`lifecycleStore`** - durable backends for ingest replay evidence, the fork-history tree, removal markers, and disband/lifecycle records. Most are in-memory when omitted; see [Storage](/client/storage#all-stores) for what each one holds and why production clients should provide them.
- **`historyFactory`** - Per-group message history backend factory (see [History](/client/history)).
- **`capabilities`** - MLS `Capabilities` advertised on key packages; defaults to `defaultCapabilities()`.
- **`cryptoProvider`** - Override the MLS crypto provider.
- **`clientId`** - Default `d`-tag slot for published kind 30443 key packages. `create()` throws `MissingSlotIdentifierError` if neither `clientId` nor an explicit `identifier` is set.

::: warning Spec deviation
The spec requires the KeyPackage `d` slot to be 32 random bytes encoded as lowercase hex, generated once and persisted, and never derived from a device label or identity material ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)). marmot-ts accepts any string and publishes it unchanged, so generate the value as shown above. Do not use a device name.
:::

::: tip Complete Setup Guide
For a complete walkthrough of setting up storage and network interfaces, see the [Getting Started](/getting-started) guide.
:::

## Group Lifecycle

### Creating a New Group

When you create a group, the client:

1. Generates the initial MLS group state with your user as the only member
2. Saves the group state to your storage backend — no group event (kind 445) is published, because epoch 0 carries an empty publication obligation: there are no existing peers to notify yet
3. Returns a `MarmotGroup` instance you can immediately use

```typescript
const group = await client.groups.create("Team Chat", {
  relays: ["wss://relay.example.com"],
  description: "Private team discussions",
  adminPubkeys: [myPubkey], // Who can manage the group
});
```

Learn more: [Groups in Core Module](/core/groups)

### Founding creation with initial invitees

Passing `invitees` — an array of published KeyPackage events (kind 30443) — turns `create()` into a **founding creation**: one Add commit carrying every invitee is merged **locally** to epoch 1, so all invitees are members immediately. Like the solo case above, this founding commit publishes **no** group event; the empty publication obligation extends to it too, because no pre-existing peer needs to see it. The client then attempts to send each invitee an independently retryable Welcome.

```typescript
const group = await client.groups.create("Team Chat", {
  relays: ["wss://relay.example.com"],
  adminPubkeys: [myPubkey],
  invitees: [aliceKeyPackageEvent, bobKeyPackageEvent],
});
// `group` is already Stable at epoch 1 with alice and bob as members.
```

Two consequences of this design are worth understanding before you rely on it:

- **`create()` throws when `invitees` is supplied without valid `relays`.** Every Welcome rumor must carry a non-empty list of the group's relays (so the joiner knows where to find future group traffic), and a group created without relays has no Nostr routing component and could never publish — so `create()` refuses a founding create whose `relays` option is absent, empty, or contains an invalid (non-ws/wss) URL. This check runs before any key material is generated or any state is written, so nothing is created, persisted, or published, and no invitee KeyPackage is consumed. A solo `create()` (no `invitees`, or an empty array) may still omit `relays`.
- **The delivery outcome is discoverable state, not a return value.** `create()` never throws because a Welcome failed to reach an invitee — the group exists at epoch 1 with every member regardless of delivery success. You must check the report yourself; see [`MarmotGroup`'s Welcome delivery section](/client/marmot-group#founding-welcome-delivery-and-retry) for the API and the recovery path (re-inviting with a fresh KeyPackage).

### Joining an Existing Group

When someone invites you to a group, they send you a [Welcome message](/core/welcome) (encrypted via NIP-59 gift wrap). After decrypting it, use the client to initialize your group state:

```typescript
const { group } = await client.joinGroupFromWelcome({
  welcomeRumor,
});
```

The client handles deserializing the Welcome, initializing your MLS state, and persisting it to storage. Before accepting, show the user who sent the invite (the Welcome rumor's `pubkey`) and, if useful, the group details from `client.previewWelcome(invite)`.

After joining, the library leaves two follow-ups to you:

```typescript
// 1. Catch up on the group's outstanding commits, then rotate your leaf key.
await client.groups.connect(group.id);
await group.selfUpdate();

// 2. Rotate the KeyPackage the Welcome consumed (same `d` slot; the old private
//    material is removed).
for (const pkg of await client.keyPackages.list()) {
  if (pkg.used) await client.keyPackages.rotate(pkg.keyPackageRef);
}
```

The spec says a new member SHOULD self-update promptly after joining, before sending application messages when feasible, with a recommended window of 24 hours ([`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md)). marmot-ts does not do this automatically.

::: warning Spec deviation
[`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md) requires deleting consumed KeyPackage private material. `joinGroupFromWelcome` only marks the KeyPackage `used`. Call `client.keyPackages.rotate(ref)` or `client.keyPackages.remove(ref)` to delete it.
:::

### Loading Groups

Groups are loaded into an in-memory cache on demand. This is useful for displaying a list of recent groups or resuming a conversation:

```typescript
// Load a specific group by ID
const group = await client.groups.get(groupId);

// Load all groups from storage
const allGroups = await client.groups.loadAll();
```

Once loaded, the `MarmotGroup` instance remains in the client's cache until it is unloaded (`client.groups.unload`) or destroyed (`client.groups.destroy`).

### Unloading and Cleanup

To free up memory when a group is no longer actively used:

```typescript
await client.groups.unload(groupId);
```

This removes the group from the in-memory cache, disposes its timers and queued outbound work, and preserves all data in storage.

To permanently delete a group and all its history:

```typescript
await client.groups.destroy(groupId);
```

## Receiving group traffic

The client does not subscribe to relays until you ask it to. `client.groups.connect()` and `client.groups.connectAll()` run the receive loop for you. They fetch a group's kind 445 backlog from its relays, open a live subscription, and pass every event through `group.ingest()`. Before ingesting, they check each event's signature and its `h` routing tag, drop duplicates by event id, and drain each batch fully.

```typescript
// Keep every loaded, created, joined, or imported group connected.
// Groups that are unloaded, destroyed, left, removed, or disbanded are
// disconnected automatically.
const connection = client.groups.connectAll();

// Or connect a single group. `fallbackRelays` is used only when the group
// has no relays of its own.
const single = await client.groups.connect(groupId, {
  fallbackRelays: ["wss://relay.example.com"],
});

// Later: disconnect
connection.unsubscribe();
single.unsubscribe();
```

Decrypted messages then arrive through the group's [`applicationMessage` event](/client/marmot-group#receiving-messages) and its [history](/client/history). Events that fail the signature or `h`-tag check are reported through the `rejected` event, and events that cannot be read through `unreadable`:

```typescript
client.groups.on("rejected", (groupId, event, reason) => {
  console.warn("rejected kind 445", event.id, reason);
});
client.groups.on("unreadable", (groupId, event) => {
  console.warn("unreadable kind 445", event.id);
});
```

`connect()` skips a group that has no relays and no `fallbackRelays`, a group without Nostr routing, and a group that is removed or disbanded.

### Bounded backfill

The backlog fetch is paged and bounded. Each relay is read newest-first in pages of `backfillPageSize` events (default 500), walking `until` backwards, so a relay's result cap cannot silently drop older events. After a relay's backfill has been fully fetched and ingested, the client records a cursor for that relay and group: the `created_at` of the newest ingested event it returned. The next `connect()` fetches that relay only from `cursor - backfillSlackSeconds` (default 600 seconds). The live subscription starts `backfillSlackSeconds` before the backfill began. A relay without a cursor (the first connect, or a relay added later) is paged through its full history.

Cursors are stored in `ingestStateStore`. Pass a durable `ingestStateStore` to `MarmotClient` to keep backfill bounded across restarts; without one, cursors last only for the current process. A relay's cursor is not advanced when it hits `backfillMaxPages` (default 50 per relay), when a single second may hold more events than one response returned (timestamp paging cannot enumerate it), when the request fails or the relay answers outside the requested `since`/`until` window, when ingest fails, from events dated more than five minutes in the future, or past an event the group is still holding in memory: for a later retry (see `group.pendingEvents()`), or while its own commit is being published. Such a relay re-reads the same window on the next connect; the other relays still advance.

Events are checked for a valid signature and this group's `h` tag before copies with the same id are merged, so a forged copy cannot displace the genuine event. Each relay contributes at most `backfillPageSize * backfillMaxPages` events per connect; when a relay returns more than `backfillPageSize` events for one page, only the newest `backfillPageSize` are kept and the rest are read by later pages.

When a relay hits `backfillMaxPages`, the client also records how far that relay was read (one small record per group relay in `ingestStateStore`). The next `connect()` re-reads the newest events down to that range, then jumps below it and continues, so a history longer than the page cap is completed over successive connects. The record is removed once that relay's backfill completes.

Limits:

- The cursor follows `created_at`, which the publisher chooses. An event that reaches a relay more than `backfillSlackSeconds` after the date it carries can be missed by both the backfill and the live subscription.
- Events held in memory hold the cursor back, so a restart re-fetches them. Events in the ingestion pool (`group.pendingEvents()`) hold it back by at most seven days before the newest fetched event: an undecryptable event dated far in the past cannot force a long re-fetch on every connect, and one dated more than seven days before newer traffic is not re-fetched after a restart. Input set aside while the group's own commit is being published is not limited this way, since it is processed once the publication settles.
- Memory: a backfill holds every event it collects until it has been ingested, up to `backfillPageSize * backfillMaxPages` per relay (500 × 50 = 25,000 with the defaults), for each relay of the group. Mobile and other memory-constrained consumers should pass smaller `backfillPageSize` / `backfillMaxPages`; a longer history is then completed over successive connects.
- A single-second page counts as possibly truncated when it holds at least `backfillPageSize` events, or at least 100 events and the relay has not returned a longer response during the same walk. Relays do not report their result cap, so one that caps responses below 100 events can still hide events that share a second.
- A relay that fails on every connect is re-read from its old cursor (or in full) each time, bounded by `backfillMaxPages`.
- The `request` adapter must reject when a relay fails or times out (see [network](/client/network)). An adapter that resolves `[]` instead makes the relay look empty, and a relay that stops part-way through its history may then be recorded as complete.

```typescript
const connection = client.groups.connectAll({
  backfillSlackSeconds: 300,
  backfillPageSize: 200,
  backfillMaxPages: 100,
});
```

## Reactive State

The client managers provide two ways to react to state changes: **async generators** for continuous streaming updates and **events** for one-off lifecycle hooks.

### Async Generators

`client.groups.watch()` and `client.keyPackages.watchKeyPackages()` return **async generators** that yield new values whenever state changes:

```typescript
for await (const groups of client.groups.watch()) {
  updateGroupListUI(groups);
}
```

**How it works:**

- The loop continuously yields the current group list
- Emits whenever groups are created, joined, loaded, or destroyed
- Runs until you exit the loop

**Key package monitoring:**

```typescript
for await (const packages of client.keyPackages.watchKeyPackages()) {
  updateKeyPackageUI(packages); // includes used and non-current entries
}
```

::: tip Framework Integration
Async generators need to be converted to your UI framework's native reactivity system (React hooks, Svelte stores, etc.). See the [UI Framework Integration](/client/ui-frameworks) guide for patterns in React, Svelte, and vanilla JavaScript.
:::

### Canceling Async Generators

When your component unmounts or you want to stop watching, you need to break out of the loop:

```typescript
const abortController = new AbortController();

(async () => {
  for await (const groups of client.groups.watch()) {
    if (abortController.signal.aborted) break;
    updateUI(groups);
  }
})();

// Later: stop watching
abortController.abort();
```

The loop only checks the signal when the next value arrives, so the generator and its listener stay alive until the next `updated` event. For UI integrations, see [UI Framework Integration](/client/ui-frameworks).

### Events for Lifecycle Hooks

For more granular control, listen to specific lifecycle events on `client.groups`:

```typescript
client.groups.on("created", (group) => {
  // Navigate to new group
});

client.groups.on("joined", (group) => {
  // Show welcome notification
});

client.groups.on("destroyed", (groupId) => {
  // Remove from UI
});
```

**Available group events:** `updated`, `loaded`, `created`, `imported`, `joined`, `unloaded`, `destroyed`, `left`, `removed` (an inbound commit removed you; the local state is kept as a tombstone), `disbanded` (a terminal disband was recorded), and, from `connect()` / `connectAll()` subscriptions, `unreadable` (an event could not be read) and `rejected` (a kind 445 event failed signature or `h`-tag validation).

## Working with Groups

After obtaining a `MarmotGroup` instance from the client, you'll use it for all group-level operations like sending messages, inviting members, and processing incoming events.

See the [`MarmotGroup` documentation](/client/marmot-group) for details on:

- Sending encrypted messages
- Creating proposals (add/remove members, update metadata)
- Committing changes to advance the group state
- Ingesting and decrypting events from relays

## Key Package Management

Before others can invite you to groups, you need to publish [key packages](/core/key-packages) to Nostr relays. Publish them to the write relays in your kind 10002 NIP-65 relay list (`r` tags marked `write` or unmarked); inviters fetch them from there.

```typescript
import { getNip65Relays } from "@internet-privacy/marmot-ts";

// On startup: make sure one current, unused KeyPackage is published in this
// device's `clientId` slot. A no-op if one already exists.
const myNip65WriteRelays = getNip65Relays(myRelayListEvent, "write");
await client.keyPackages.ensurePublished({ relays: myNip65WriteRelays });
```

::: tip Key Package Lifecycle
KeyPackages are created as last-resort by default, so the single package in your device's slot can accept several invites. Kind 30443 is addressable, so repeated `create()` calls in the same `d` slot replace each other on relays and only one stays discoverable. Rotate the package after it has been used (see [Joining an Existing Group](#joining-an-existing-group)). To publish more than one KeyPackage at a time, create extra slots with distinct random `identifier` values.
:::

::: warning Spec deviation
marmot-ts marks last-resort KeyPackages with the legacy MLS extension `0x000a` (and advertises it in capabilities). The spec uses app_data_dictionary component `0x0004` instead ([`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md), [`foundation/registries.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/registries.md)).
:::

## Multi-Account Support

If your application supports multiple user accounts, each account **must have completely isolated storage**. This is critical for security—mixing storage between accounts would leak private key material.

### Per-Account Storage Pattern

Create separate storage instances namespaced by the user's public key:

`createAppKeyValueStore` below stands in for your app's own store factory (for example `localforage.createInstance`); it is not a library export.

```typescript
function getStorageForAccount(pubkey: string) {
  return createAppKeyValueStore({
    name: `marmot-${pubkey}`,
    storeName: "groups",
  });
}

function getKeyPackageStoreForAccount(pubkey: string) {
  return createAppKeyValueStore({
    name: `marmot-${pubkey}`,
    storeName: "keyPackages",
  });
}
```

Apply the same per-account namespacing to every other store you pass: `inviteStore`, `ingestStateStore`, `rewindStore`, `removedMarkerStore`, and `lifecycleStore`.

### Account Switching

When a user switches accounts, create a new client instance with the new account's storage:

```typescript
async function switchToAccount(newAccount: Account) {
  const newClient = new MarmotClient({
    signer: newAccount.signer,
    network: sharedNetworkInterface, // Can be reused across accounts
    groupStateStore: getStorageForAccount(newAccount.pubkey),
    keyPackageStore: getKeyPackageStoreForAccount(newAccount.pubkey),
    // App helper: per-account version of the persisted random-hex slot shown in Initialization
    clientId: await getKeyPackageSlotForAccount(newAccount.pubkey),
  });

  return newClient;
}
```

**Important:**

- Your UI framework integration should clean up subscriptions from the old client
- The network interface can be shared across accounts
- Storage backends must be completely isolated per account

See [UI Framework Integration](/client/ui-frameworks#multi-account-considerations) for framework-specific account switching patterns.

## Architecture Context

`MarmotClient` sits in the [Client Module](/guide/architecture#client-module) layer, above the [Core Module](/core/) protocol implementation and below your application logic. It handles all the I/O and lifecycle complexity so you can focus on building features.

```
┌─────────────────────────────────┐
│    Your Application Logic       │
└─────────────────────────────────┘
              ↓
┌─────────────────────────────────┐
│  MarmotClient (orchestration)   │
│  MarmotGroup (operations)       │  ← You are here
└─────────────────────────────────┘
              ↓
┌─────────────────────────────────┐
│  Core Module (protocol layer)   │
└─────────────────────────────────┘
```

## Next Steps

- **[UI Framework Integration](/client/ui-frameworks)** - Convert async generators to React hooks, Svelte stores, or vanilla JavaScript
- **[MarmotGroup](/client/marmot-group)** - Learn about group-level operations (messaging, members, commits)
- **[Storage](/client/storage)** - Implement persistent storage for your target platform
- **[Network Interface](/client/network)** - Connect to Nostr relays with your preferred library
- **[Best Practices](/client/best-practices)** - Production deployment patterns and security considerations
