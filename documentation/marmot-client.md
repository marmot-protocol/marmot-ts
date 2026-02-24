# The `MarmotClient`

The `MarmotClient` acts as the root factory and supervisor for all MLS operations over Nostr. It manages local identity keys, network transport interfaces, and a registry of active groups.

## Initialization

You instantiate the client by passing an `options` object. The options include the dependencies required to link Nostr signatures and persistence together:

```typescript
import { MarmotClient } from "@internet-privacy/marmots";

const client = new MarmotClient({
  signer: myApplesauceSigner,
  groupStateBackend: myGroupDb,
  keyPackageStore: myKeyDb,
  network: myNostrNetwork,
  // Optional:
  capabilities: myMlsCapabilities,
  cryptoProvider: myCryptoProvider,
  historyFactory: myHistoryAdapter,
});
```

### Options Breakdown

- **`signer`:** A compliant `EventSigner` (e.g. from `applesauce-core`). This is the root Nostr identity (npub).
- **`groupStateBackend`:** Must conform to the `GroupStateStoreBackend` [interface](bytes-first-storage.md) handling raw byte storage for groups.
- **`keyPackageStore`:** An instance storing locally generated private keys required to decrypt Welcome messages.
- **`network`:** Must conform to `NostrNetworkInterface` (`request`, `publish`, etc.) linking the client to the Nostr relay network.
- **`capabilities`:** Controls TLS ciphersuites used by MLS (defaults typically handle `x25519`).
- **`cryptoProvider`:** Used for specific implementations of the MLS Crypto Layer.
- **`historyFactory`:** Optional abstraction allowing groups to persist decrypted `applicationMessage` data off-chain.

## Managing Key Packages

Before someone can invite you to a group, they must fetch your "Key Package" (Kind `443`). Key Packages are MLS structures that bind your Nostr identity to a temporary, single-use, or long-lived cryptographic identity for a specific group joining action.

### Creating Key Packages

While the `MarmotClient` provides a high-level `rotateKeyPackage` method, applications usually need precise control over the key package creation lifecycle (e.g., waiting for Nostr extension approvals, managing relay lists, or handling UI loading states).

The canonical way to generate Key Packages is using the library's core cryptographic exports: `generateKeyPackage` and `createKeyPackageEvent`.

```typescript
import {
  createCredential,
  generateKeyPackage,
  createKeyPackageEvent,
} from "@internet-privacy/marmots";
import { defaultCryptoProvider } from "ts-mls";

// 1. Get the requested ciphersuite implementation
const ciphersuiteImpl = await defaultCryptoProvider.getCiphersuiteImpl(
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
);

// 2. Create the base Nostr identity credential
const credential = createCredential(myPubkey);

// 3. Generate the MLS key material (both Public and Private halves)
const completeKeyPackage = await generateKeyPackage({
  credential,
  ciphersuiteImpl,
  // Optional: control whether this KeyPackage is marked reusable.
  // - true (default): include MLS `last_resort` extension
  // - false: omit it (single-use)
  isLastResort: true,
});

// 4. Create the unsigned NIP-01 EventTemplate (Kind 443)
const unsignedEvent = await createKeyPackageEvent({
  keyPackage: completeKeyPackage.publicPackage,
  relays: ["wss://relay.example.com"],
  client: "my-chat-app",
});

// 5. Explicitly sign the event using your Nostr client/signer
const signedEvent = await myNostrSigner.signEvent(unsignedEvent);

// 6. Broadcast to the network
await client.network.publish(["wss://relay.example.com"], signedEvent);

// 7. ONLY after successful broadcast, save the private material locally
// so the client can decrypt future Welcome messages
await client.keyPackageStore.add(completeKeyPackage);
```

### Subscribing to Key Packages

If you are writing a robust client, you'll want to ensure you always have valid Key Packages available locally. The client can poll its local `KeyPackageStore` to watch for this state.

```typescript
// Poll local key package state (this observes the KeyPackageStore db)
const iterator = client.watchKeyPackages();

for await (const localPackages of iterator) {
  if (localPackages.length === 0) {
    console.warn(
      "Out of local key packages. Please create a new one to receive invites.",
    );
    // Prompt your UI to generate a new key package using the method above
  }
}
```

## Managing Groups

The client acts as the central router for accessing encrypted `MarmotGroup` instances. Groups are loaded into a memory registry (`client.groups`).

### Creating & Loading

```typescript
// 1. Create a brand new group
const group = await client.createGroup("Engineering Team", {
  description: "Dev ops.",
  relays: ["wss://relay.a", "wss://relay.b"],
  // Optional: add additional admins (the creator is always included automatically)
  adminPubkeys: ["<other-admin-pubkey-hex>"],
  // Optional: override MLS ciphersuite
  ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
});

// 2. Load a previously saved group from the bytes-first backend
const loadedGroup = await client.getGroup(groupIdHash);

// 3. Unload a group from memory (saves RAM, keeps DB intact)
await client.unloadGroup(group.id);

// 4. Destroy a group (removes from memory AND local DB)
await client.destroyGroup(group.id);
```

### Joining a Group (From a Welcome Message)

When an admin invites you, they wrap a `Welcome` message inside a NIP-59 Gift Wrap. Assuming you've unwrapped the Gift Wrap and retrieved the inner Kind `444` rumor, you use the client to process it.

The client searches its `KeyPackageStore` for the private key corresponding to the Welcome message. If a match is found, it instantiates the group.

```typescript
// Join the group using the unwrapped rumor
const newGroup = await client.joinGroupFromWelcome({
  welcomeRumor: myGiftWrapRumor,
  // The Key Package Event ID is usually mapped in the gift wrap tags
  keyPackageEventId: eventId,
});
```

---

Next, read about how group states are persisted in [Bytes-First Storage](bytes-first-storage.md).
