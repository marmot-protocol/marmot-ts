# Storage

Marmot persists three kinds of data through pluggable key/value stores: serialized MLS **group state**, local **key package** material, and received **invites**. All of them share one interface, so any backend that matches its shape works — in-memory for tests, IndexedDB or LocalForage in the browser, the filesystem or SQLite on the server.

## The `GenericKeyValueStore` interface

```typescript
interface GenericKeyValueStore<T> {
  getItem(key: string): Promise<T | null>;
  setItem(key: string, value: T): Promise<T>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}
```

The interface is exported from both the root and the `./utils` subpath:

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";
```

## The three stores

| Constructor option | Value type                                    | Holds                                            |
| ------------------ | --------------------------------------------- | ------------------------------------------------ |
| `groupStateStore`  | `GenericKeyValueStore<SerializedClientState>` | Serialized MLS group state (one entry per group) |
| `keyPackageStore`  | `GenericKeyValueStore<StoredKeyPackage>`      | Local key package public + private material      |
| `inviteStore`      | `GenericKeyValueStore<StoredInviteEntry>`     | Received gift wraps and decrypted Welcome rumors |

`groupStateStore` and `keyPackageStore` are required; `inviteStore` is optional and defaults to an in-memory store.

- **`SerializedClientState`** is a `Uint8Array` — the encoded MLS client state.
- **`StoredKeyPackage`** carries a key package's public package plus its private key material and publish tracking. Treat it as **secret**.

::: warning Key package material is sensitive
`keyPackageStore` holds private keys. Use a store with the same protection you would give any signing key, and never share an instance across user accounts.
:::

## In-memory store

For tests and short-lived processes, the `./extra` subpath ships an in-memory implementation:

```typescript
import { InMemoryKeyValueStore } from "@internet-privacy/marmot-ts/extra";

const groupStateStore = new InMemoryKeyValueStore();
const keyPackageStore = new InMemoryKeyValueStore();
const inviteStore = new InMemoryKeyValueStore();
```

## LocalForage (browser)

[LocalForage](https://github.com/localForage/localForage) instances satisfy `GenericKeyValueStore` directly (IndexedDB/WebSQL/localStorage under the hood):

```typescript
import localforage from "localforage";

const groupStateStore = localforage.createInstance({ name: "marmot-groups" });
const keyPackageStore = localforage.createInstance({ name: "marmot-keys" });
```

## Custom backend

Any object with the five methods works. A minimal filesystem-backed adapter:

```typescript
import type { GenericKeyValueStore } from "@internet-privacy/marmot-ts";

function fileStore<T>(load, persist): GenericKeyValueStore<T> {
  return {
    async getItem(key) {
      return (await load())[key] ?? null;
    },
    async setItem(key, value) {
      const all = await load();
      all[key] = value;
      await persist(all);
      return value;
    },
    async removeItem(key) {
      const all = await load();
      delete all[key];
      await persist(all);
    },
    async clear() {
      await persist({});
    },
    async keys() {
      return Object.keys(await load());
    },
  };
}
```

## Per-account isolation

Each user account **must** use completely isolated stores — mixing key package material between accounts would leak private keys. Namespace your stores by the account's public key:

```typescript
const store = localforage.createInstance({ name: `marmot-${pubkey}` });
```

See [Multi-Account Support](/client/marmot-client#multi-account-support) for the full pattern.

## Encrypted store (demo only)

The `./extra` subpath also exports `EncryptedKeyValueStore`, a password-encrypting wrapper.

::: danger Not for production
`EncryptedKeyValueStore` is a demonstration of the wrapping pattern only. It is **not** a secure at-rest encryption scheme — use platform key storage (Keychain, DPAPI, libsecret, WebCrypto + a hardware-backed key) for real deployments.
:::

## Next steps

- **[MarmotClient](/client/marmot-client)** — wiring stores into the client
- **[History](/client/history)** — message history is a separate, optional backend
- **[Client State](/core/state)** — what gets serialized into `groupStateStore`
