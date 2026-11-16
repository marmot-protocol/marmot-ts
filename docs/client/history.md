# History

MLS does not store messages: once a message is decrypted, it is gone unless you keep it. Configure a history backend and every group gets a `group.history` that records sent and received messages, so you can query them, render a live timeline, and page through older messages.

History is local storage on this device. It is separate from what relays retain: relays only hold encrypted kind 445 events, and old events can't be decrypted again once the group has moved far enough past their epoch. Keep plaintext history if you want messages to survive restarts.

## Wire history into the client

Pass a `historyFactory` to `MarmotClient`. `GroupRumorHistory.makeFactory` builds one from a per-group backend, and `KeyValueRumorHistoryBackend` adapts any [key-value store](/client/storage):

```typescript
import { GroupRumorHistory, MarmotClient } from "@internet-privacy/marmot-ts";
import {
  InMemoryKeyValueStore,
  KeyValueRumorHistoryBackend,
} from "@internet-privacy/marmot-ts/extra";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

const historyFactory = GroupRumorHistory.makeFactory(
  () => new KeyValueRumorHistoryBackend(new InMemoryKeyValueStore<Rumor>()),
);

const client = new MarmotClient({
  signer,
  network,
  groupStateStore,
  keyPackageStore,
  historyFactory,
});
```

Give each group its own store (for example, a key prefix derived from the group ID) so groups can't read or clear each other's messages. `makeKeyValueRumorHistoryFactory(storeFor)` from `/extra` is a shorthand for the same wiring.

You never save messages yourself: the group writes every sent message and every received application message to its history.

## Query messages

`queryRumors` takes Nostr filters and returns rumors newest first:

```typescript
const recent = await group.history.queryRumors({ kinds: [9], limit: 50 });
```

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

`createPaginatedLoader(filter?)` yields one page per call, walking backwards in time (50 per page unless the filter sets `limit`):

```typescript
const loader = group.history.createPaginatedLoader({ kinds: [9], limit: 30 });

async function loadOlder() {
  const { value: page, done } = await loader.next();
  if (!done && page) prependToTimeline(page);
}
```

Pages are snapshots. If a message is later retracted, a page you already rendered will still contain it; refresh from `subscribe` or re-query.

## Remove or purge messages

```typescript
await group.history.removeMessage(rumorId); // remove one message by rumor ID
await group.history.purgeMessages(); // clear the group's history
```

`GroupRumorHistory` emits `rumor`, `removed`, and `cleared` events after each successful change. If a history write fails, the group emits `historyError`:

```typescript
group.on("historyError", (error) => reportError(error));
```

Destroying a group (`group.destroy()`, `client.groups.destroy()`, or a successful `client.groups.leave()`) purges its history, and so does a group being disbanded. If you want to keep messages from such groups, copy them out first.

## Retracted messages

When fork resolution withdraws a message, the library removes it from history and open `subscribe` timelines refresh automatically. See [fork retractions](/client/messages#handle-fork-retractions) for what else your app should update.

## Custom backends

To store messages elsewhere (SQLite, IndexedDB with indexes, a server), implement `GroupRumorHistoryBackend`: `queryRumors` (newest first, honoring filters and `limit`), `addRumor`, `removeRumor` (idempotent), and `clear`. Key rumors by `id` so relay backfill overwrites rather than duplicates. See the [API reference](pathname:///reference/index.html) for the interface.
