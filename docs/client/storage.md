# Storage

`MarmotClient` keeps everything it must remember in **one** storage you supply: a small byte key/value interface. The library owns every key and record format, so a backend only has to store bytes: in-memory for tests, IndexedDB in the browser, SQLite or files on a server.

Decrypted messages are stored separately, in a per-group rumor database (see [History](/client/history)).

## The storage interface

```typescript
import type { MarmotStorage, StorageOp } from "@internet-privacy/marmot-ts";

interface MarmotStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`, sorted ascending. */
  list(prefix: string): Promise<string[]>;
  /** Apply every op atomically, in order. */
  batch(ops: readonly StorageOp[]): Promise<void>;
}

type StorageOp =
  | { type: "set"; key: string; value: Uint8Array }
  | { type: "delete"; key: string };
```

```typescript
const client = new MarmotClient({ signer, network, storage });
```

## What lives in storage

| Keys                  | Holds                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `group/<groupId>/...` | Each group's MLS state, its [fork-history tree](/client/fork-history), replay protection, convergence evidence, backfill cursors and lifecycle records |
| `keypackage/<ref>`    | Your key packages, **including private keys**                                                                                                          |
| `invite/...`          | Received gift wraps, decrypted invites and seen markers                                                                                                |

Destroying or leaving a group deletes everything under its `group/<groupId>/` prefix. Values contain MLS secrets and private keys: protect the storage the way you would protect a signing key.

## Client storage modules

The client storage code lives in `src/client/storage`. The package’s `/client` entry point exposes the shared adapter contract, adapter helpers, and group message history API. The internal modules divide responsibility as follows.

| Module                                                                  | Responsibility                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `group-registry.ts`                                                     | Loads persisted groups and tracks live instances.                    |
| `storage-keys.ts`, `record-codec.ts`                                    | Define client record keys and encode structured records as bytes.    |
| `key-package-store.ts`                                                  | Persists local key packages and their consumption receipts.          |
| `backfill-cursor.ts`, `wrapper-ledger.ts`, `delivered-payload-store.ts` | Persist backfill progress, replay markers, and delivery evidence.    |
| `pending-publication.ts`                                                | Persists pending commits so publication can resume after a restart.  |
| `group-history.ts`                                                      | Exposes decrypted message history backed by a per-group rumor store. |

## Requirements for durable adapters

- Resolve `set`, `delete` and `batch` only after the change is durable.
- `batch` must be **all-or-nothing**: after a crash, either every op is visible or none is. The library commits each group state change, its fork-history nodes and its replay-protection records in one batch, so a partial batch could replay or lose messages. IndexedDB transactions and SQLite transactions provide this directly.
- `list(prefix)` must return every key that starts with `prefix`, sorted.
- Store values byte for byte. There is no structured data to serialize: values are always `Uint8Array`.
- One storage holds one account. Run only one `MarmotClient` at a time over a given storage.

::: warning One account per storage
Never share a storage between accounts without a per-account key prefix. See [Multi-account](/client/multi-account).
:::

## Use the in-memory storage

For tests and short-lived scripts:

```typescript
import { MarmotClient, memoryStorage } from "@internet-privacy/marmot-ts";

const client = new MarmotClient({ signer, network, storage: memoryStorage() });
```

Everything is lost when the process exits.

## Use IndexedDB in the browser

One object store, string keys, `Uint8Array` values. A transaction makes `batch` atomic:

```typescript
import type { MarmotStorage } from "@internet-privacy/marmot-ts";

async function indexedDbStorage(name: string): Promise<MarmotStorage> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const run = <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T> | void,
  ) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const request = body(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(request?.result as T);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  return {
    get: (key) => run("readonly", (s) => s.get(key)),
    set: (key, value) => run("readwrite", (s) => void s.put(value, key)),
    delete: (key) => run("readwrite", (s) => void s.delete(key)),
    list: async (prefix) =>
      (
        await run<IDBValidKey[]>("readonly", (s) =>
          s.getAllKeys(IDBKeyRange.bound(prefix, prefix + "￿")),
        )
      ).map(String),
    batch: (ops) =>
      run("readwrite", (s) => {
        for (const op of ops)
          op.type === "set" ? s.put(op.value, op.key) : s.delete(op.key);
      }),
  };
}
```

## Use SQLite on a server

```typescript
import type { MarmotStorage } from "@internet-privacy/marmot-ts";

function sqliteStorage(db: Database): MarmotStorage {
  db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB)");
  const put = (key: string, value: Uint8Array) =>
    db.run("INSERT OR REPLACE INTO kv VALUES (?, ?)", key, value);
  const del = (key: string) => db.run("DELETE FROM kv WHERE k = ?", key);
  return {
    async get(key) {
      const row = db.get("SELECT v FROM kv WHERE k = ?", key);
      return row ? new Uint8Array(row.v) : undefined;
    },
    async set(key, value) {
      put(key, value);
    },
    async delete(key) {
      del(key);
    },
    async list(prefix) {
      return db
        .all(
          "SELECT k FROM kv WHERE k >= ? AND k < ? ORDER BY k",
          prefix,
          prefix + "￿",
        )
        .map((row) => row.k);
    },
    async batch(ops) {
      db.transaction(() => {
        for (const op of ops)
          op.type === "set" ? put(op.key, op.value) : del(op.key);
      })();
    },
  };
}
```

`Database` stands in for your driver (for example `better-sqlite3` or `bun:sqlite`).

## Encrypt storage at rest

`EncryptedStorage` from `./extra` wraps any `MarmotStorage` and encrypts every value with AES-256-GCM. Each value gets a random nonce and is bound to its key, so values can't be swapped between keys undetected. Keys stay in plaintext: they reveal group ids, key package refs and event ids, but no secrets.

```typescript
import { EncryptedStorage } from "@internet-privacy/marmot-ts/extra";

// From a 32-byte key held in platform key storage (recommended):
const storage = new EncryptedStorage(rawStorage, key);

// Or derived from a password (PBKDF2-SHA256; rejects a wrong password):
const storage = await EncryptedStorage.fromPassword(rawStorage, password);
```

Prefer a key from platform key storage (Keychain, Android Keystore, DPAPI, libsecret, or a non-extractable WebCrypto key) over a password.

## Next steps

- [History](/client/history): persisting decrypted messages
- [Multi-account](/client/multi-account): isolated storage for each account
- [Network](/client/network): the other adapter `MarmotClient` needs
