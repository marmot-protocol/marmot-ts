# Storage

`MarmotClient` keeps everything it must remember in key/value stores that you supply. All of them share one small interface, so any backend works: in-memory for tests, IndexedDB or LocalForage in the browser, SQLite or files on a server.

## The store interface

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";

interface GenericKeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}
```

## The stores `MarmotClient` uses

| Option               | Holds                                                                                   | If left in memory / omitted                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `groupStateStore`    | Serialized MLS state, one entry per group                                               | Required. Losing it loses every group.                                                                                                      |
| `keyPackageStore`    | Your key packages, **including private keys**                                           | Required. Losing it means Welcomes sent to your published key packages can no longer be joined.                                             |
| `inviteStore`        | Received gift wraps, decrypted invites, read/seen state                                 | Defaults to in-memory. Unread invites and read state are lost on restart.                                                                   |
| `ingestStateStore`   | Replay protection, convergence evidence and per-relay backfill cursors                  | Defaults to in-memory. Replays aren't detected across restarts, backfill starts over, and `client.ingestPersistence.kind` is `"ephemeral"`. |
| `rewindStore`        | The per-group [fork-history tree](/client/fork-history) and pending commit publications | Defaults to in-memory. Fork recovery after a restart starts again from the current state.                                                   |
| `removedMarkerStore` | Whether a removal from a group has already been handled                                 | Defaults to in-memory. The fact that you were removed from a group doesn't survive a restart.                                               |
| `lifecycleStore`     | Disband intent and terminal records                                                     | Defaults to scoped keys inside `groupStateStore`, so it is durable whenever that store is.                                                  |

Message history and media caches are separate per-group backends, configured with `historyFactory` (see [History](/client/history)) and `mediaFactory` (see [Media](/client/media)).

In production, give **every** store above a durable backend, and check `client.ingestPersistence.kind === "durable"` at startup. `StoredKeyPackage` contains private keys, so protect `keyPackageStore` the way you would protect a signing key.

::: warning One account per set of stores
Never share a store between accounts. See [Multi-account](/client/multi-account) for a per-account store factory.
:::

## Requirements for durable adapters

- Resolve `setItem` and `removeItem` only after the write is durable. Each write must replace the complete value atomically, and a read must see every completed write.
- Preserve `Uint8Array` values byte for byte. Plain `JSON.stringify` silently corrupts them. Use structured clone (IndexedDB), CBOR, or base64 for each field.
- Keep all stores of an account together: back them up, restore them and delete them as a set. Run only one `MarmotClient` at a time over a given set of stores.
- If several stores share one physical database, give each adapter its own namespace. Its `clear()` and `keys()` must only touch that namespace, and you should never implement cleanup as `clear()` on a shared backend.

## Use the in-memory store

For tests and short-lived scripts:

```typescript
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";
import {
  MarmotClient,
  type SerializedClientState,
} from "@internet-privacy/marmot-ts";
import type { StoredKeyPackage } from "@internet-privacy/marmot-ts/client";

const client = new MarmotClient({
  signer,
  network,
  groupStateStore: new InMemoryKeyValueStore<SerializedClientState>(),
  keyPackageStore: new InMemoryKeyValueStore<StoredKeyPackage>(),
});
```

## Use LocalForage in the browser

[LocalForage](https://github.com/localForage/localForage) instances already satisfy `GenericKeyValueStore` and store `Uint8Array` values through IndexedDB's structured clone:

```typescript
import localforage from "localforage";

const store = (storeName: string) =>
  localforage.createInstance({ name: "marmot", storeName });

const client = new MarmotClient({
  signer,
  network,
  clientId,
  groupStateStore: store("groups"),
  keyPackageStore: store("keyPackages"),
  inviteStore: store("invites"),
  ingestStateStore: store("ingest"),
  rewindStore: store("rewind"),
  removedMarkerStore: store("removed"),
  lifecycleStore: store("lifecycle"),
});
```

## Write a custom backend

Any object with the five methods works. Here is a sketch over a SQLite table, with one table per store so that `clear()` stays scoped:

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";

function sqliteStore<T>(db: Database, table: string): GenericKeyValueStore<T> {
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v BLOB)`);
  return {
    async getItem(key) {
      const row = db.get(`SELECT v FROM ${table} WHERE k = ?`, key);
      return row ? decode<T>(row.v) : null;
    },
    async setItem(key, value) {
      db.run(
        `INSERT OR REPLACE INTO ${table} VALUES (?, ?)`,
        key,
        encode(value),
      );
      return value;
    },
    async removeItem(key) {
      db.run(`DELETE FROM ${table} WHERE k = ?`, key);
    },
    async clear() {
      db.run(`DELETE FROM ${table}`);
    },
    async keys() {
      return db.all(`SELECT k FROM ${table}`).map((row) => row.k);
    },
  };
}
```

`Database`, `encode` and `decode` stand in for your driver and a binary-safe serializer such as CBOR.

## Encrypt a store (demo only)

`EncryptedKeyValueStore` from `./extra` wraps a `GenericKeyValueStore<Uint8Array>` with password-based encryption. It works for the byte-valued stores (`groupStateStore`, `ingestStateStore`, `rewindStore`, `lifecycleStore`):

```typescript
import { EncryptedKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new EncryptedKeyValueStore(rawStore, salt);
if (!(await groupStateStore.unlock(password)))
  throw new Error("Wrong password");
```

::: danger Not for production
`EncryptedKeyValueStore` only demonstrates the wrapping pattern. It is not a secure at-rest encryption scheme. For real deployments, use platform key storage (Keychain, Android Keystore, DPAPI, libsecret, or WebCrypto with a non-extractable key).
:::

## Next steps

- [Multi-account](/client/multi-account): isolated stores for each account
- [History](/client/history): persisting decrypted messages
- [Network](/client/network): the other adapter `MarmotClient` needs
