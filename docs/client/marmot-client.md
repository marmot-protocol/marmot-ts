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

const client = new MarmotClient({
  signer: yourNostrSigner,
  network: yourNostrNetworkInterface,
  groupStateStore: yourGroupStateStore,
  keyPackageStore: yourKeyPackageStore,
  clientId: "my-app-desktop",
});
```

**Required dependencies:**

- **`signer`** - Signs Nostr events; an `EventSigner` from `applesauce-core` (compatible with NIP-07, `applesauce-signers`, etc.)
- **`network`** - Publishes/fetches events from Nostr relays (see [Network Interface](/client/network))
- **`groupStateStore`** - Persists serialized MLS group state, `GenericKeyValueStore<SerializedClientState>` (see [Storage](/client/storage))
- **`keyPackageStore`** - Stores key package private material and publish tracking, `GenericKeyValueStore<StoredKeyPackage>` (see [Storage](/client/storage))

**Optional dependencies:**

- **`accountProofSigner`** - Signs the `marmot.account-identity-proof.v1` LeafNode extension. Requires raw BIP-340 access (the applesauce `EventSigner` cannot provide it), and is required for full wire interop with darkmatter, which validates the proof on every leaf.
- **`inviteStore`** - `GenericKeyValueStore<StoredInviteEntry>` backing `client.invites`; defaults to an in-memory store.
- **`historyFactory`** - Per-group message history backend factory (see [History](/client/history)).
- **`capabilities`** - MLS `Capabilities` advertised on key packages; defaults to `defaultCapabilities()`.
- **`cryptoProvider`** - Override the MLS crypto provider.
- **`clientId`** - Default `d`-tag slot for published kind 30443 key packages.

::: tip Complete Setup Guide
For a complete walkthrough of setting up storage and network interfaces, see the [Getting Started](/getting-started) guide.
:::

## Group Lifecycle

### Creating a New Group

When you create a group, the client:

1. Generates the initial MLS group state with your user as the only member
2. Publishes a group event (kind 445) to your specified relays
3. Saves the group state to your storage backend
4. Returns a `MarmotGroup` instance you can immediately use

```typescript
const group = await client.groups.create("Team Chat", {
  relays: ["wss://relay.example.com"],
  description: "Private team discussions",
  adminPubkeys: [myPubkey], // Who can manage the group
});
```

Learn more: [Groups in Core Module](/core/groups)

### Joining an Existing Group

When someone invites you to a group, they send you a [Welcome message](/core/welcome) (encrypted via NIP-59 gift wrap). After decrypting it, use the client to initialize your group state:

```typescript
const { group } = await client.joinGroupFromWelcome({
  welcomeRumor,
});
```

The client handles deserializing the Welcome, initializing your MLS state, and persisting it to storage.

### Loading Groups

Groups are loaded into an in-memory cache on demand. This is useful for displaying a list of recent groups or resuming a conversation:

```typescript
// Load a specific group by ID
const group = await client.groups.get(groupId);

// Load all groups from storage
const allGroups = await client.groups.loadAll();
```

Once loaded, the `MarmotGroup` instance remains in the client's cache until explicitly unloaded or the client is destroyed.

### Unloading and Cleanup

To free up memory when a group is no longer actively used:

```typescript
await client.groups.unload(groupId);
```

This removes the group from the in-memory cache but preserves all data in storage.

To permanently delete a group and all its history:

```typescript
await client.groups.destroy(groupId);
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
- Runs until explicitly canceled or the client is destroyed

**Key package monitoring:**

```typescript
for await (const packages of client.keyPackages.watchKeyPackages()) {
  if (packages.length < 5) {
    await generateMoreKeyPackages();
  }
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

**Available group events:** `updated`, `loaded`, `created`, `imported`, `joined`, `unloaded`, `destroyed`, `left`

## Working with Groups

After obtaining a `MarmotGroup` instance from the client, you'll use it for all group-level operations like sending messages, inviting members, and processing incoming events.

See the [`MarmotGroup` documentation](/client/marmot-group) for details on:

- Sending encrypted messages
- Creating proposals (add/remove members, update metadata)
- Committing changes to advance the group state
- Ingesting and decrypting events from relays

## Key Package Management

Before others can invite you to groups, you need to publish [key packages](/core/key-packages) to Nostr relays. The client helps manage these:

```typescript
// Watch your key package inventory
for await (const packages of client.keyPackages.watchKeyPackages()) {
  if (packages.length === 0) {
    // Generate and publish more key packages
  }
}
```

::: tip Key Package Lifecycle
Key packages are one-time-use cryptographic material (unless marked as "last resort"). Monitor your key package store and replenish them periodically so others can always add you to groups.
:::

## Multi-Account Support

If your application supports multiple user accounts, each account **must have completely isolated storage**. This is critical for security—mixing storage between accounts would leak private key material.

### Per-Account Storage Pattern

Create separate storage instances namespaced by the user's public key:

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

### Account Switching

When a user switches accounts, create a new client instance with the new account's storage:

```typescript
async function switchToAccount(newAccount: Account) {
  const newClient = new MarmotClient({
    signer: newAccount.signer,
    network: sharedNetworkInterface, // Can be reused across accounts
    groupStateStore: getStorageForAccount(newAccount.pubkey),
    keyPackageStore: getKeyPackageStoreForAccount(newAccount.pubkey),
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
