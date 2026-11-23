# Storage

`MarmotClient` persists everything through one `database` option: an **account database** plus **one database per group**. Each is a small set of typed tables with named, index-backed queries, so a real database (IndexedDB, SQLite) does the indexing instead of the library scanning keys in memory.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";
import { indexedDBDatabase } from "@internet-privacy/marmot-ts/extra";

const client = new MarmotClient({
  signer,
  network,
  database: indexedDBDatabase({ prefix: `marmot:${pubkey}` }),
});
```

## What lives where

| Database              | Tables                                                    | Holds                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account               | `keyPackages`, `invites`, `groups`, `intents`, `meta`     | Your key packages (**including private keys**), received invites and seen gift wraps, the list of groups, and in-progress operations that span databases                                                       |
| Group (one per group) | `meta`, `treeNodes`, `wrappers`, `messages`, `deliveries` | The group's MLS state and lifecycle records, its [fork-history tree](/client/fork-history), processed transport events, decrypted messages, and how each message was delivered (epoch, state, transport event) |

Destroying or leaving a group drops its whole database. Values contain MLS secrets and private keys: protect storage the way you would protect a signing key.

## Built-in adapters

| Adapter                       | Import                              | Use for                                                          |
| ----------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `memoryDatabase()`            | `@internet-privacy/marmot-ts`       | Tests, demos and throwaway sessions. Everything is lost on exit. |
| `indexedDBDatabase(options?)` | `@internet-privacy/marmot-ts/extra` | Browsers and workers: one IndexedDB database per group           |
| `sqliteDatabase(connection)`  | `@internet-privacy/marmot-ts/extra` | Node, Bun, Deno, React Native: any SQLite driver                 |

### IndexedDB

```typescript
const database = indexedDBDatabase({ prefix: `marmot:${pubkey}` });
```

The account lives in `<prefix>:account` and each group in `<prefix>:group:<groupId>`. Use one prefix per account.

### SQLite

`sqliteDatabase` takes any object with an `execute(sql, params)` method that returns result rows as plain objects. For example with `bun:sqlite`:

```typescript
import { Database } from "bun:sqlite";
import { sqliteDatabase } from "@internet-privacy/marmot-ts/extra";

const db = new Database("marmot.sqlite");
db.exec("PRAGMA journal_mode = WAL");
const database = sqliteDatabase({
  execute: (sql, params = []) => db.query(sql).all(...(params as any[])),
});
```

All groups share the connection; each group's rows carry its id, and indexes cover message time, kind, author and tags. Give each account its own file (or a distinct `tablePrefix`) and dedicate the connection to the adapter.

## Querying messages

Messages are rows in the group's `messages` table, indexed by `kind`, `pubkey`, `createdAt` and single-letter tags. `group.history` reads them through applesauce (see [History](/client/history)), and you can query the table directly with any Nostr filter: NIP-01 fields and `#` tags, NIP-91 `&` tags (every value required) and NIP-50 `search` (a case-insensitive substring of the content). Results are newest first and truncated to `limit`:

```typescript
const db = group.database;
const replies = await db.messages.query({
  kinds: [9],
  "#e": [parentId],
  limit: 50,
});
const deliveries = await db.deliveries.byRumor(replies[0].id);
```

Each `deliveries` row records how a message arrived: the epoch it decrypted at and the fork-history state it belongs to. A message stays visible while any delivery supports it; when a fork switch abandons the branch it arrived on, its delivery and (if it was the last one) the message are removed in the same transaction.

## Inspecting tables

Built-in adapters provide optional `all()` methods on every table and
`database.groups.list()` to discover stored group databases, including groups
absent from the account registry. Custom adapters may omit these diagnostic
capabilities; check for them before calling. An unsupported enumeration is not
an empty table.

```typescript
const database = client.database;
if (database.groups.list) {
  for (const id of await database.groups.list()) {
    const group = await database.groups.open(id);
    try {
      if (group.wrappers.all) {
        console.log(await group.wrappers.all());
      }
    } finally {
      await group.close();
    }
  }
}
```

`all()` returns independent row copies in primary-key order, unlike the
time-ordered `messages.query()`. These reads load entire tables and can expose
private keys and plaintext. Protect inspection output accordingly. Reads of
different tables are not an atomic whole-database snapshot.

`groups.list()` does not create databases and may omit empty ones. When it is
unavailable, account group records and pending intents can identify known groups,
but cannot discover unregistered storage. The demos app's **Inspect database**
modal uses only this public API.

## Transactions

Every change the client makes to a group — new MLS state, fork-history nodes, the processed transport event, new or retracted messages — commits in **one group transaction**. After a crash either all of it is durable or none of it is, so a message is never shown without the state that produced it, and an event is never applied twice.

Operations that touch both the account and a group database (creating, joining and destroying a group) write an `intents` row first and are finished or undone the next time the client starts.

## Encryption at rest

The adapters store values as given. Encrypt at the storage layer when the threat model requires it: SQLCipher or an encrypted file system for SQLite, an encrypted volume or a wrapper around IndexedDB in the browser. Index columns (message kinds, authors, timestamps and tags; epochs; invite states) must stay readable by the database to be indexed.

## Write your own adapter

Implement `MarmotDatabase` from `@internet-privacy/marmot-ts`:

```typescript
interface MarmotDatabase {
  account: MarmotAccountDatabase;
  groups: {
    open(groupId: string): Promise<MarmotGroupDatabase>;
    drop(groupId: string): Promise<void>;
  };
}
```

Requirements:

- `transaction(fn)` is **all-or-nothing** across every table and resolves only once durable. Reads inside `fn` see its own writes.
- `fn` only awaits the transaction's own methods: the library prepares every value before the transaction opens, which keeps IndexedDB transactions alive.
- Reads outside a transaction see committed data.
- Index the columns each query names: `wrappers.deleteBelow` by `epoch`, `messages.query` by time, kind, author and tags, `deliveries.byRumor` / `countByRumor` by `rumorId`, `deliveries.withEvidence` (rows that still hold `evidence`), and `invites.byState` / `byRumor`.
- `messages.query(filter)` answers one Nostr filter. `compileMessageFilter` and `matchesMessage` (from `@internet-privacy/marmot-ts/client`) define the matching rules, `indexTags` the tag keys to index, and `selectMessages` answers a filter over rows you have loaded, for clauses your store cannot index.
- Store `value` and `evidence` byte for byte.
- One `MarmotDatabase` holds one account. Run only one `MarmotClient` at a time over it.

The IndexedDB and SQLite adapters in `src/extra` are complete reference implementations, and both pass the same conformance suite as the in-memory database.

## Next steps

- [History](/client/history): reading decrypted messages
- [Multi-account](/client/multi-account): isolated storage for each account
- [Network](/client/network): the other adapter `MarmotClient` needs
