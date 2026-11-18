# Multi-account

To support several Nostr accounts in one app, create one `MarmotClient` per account, each with its own storage and rumor databases. This page shows how to build them and how to switch between accounts cleanly.

::: danger Never share storage between accounts
The client's `storage` holds MLS secrets and key package private keys. If two accounts share it without a per-account prefix, they leak key material to each other and corrupt each other's group state.
:::

## Create isolated storage for each account

Give each account its own database (or a key prefix with `scopeStorage`), and its own rumor databases:

```typescript
import { scopeStorage, type MarmotStorage } from "@internet-privacy/marmot-ts";

export function storageForAccount(pubkey: string) {
  return {
    // One database per account...
    storage: openStorage(`marmot-${pubkey}`),
    // ...or a shared database with a per-account prefix:
    // storage: scopeStorage(sharedStorage, `${pubkey}/`),
    rumors: (groupId: string) =>
      openRumorDatabase(`marmot-${pubkey}-${groupId}`),
  };
}
```

`openStorage` returns a `MarmotStorage` (see [Storage](/client/storage)) and `openRumorDatabase` an applesauce `IAsyncEventDatabase<Rumor>` (see [History](/client/history)).

## Create a client for an account

The network adapter can be shared across accounts. The signer, the storage and the key package slot (`clientId`) belong to the account:

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

function createClientForAccount(account: Account) {
  return new MarmotClient({
    signer: account.signer,
    network: sharedNetwork,
    // 32 random bytes as lowercase hex, generated once per account on this
    // device and persisted (see Key packages).
    clientId: account.keyPackageSlot,
    ...storageForAccount(account.pubkey),
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

Stop the old session completely before starting the new one. Otherwise the old client keeps ingesting into the old account's storage in the background:

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

To sign out and forget an account, stop its session and then delete its storage and its rumor databases, for example by dropping the `marmot-${pubkey}` database and its history databases.
