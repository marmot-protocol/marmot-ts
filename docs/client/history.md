# History

MLS itself does not store messages — once an application message is decrypted, it is gone unless you keep it. Marmot makes message history an **optional, pluggable** concern: provide a `historyFactory` to the client and every group gets a history instance at `group.history` that records both self-sent and ingested rumors and lets you query and subscribe to them.

The library ships `GroupRumorHistory`, which stores decrypted [rumors](/getting-started#key-terms) behind a small backend interface.

## Wiring history into the client

`GroupRumorHistory.makeFactory` turns a per-group backend into the factory the client expects:

```typescript
import { GroupRumorHistory } from "@internet-privacy/marmot-ts";
import { KeyValueRumorHistoryBackend } from "@internet-privacy/marmot-ts/extra";

const historyFactory = GroupRumorHistory.makeFactory(
  (groupId) => new KeyValueRumorHistoryBackend(storeForGroup(groupId)),
);

const client = new MarmotClient({
  signer,
  network,
  groupStateStore,
  keyPackageStore,
  historyFactory,
});
```

`KeyValueRumorHistoryBackend` (from `./extra`) adapts any [`GenericKeyValueStore`](/client/storage) into a history backend, so you can persist messages with the same storage primitives you use for group state.

Once configured, you never call `saveMessage` yourself — the session writes to history automatically whenever a message is sent or ingested.

## Querying messages

`group.history` is a `GroupRumorHistory`. Query stored rumors with Nostr filters:

```typescript
const history = group.history;

// All chat messages (kind 9), newest first
const recent = await history.queryRumors({ kinds: [9], limit: 50 });
```

## Live timeline — `subscribe`

`subscribe(filters?)` is an async generator that yields the current timeline immediately, then re-yields it whenever a matching rumor is saved or the history is cleared. This is the natural source for a chat view:

```typescript
for await (const rumors of history.subscribe({ kinds: [9], limit: 100 })) {
  renderTimeline(rumors); // newest-first NostrEvent-shaped rumors
}
```

Both self-sent messages (via `client.groups.send`) and ingested messages (via `group.ingest`) flow through the same subscription, so the UI stays consistent without a separate "echo" path.

## Pagination — `createPaginatedLoader`

For infinite scroll, `createPaginatedLoader(filter?)` yields one page per iteration (default 50 per page), walking backwards through history:

```typescript
const loader = history.createPaginatedLoader({ kinds: [9], limit: 30 });

async function loadOlder() {
  const { value: page, done } = await loader.next();
  if (!done && page) prependToTimeline(page);
}
```

## Other methods and events

- `saveRumor(rumor)` — manually persist an unsigned rumor.
- `purgeMessages()` — clear all stored rumors for the group.
- Emits `rumor` (a rumor was saved) and `cleared` (history purged).

## Retention and backfill

History is independent of MLS epoch secrets. Relay **backfill** (re-ingesting old kind 445 events) can only decrypt epochs still within the engine's bounded rewind horizon; messages from pruned epochs surface as `unreadable` during `ingest` and cannot be recovered — but anything already written to history stays available. Use the `message-retention` group metadata field (see [Proposals](/client/proposals#updating-metadata)) to communicate the intended retention window to members.

## Next steps

- **[Storage](/client/storage)** — the key/value backends history is built on
- **[MarmotGroup](/client/marmot-group)** — sending and ingesting the messages history records
- **[Messages](/core/messages)** — the rumor serialization format
