# Bytes-First Storage & State Hydration

MLS Group State is complex. It contains cryptographic trees, epoch metadata, and pending proposals. Because `marmot-ts` supports diverse environments (Web browsers via IndexedDB, Node.js via file system, React Native via SQLite), it uses a "Bytes-First Storage" design for its persistence layer.

## What is Bytes-First Storage?

Instead of forcing your database to understand complex `ts-mls` JavaScript objects and circular references, `marmot-ts` serializes group state down to a simple `Uint8Array` (via TLS encoding) before handing it off to the storage backend.

This design ensures:

1. **Storage layer neutrality:** the backend has no dependency on `ts-mls` `ClientConfig` policies or class structures.
2. **Portability:** moving a group state from a web browser to a mobile app is just moving raw bytes.
3. **Security:** raw bytes are easy to wrap in at-rest encryption (see `EncryptedKeyValueStore` in `@internet-privacy/marmot-ts` for a NIP-44–based adapter).

## The `GenericKeyValueStore<T>` Interface

`MarmotClient` accepts two storage backends, both implementing the same generic interface:

- `groupStateStore: GenericKeyValueStore<SerializedClientState>` (where `SerializedClientState = Uint8Array`)
- `keyPackageStore: GenericKeyValueStore<StoredKeyPackage>` (plus an optional `inviteStore` of the same shape)

```typescript
export interface GenericKeyValueStore<T> {
  /** Get an item from the store. Return null if the key is absent. */
  getItem(key: string): Promise<T | null>;
  /** Set an item in the store. Must return the value stored. */
  setItem(key: string, value: T): Promise<T>;
  /** Remove an item from the store. */
  removeItem(key: string): Promise<void>;
  /** Clear all items from the store. */
  clear(): Promise<void>;
  /** Get all keys currently in the store. */
  keys(): Promise<string[]>;
}
```

Any object that satisfies this shape will work — a LocalForage instance already does, which is why the examples can pass `localforage.createInstance({...})` straight into `MarmotClient`.

### Provided Adapters

- **`InMemoryKeyValueStore<T>`** (from `@internet-privacy/marmot-ts`) — a simple `Map`-backed implementation useful for tests or short-lived sessions. Used as the default `inviteStore` when none is provided.
- **`EncryptedKeyValueStore<T>`** (from `@internet-privacy/marmot-ts`) — wraps another `GenericKeyValueStore<Uint8Array>` and transparently encrypts every value using NIP-44 with a key derived from your signer.

```typescript
import {
  InMemoryKeyValueStore,
  EncryptedKeyValueStore,
} from "@internet-privacy/marmot-ts";

// Ephemeral, in-memory group state — great for tests.
const groupStateStore = new InMemoryKeyValueStore<Uint8Array>();
```

### Group IDs as storage keys

`GroupsManager` keys the backend by the **hex-encoded group id** (the MLS private `groupContext.groupId`, not the public `nostrGroupId`). You can round-trip with `bytesToHex` / `hexToBytes` from `@noble/hashes/utils`, but most callers never need to touch the key directly — the manager handles it.

## State Hydration (Deserialization)

When you call `client.groups.get(id)`, the library goes through a specific hydration lifecycle:

1. **Fetch:** `GroupsManager` asks your `groupStateStore` for the `Uint8Array` bytes at `bytesToHex(groupId)`.
2. **Deserialize:** the bytes are decoded through `ts-mls` TLS decoders via `deserializeClientState()`.
3. **Rehydration Context:** the deserialized `ClientState` is combined with the active `CryptoProvider` (the ciphersuite implementation is fetched based on `state.groupContext.cipherSuite`), the `EventSigner`, the `NostrNetworkInterface`, and any configured `historyFactory`/`mediaFactory`.
4. **Instantiation:** `MarmotGroup.fromClientState()` returns a fully wired instance ready for `ingest()` / `sendApplicationRumor()`.

Because hydration depends on the active `CryptoProvider` and auth service, the `GenericKeyValueStore` only handles opaque bytes. It **never** instantiates `ts-mls` objects itself.

## When is the store written?

`MarmotGroup` is the single writer into `groupStateStore`:

- `group.save(force?)` writes serialized state bytes. `GroupsManager` calls it during `create`, `adoptClientState` (used by `import` and `joinGroupFromWelcome`), and after relevant lifecycle events.
- Every successful commit / proposal / application message performed through the group marks it `dirty` and persists on its next `save()`.
- `group.destroy()` removes the state bytes from the store and emits `destroyed`.

---

Next, explore how hydrated groups actually process messages in the [Ingest Methods](ingest-methods.md) documentation.
