# History

MLS does not store messages: once a message is decrypted, it is gone unless you keep it. Every group has a `group.history` that records sent and received messages, so you can query them, render a live timeline, and page through older messages.

History is local to this device. Relays only hold encrypted kind 445 events, and MLS forward secrecy means old events can't be decrypted again once the group has moved past their epoch. History lives in each group's database (see [Storage](/client/storage)), so it survives restarts whenever the client's `database` is durable. With `memoryDatabase()` it is lost when the process exits.

You never save messages yourself: the group writes every sent message and every received application message to the group database in the same transaction as the state that produced it. A message delivered on a fork branch that later loses is removed the same way.

## Query messages

`queryRumors` takes Nostr filters (including `ids` and tag filters) and returns rumors newest first:

```typescript
const recent = await group.history.queryRumors({ kinds: [9], limit: 50 });
```

`group.history.store` is the underlying applesauce `AsyncRumorStore`, so applesauce models, `timeline()` and the `insert$` / `remove$` streams work too. For queries the applesauce filter language can't express, read the group database's `messages` and `deliveries` tables directly (see [Storage](/client/storage#querying-messages)).

## Live timeline

`subscribe(filters?, { signal }?)` is an async generator that yields the current matching rumors, then yields a fresh list whenever a matching message is saved, a message is removed, or history is cleared. It is the natural source for a chat view:

```typescript
const controller = new AbortController();

for await (const rumors of group.history.subscribe(
  { kinds: [9], limit: 100 },
  { signal: controller.signal },
)) {
  renderTimeline(rumors); // newest first
}

// On unmount:
controller.abort();
```

Each update is a complete re-query, so replace your rendered list rather than appending to it. Several changes may arrive as one update. See [UI frameworks](/client/ui-frameworks) for wiring generators into React and other frameworks.

## Load older messages

`createPaginatedLoader(filter?)` yields one page per call, walking backwards in time (50 per page unless the filter sets `limit`). Messages that share a timestamp are never skipped:

```typescript
const loader = group.history.createPaginatedLoader({ kinds: [9], limit: 30 });

async function loadOlder() {
  const { value: page, done } = await loader.next();
  if (!done && page) prependToTimeline(page);
}
```

Pages are snapshots. If a message is later retracted, a page you already rendered will still contain it; refresh from `subscribe` or re-query.

## Deletions and expiry

The rumor store applies NIP-09 deletions (a member's kind 5 rumor removes that member's own messages) and NIP-40 expiration. `GroupHistory` emits `rumor`, `removed` and `cleared` events after each change. If a history write fails, the group emits `historyError`:

```typescript
group.on("historyError", (error) => reportError(error));
```

Destroying a group (`group.destroy()`, `client.groups.destroy()`, or a successful `client.groups.leave()`) deletes its database, including its history; a disbanded group purges its history too. If you want to keep messages from such groups, copy them out first.

## Retracted messages

When fork resolution withdraws a message, the library removes it from history and open `subscribe` timelines refresh automatically. See [fork retractions](/client/messages#handle-fork-retractions) for what else your app should update.
