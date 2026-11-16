# Messages

This page covers sending application messages to a group, receiving them from relays, and handling the rare case where a message you already showed is withdrawn by fork resolution.

Application messages are unsigned Nostr events ("rumors") encrypted with MLS. Kind 9 is the chat convention, but any kind works.

## Send a chat message

Build a kind 9 rumor, wrap it in an application-message intent, and submit it through the groups manager:

```typescript
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts";

const rumor = createChatRumor({
  pubkey: await client.signer.getPublicKey(),
  content: "Hello!",
});

await client.groups.send(group.id, createApplicationMessageIntent(rumor));
```

`client.groups.send` resolves to one publish result per published event. If a [history](/client/history) backend is configured, the sent rumor is saved to it automatically, so you don't need a separate "optimistic echo" path.

## Send a custom kind

Any valid unsigned rumor can be sent. Compute its `id` with `getEventHash`; serialization rejects a rumor whose `id` does not match its contents:

```typescript
import { getEventHash } from "applesauce-core/helpers/event";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";
import { createApplicationMessageIntent } from "@internet-privacy/marmot-ts";

const reaction: Rumor = {
  id: "",
  kind: 7,
  pubkey: await client.signer.getPublicKey(),
  created_at: Math.floor(Date.now() / 1000),
  content: "+",
  tags: [["e", targetRumorId]],
};
reaction.id = getEventHash(reaction);

await client.groups.send(group.id, createApplicationMessageIntent(reaction));
```

## Sends wait while the group settles

When the group is resolving concurrent commits (`group.convergenceStatus` is not `"Settled"`), sends are queued and the returned promise stays pending until convergence settles. You don't need to retry; just don't treat a slow `send` as a failure. Sending to a removed or disbanded group throws.

## Receive messages with `connectAll`

`client.groups.connectAll()` is the normal way to receive group traffic. For every loaded group it:

- backfills the group's kind 445 events from its relays, then opens a live subscription;
- verifies each event's signature and `h` tag, drops duplicates, and ingests events in order;
- connects groups that are created, joined, or loaded later, and disconnects groups that are left, removed, destroyed, or unloaded.

```typescript
const connection = client.groups.connectAll();

// On shutdown or account switch:
connection.unsubscribe();
```

Use `client.groups.connect(groupId)` to connect a single group instead. Both accept `{ signal, fallbackRelays }`. Groups with no relays of their own use `fallbackRelays`; groups with neither are skipped. On memory-constrained devices you can bound backfill with `backfillPageSize` and `backfillMaxPages`.

## Handle incoming messages

Each group emits `applicationMessage` with the serialized rumor bytes. Decode them with `deserializeApplicationData`:

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

group.on("applicationMessage", (data) => {
  const rumor = deserializeApplicationData(data);
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});
```

`applicationMessage` fires only for received messages, not your own sends. For a chat timeline, render from [`group.history.subscribe()`](/client/history#live-timeline) instead: it includes both sent and received messages and refreshes automatically when a message is retracted.

## Observe ingest results

Every ingested event produces a result. Connected groups forward them through the manager's `ingestResult` event (each group also emits its own `ingestResult` event):

```typescript
client.groups.on("ingestResult", (groupId, result) => {
  if (result.kind === "unreadable") console.warn("unreadable", result.event.id);
});

client.groups.on("rejected", (groupId, event, reason) => {
  console.warn("rejected at trust boundary", event.id, reason);
});
```

The result kinds you will commonly see:

| `kind`                                  | Meaning                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `processed`                             | Applied. App messages arrive via `applicationMessage`.                                |
| `deferred`                              | Can't be processed yet (for example, a missing parent commit). Retried automatically. |
| `refused`                               | The ingestion pool is full. Retried once capacity frees.                              |
| `skipped`                               | Duplicate, own echo, already applied, or otherwise stale. `result.reason` says why.   |
| `unreadable`                            | Could not be decrypted or decoded.                                                    |
| `rejected`                              | Failed authorization.                                                                 |
| `removed`                               | A commit removed you from the group.                                                  |
| `invalidated`                           | A message you already received was on a losing fork branch. See below.                |
| `stateInvalidated` / `stateRevalidated` | Membership or metadata changes from a commit were withdrawn or restored. See below.   |

Every result also carries a protocol-level `disposition` (`accepted`, `stale`, `deferred`, or `invalidated`) if you prefer to handle the coarse category. Other kinds (`autoCommit`, `appliedNotifications`) are handled by the library. See the [API reference](pathname:///reference/index.html) for the full `DispositionedIngestResult` type.

## Handle fork retractions

Messages are delivered as soon as they decrypt. If two members commit at the same time, the group briefly forks; when convergence picks the winning branch, messages that only existed on the losing branch must stop appearing as delivered.

The library removes such messages from the configured [history](/client/history) before it reports them. Your app must update anything else it built from them (rendered lists, notifications, search indexes). The `invalidated` result carries `rumorId`, the ID of the withdrawn inner rumor:

```typescript
client.groups.on("ingestResult", async (groupId, result) => {
  if (result.kind === "invalidated" && result.rumorId) {
    // The same rumor may still exist via another delivery, so refresh from
    // history rather than deleting it unconditionally.
    refreshTimeline(groupId);
  }

  if (
    result.kind === "stateInvalidated" ||
    result.kind === "stateRevalidated"
  ) {
    const group = await client.groups.get(groupId);
    refreshGroupDetails(group); // members, admins, name, ...
    await group.session.acknowledgeConvergenceEffect(result);
  }
});
```

::: warning Acknowledge state effects
After you apply a `stateInvalidated` or `stateRevalidated` result, call `group.session.acknowledgeConvergenceEffect(result)`. Unacknowledged effects are reported again on the next ingest (including after restart) so your app can't miss them.
:::

Retractions can happen without any new relay event, when a convergence timer settles. Listen on the `ingestResult` event rather than only inspecting results from your own `ingest()` calls. If you render from `group.history.subscribe()`, retracted messages disappear from the timeline automatically.

## Ingest events from a custom transport

If you receive kind 445 events through your own transport instead of `connect`/`connectAll`, pass them to `group.ingest()` (or `client.groups.ingest(groupId, events)`). You must verify signatures and the `h` tag yourself, and you must fully drain each generator before starting another batch for the same group:

```typescript
import { verifyEvent } from "applesauce-core/helpers/event";

const trusted = events.filter((event) => verifyEvent(event));
for await (const result of group.ingest(trusted)) {
  handleResult(result); // same result kinds as above
}
```

An abandoned generator has not finished ingesting: events after the point where you stopped are not processed. Results from manual ingestion are also emitted on the group's `ingestResult` event.
