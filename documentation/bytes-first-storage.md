# Bytes-First Storage & State Hydration

MLS Group State is complex. It contains cryptographic trees, epoch metadata, and pending proposals. Because `marmot-ts` supports diverse environments (Web browsers via IndexedDB, Node.js via file system, React Native via SQLite), it utilizes a "Bytes-First Storage" design for its persistence layer.

## What is Bytes-First Storage?

Instead of forcing your database to understand complex `ts-mls` JavaScript objects and circular references, `marmot-ts` serializes everything down to simple `Uint8Array` byte arrays before handing it off to the storage backend.

This design ensures:

1. **Storage layer neutrality:** The backend has no dependency on `ts-mls` `ClientConfig` policies or complex class structures.
2. **Portability:** Moving a group state from a web browser to a mobile app is just moving raw bytes.
3. **Security:** Raw bytes are easier to encrypt at rest if your application requires it.

## The `GroupStateStoreBackend` Interface

To persist MLS groups, you must provide an object implementing this interface to the `MarmotClient`:

```typescript
export interface GroupStateStoreBackend {
  /** Get state bytes from the store by group ID */
  get(groupId: Uint8Array): Promise<Uint8Array | null>;
  /** Set state bytes in the store by group ID */
  set(groupId: Uint8Array, stateBytes: Uint8Array): Promise<void>;
  /** Remove state bytes from the store by group ID */
  remove(groupId: Uint8Array): Promise<void>;
  /** List all group IDs in the store */
  list(): Promise<Uint8Array[]>;
}
```

### Provided Adapters

If you are using a key-value store (like `localStorage` or `localforage`), `marmot-ts` provides the `KeyValueGroupStateBackend` adapter. This adapter automatically handles converting the `Uint8Array` Group IDs to hex strings so they can be used as keys in a standard key-value map.

```typescript
import { KeyValueGroupStateBackend } from "@internet-privacy/marmots";

// Example mapping to a generic key-value store interface
const myBackend = new KeyValueGroupStateBackend({
  getItem: async (key: string) => {
    /* fetch bytes */
  },
  setItem: async (key: string, value: Uint8Array) => {
    /* save bytes */
  },
  removeItem: async (key: string) => {
    /* delete bytes */
  },
  keys: async () => {
    /* return string array of keys */
  },
});
```

## State Hydration (Deserialization)

When you call `client.getGroup(id)`, the library goes through a specific hydration lifecycle:

1. **Fetch:** `MarmotClient` asks your `GroupStateStoreBackend` for the raw `Uint8Array` bytes.
2. **Deserialize:** The bytes are run through `ts-mls` serialization routines (`deserializeClientState`).
3. **Rehydration Context:** The raw objects are injected with the active `client.capabilities`, `cryptoProvider`, and `authService` (which aren't stored in the bytes).
4. **Instantiation:** The hydrated state creates the `MarmotGroup` instance.

Because hydration requires knowing the active capabilities of the `MarmotClient`, the `GroupStateStoreBackend` only handles the bytes. It **never** instantiates the `ts-mls` objects itself.

---

Next, explore how hydrated groups actually process messages in the [Ingest Methods](ingest-methods.md) documentation.
