# Storage

Pluggable storage backends for group state and key packages.

::: warning Multi-Account Isolation
If your application supports multiple user accounts, **each account must have completely isolated storage**. Sharing storage between accounts would leak private key material and compromise security. See the [Multi-Account Support](/client/marmot-client#multi-account-support) section for implementation patterns.
:::

## GroupStateStore

Stores serialized `ClientState` for groups.

### Interface

```typescript
interface GroupStateStore extends EventEmitter {
  get(groupId: string): Promise<SerializedClientState | null>;
  set(groupId: string, state: SerializedClientState): Promise<void>;
  delete(groupId: string): Promise<void>;
  list(): Promise<string[]>;
}
```

### In-Memory Example

```typescript
class MemoryGroupStateBackend extends EventEmitter implements GroupStateStore {
  private states = new Map<string, Uint8Array>();

  async get(groupId: string) {
    return this.states.get(groupId) ?? null;
  }

  async set(groupId: string, state: Uint8Array) {
    this.states.set(groupId, state);
    this.emit("updated");
  }

  async delete(groupId: string) {
    this.states.delete(groupId);
    this.emit("updated");
  }

  async list() {
    return Array.from(this.states.keys());
  }
}
```

## KeyPackageStore

Stores key packages with public and private material.

### Interface

```typescript
interface KeyPackageStore extends EventEmitter {
  get(ref: Uint8Array): Promise<CompleteKeyPackage | null>;
  set(ref: Uint8Array, keyPackage: CompleteKeyPackage): Promise<void>;
  delete(ref: Uint8Array): Promise<void>;
  list(): Promise<Uint8Array[]>;
}
```

### Security Considerations

Key packages contain private key material:

- Store encrypted and access-controlled
- Never transmit unencrypted
- Clear from memory after use

## Browser: IndexedDB

```typescript
class IndexedDBStateStore extends EventEmitter implements GroupStateStore {
  constructor(private db: IDBDatabase) {
    super();
  }

  async get(groupId: string) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("states", "readonly");
      const req = tx.objectStore("states").get(groupId);
      req.onsuccess = () => resolve(req.result?.state ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async set(groupId: string, state: Uint8Array) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction("states", "readwrite");
      const req = tx.objectStore("states").put({ groupId, state });
      req.onsuccess = () => {
        this.emit("updated");
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ... delete and list implementations
}
```

## Node.js: File System

```typescript
import { promises as fs } from "fs";
import { join } from "path";

class FileSystemStateStore extends EventEmitter implements GroupStateStore {
  constructor(private basePath: string) {
    super();
  }

  async get(groupId: string) {
    try {
      const data = await fs.readFile(join(this.basePath, `${groupId}.bin`));
      return new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async set(groupId: string, state: Uint8Array) {
    await fs.writeFile(join(this.basePath, `${groupId}.bin`), state);
    this.emit("updated");
  }

  async remove(groupId: string) {
    await fs.unlink(join(this.basePath, `${groupId}.bin`));
    this.emit("updated");
  }

  async list() {
    const files = await fs.readdir(this.basePath);
    return files
      .filter((f) => f.endsWith(".bin"))
      .map((f) => f.replace(".bin", ""));
  }
}
```

## Usage

### Single Account

```typescript
const client = new MarmotClient({
  // ...
  groupStateBackend: new IndexedDBStateStore(db),
  keyPackageStore: new IndexedDBKeyPackageStore(db),
});
```

### Multi-Account (Namespaced Storage)

```typescript
function createClientForAccount(pubkey: string) {
  return new MarmotClient({
    signer: accountSigner,
    network: sharedNetworkInterface,
    groupStateBackend: localforage.createInstance({
      name: `marmot-${pubkey}`,
      storeName: "groups",
    }),
    keyPackageStore: localforage.createInstance({
      name: `marmot-${pubkey}`,
      storeName: "keyPackages",
    }),
  });
}
```

Stores emit 'updated' events that trigger `watchGroups()` and `watchKeyPackages()` generators.
