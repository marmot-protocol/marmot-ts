# Multi-account

To support several Nostr accounts in one app, create one `MarmotClient` per account, each with its own isolated set of stores. This page shows how to build those stores and how to switch between accounts cleanly.

::: danger Never share stores between accounts
`keyPackageStore` and `groupStateStore` hold MLS private keys. If two accounts share a store, they leak key material to each other and corrupt each other's group state. Isolate **every** store, not just those two.
:::

## Create isolated stores for each account

Namespace every store by the account's pubkey. Message history is per group, so give it a per-account factory as well:

```typescript
import localforage from "localforage";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeKeyValueRumorHistoryFactory } from "@internet-privacy/marmot-ts/extra";

export function storesForAccount(pubkey: string) {
  const store = (storeName: string) =>
    localforage.createInstance({ name: `marmot-${pubkey}`, storeName });

  return {
    groupStateStore: store("groups"),
    keyPackageStore: store("keyPackages"),
    inviteStore: store("invites"),
    ingestStateStore: store("ingest"),
    rewindStore: store("rewind"),
    removedMarkerStore: store("removed"),
    lifecycleStore: store("lifecycle"),
    historyFactory: makeKeyValueRumorHistoryFactory((groupId) =>
      localforage.createInstance({
        name: `marmot-${pubkey}-history-${bytesToHex(groupId)}`,
      }),
    ),
  };
}
```

Any `GenericKeyValueStore` backend works here; see [Storage](/client/storage) for what each store holds. If you configure a `mediaFactory` (see [Media](/client/media)), scope it per account in the same way.

## Create a client for an account

The network adapter can be shared across accounts. The signer, the stores and the key package slot (`clientId`) belong to the account:

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

function createClientForAccount(account: Account) {
  return new MarmotClient({
    signer: account.signer,
    network: sharedNetwork,
    // 32 random bytes as lowercase hex, generated once per account on this
    // device and persisted (see Key packages).
    clientId: account.keyPackageSlot,
    ...storesForAccount(account.pubkey),
  });
}
```

## Start and stop an account session

Each client needs its own background sync. Keep the handles so you can stop them later:

```typescript
import type { Unsubscribable } from "@internet-privacy/marmot-ts/client";

interface AccountSession {
  client: MarmotClient;
  groupSync: Unsubscribable;
  inviteSync: Unsubscribable;
  watchers: AbortController;
}

async function startSession(account: Account): Promise<AccountSession> {
  const client = createClientForAccount(account);
  await client.groups.loadAll();
  return {
    client,
    groupSync: client.groups.connectAll(),
    inviteSync: await client.invites.listen(account.inboxRelays),
    // Pass watchers.signal to every watch() your UI starts for this account.
    watchers: new AbortController(),
  };
}

async function stopSession(session: AccountSession) {
  session.watchers.abort();
  session.groupSync.unsubscribe();
  session.inviteSync.unsubscribe();
  for (const group of session.client.groups.loaded)
    await session.client.groups.unload(group.id);
}
```

`unload()` disposes each group's timers and queued outbound work but keeps its persisted state, so the group loads again the next time the account is opened.

## Switch accounts

Stop the old session completely before starting the new one. Otherwise the old client keeps ingesting into the old account's stores in the background:

```typescript
let current: AccountSession | null = null;

async function switchAccount(account: Account) {
  if (current) await stopSession(current);
  current = await startSession(account);
  return current.client;
}
```

In UI frameworks, store the active client in state and make every watcher depend on it. When the client changes, the cleanup cancels the old watchers (see [UI frameworks](/client/ui-frameworks#cancel-watchers-with-signal)).

## Remove an account

To sign out and forget an account, stop its session and then delete all of its stores together, for example by dropping the `marmot-${pubkey}` database and its history databases. Don't delete only some of them, because the stores depend on each other.
