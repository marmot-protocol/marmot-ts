# Marmot Group

`MarmotGroup` represents a single encrypted group. It is a thin **facade** over the protocol state machine: it owns a [`GroupSession`](#session-and-runtime) (which wraps the engine's MLS `ClientState`) and a `GroupRuntime` (which publishes outbound effects to Nostr). You obtain instances from the client — `client.groups.get(id)`, `client.groups.create(...)`, `client.groups.loadAll()`, or the `client.groups.watch()` stream — never by constructing one directly.

::: tip Prefer the manager for actions
Most operations have a convenience method on [`client.groups`](/client/marmot-client) that resolves the group, drives the session, and publishes for you: `send`, `commit`, `invite`, `leave`, `ingest`. Reach into the `MarmotGroup` instance for its **read** surface (state, members, metadata) and its **events**.
:::

## Identity and state

```typescript
group.id; // Uint8Array — the MLS group_id
group.idStr; // hex string of group.id
group.state; // the underlying MLS ClientState (advanced API)
group.relays; // string[] — the group's Nostr relays
```

### Group metadata — `group.groupData`

`groupData` is a `MarmotGroupView | null` projected from the group's app components:

```typescript
const data = group.groupData;
data?.name;
data?.description;
data?.adminPubkeys; // string[]
data?.relays; // string[]
data?.nostrGroupId; // Uint8Array — the kind 445 routing tag (#h)
data?.avatarUrl;
data?.messageRetention; // seconds; 0 = retain indefinitely
```

### Membership and details — `group.info`

`info` is a richer `MarmotGroupInfo` projection:

```typescript
group.info.members.pubkeys; // string[] of member Nostr pubkeys
group.info.app.components; // decoded app-component dictionary
```

### Convergence and lifecycle

The engine surfaces two read-only status values used to reason about concurrent commits and the publish-before-apply window:

```typescript
group.lifecycle; // "Stable" | "PendingPublish" | "Merging" | ...
group.convergenceStatus; // "Syncing" | "Resolving" | "Settled" | "Blocked"
group.unappliedProposals; // proposals seen but not yet committed
group.dirty; // unsaved state changes pending
```

Outbound sends are **convergence-gated** — an intent submitted while the group is not `Settled` is queued until convergence resolves. See [Architecture](/guide/architecture#engine-module).

## Sending messages

Build an application-message intent and submit it. The manager helper is the usual path:

```typescript
import {
  createApplicationMessageIntent,
  createChatRumor,
} from "@internet-privacy/marmot-ts";

const rumor = createChatRumor({ pubkey: myPubkey, content: "Hello!" });
await client.groups.send(group.id, createApplicationMessageIntent(rumor));
```

Equivalent on the instance:

```typescript
await group.submitIntent(createApplicationMessageIntent(rumor));
```

`createChatRumor` emits a kind 9 rumor (a chat convention). Any unsigned rumor can be serialized as an application message — see [Messages](/core/messages).

## Receiving messages

Decrypted application messages are emitted as the `applicationMessage` event carrying the serialized rumor bytes:

```typescript
import { deserializeApplicationData } from "@internet-privacy/marmot-ts";

group.on("applicationMessage", (data) => {
  const rumor = deserializeApplicationData(data);
  console.log(`${rumor.pubkey}: ${rumor.content}`);
});
```

To feed inbound traffic, subscribe to the group's relays for kind 445 events and drive `group.ingest`. The async generator advances MLS processing and yields a **disposition** per envelope:

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";

const sub = client.network.subscription(group.relays, [
  { kinds: [445], "#h": [bytesToHex(group.groupData.nostrGroupId)] },
]);

sub.subscribe({
  next: async (event) => {
    for await (const result of group.ingest([event])) {
      switch (result.kind) {
        case "processed":
          break; // commits/proposals applied; app messages arrive via the event above
        case "deferred":
          break; // can't process yet — retry when more state arrives
        case "unreadable":
          console.warn("dropped an unreadable event");
          break;
      }
    }
  },
});
```

Other dispositions include `skipped`, `rejected`, `invalidated`, `autoCommit`, and `removed`. See [`DispositionedIngestResult`](https://github.com/marmot-protocol/marmot-ts/blob/master/src/engine/types.ts).

## Proposals and commits

Use the [`Proposals`](/client/proposals) builders with `client.groups.commit`, or the high-level `client.groups.invite` / `client.groups.leave` shortcuts:

```typescript
import { Proposals } from "@internet-privacy/marmot-ts";

// Remove a member (admins only)
await client.groups.commit(group.id, {
  extraProposals: [Proposals.proposeRemoveUser(memberPubkey)],
});

// Update metadata
await client.groups.commit(group.id, {
  extraProposals: [Proposals.proposeUpdateMetadata({ name: "New name" })],
});
```

A standalone (uncommitted) proposal can be broadcast with `group.propose(action)` / `group.sendProposal(proposal)`, and a key rotation with `group.selfUpdate()`.

## Events

`MarmotGroup` extends `EventEmitter`. Available events:

| Event                | Payload       | Fires when                                                        |
| -------------------- | ------------- | ----------------------------------------------------------------- |
| `applicationMessage` | `Uint8Array`  | A decrypted application message is received                       |
| `stateChanged`       | `ClientState` | Group state advances (commit, proposal, message)                  |
| `stateSaved`         | `MarmotGroup` | State was persisted to the store                                  |
| `removed`            | `MarmotGroup` | An inbound commit removed **this** member (admin or self-removal) |
| `destroyed`          | `MarmotGroup` | The group's local state was destroyed                             |
| `historyError`       | `Error`       | Best-effort history persistence failed (non-blocking)             |

```typescript
group.on("removed", (g) => {
  // Local state is kept as a tombstone — decide when to purge it
  void client.groups.destroy(g.id);
});
```

## Session and runtime

For advanced integrations, `group.session` (a [`GroupSession`](https://github.com/marmot-protocol/marmot-ts/blob/master/src/client/session/group-session.ts)) is the protocol-state owner and `group.runtime` is the transport publisher. The facade methods delegate to these. Prefer the facade and manager APIs unless you are building a custom transport or persistence layer — in which case see the [Engine module](/guide/architecture#engine-module).

## Next steps

- **[Proposals](/client/proposals)** — building add/remove/metadata proposals
- **[History](/client/history)** — persisting and querying messages
- **[MarmotClient](/client/marmot-client)** — lifecycle and the manager APIs
