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
group.relays; // string[] | undefined — the group's Nostr relays
```

### Group metadata — `group.groupData`

`groupData` is a `MarmotGroupView | null` projected from the group's app components:

```typescript
const data = group.groupData;
data?.name;
data?.description;
data?.adminPubkeys; // string[]
data?.relays; // string[]
data?.nostrGroupId; // Uint8Array | undefined — the kind 445 routing tag (#h)
data?.avatarUrl;
data?.messageRetention; // bigint seconds; 0n = disappearing messages disabled
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

### Removal and terminal disband

`group.status` is `"active"`, `"removed"`, or `"disbanded"`. Check it separately from convergence and profile support: active membership alone does not make a send eligible.

- **Removed:** outbound preparation and publication are blocked, and queued intents are rejected when removal is realized. The local tombstone and retained recovery material can remain stored. A retained branch can restore membership only when ordinary canonical branch selection supersedes the authenticated removal, legal replay starts at its exact active parent, and the resulting state restores the same local identity and leaf. Merely withdrawing a state notification or finding an active snapshot does not clear removal.
- **Recovery pending:** status remains `"removed"` through authority, snapshot, marker and attribution-cleanup writes. Registry activation retries interrupted recovery and exposes active membership only after durable validation and cleanup finish. Invalid evidence, an absent retained anchor or legacy boolean-only removal stays fenced. Previously cancelled sends are not restored; submit new intents after successful recovery.
- **Disbanded:** canonical terminal selection immediately closes outbound use, including when persistence fails. The status is absorbing for this group copy; `groupData` is `null` and the facade retains a scrubbed terminal projection. With durable lifecycle storage, restart repairs interrupted writes from terminal intent or tombstone authority. The restart guarantee begins with the first successful recoverable terminal write; a crash before that boundary can restore the previous active snapshot.

Retained-anchor removal recovery is an intentional supported interpretation of canonical branch supersession, matching MDK's [`distributed_convergence.rs`](https://github.com/marmot-protocol/mdk/blob/d4e91c8d90293de1a664a950a134f747dbb197a8/crates/cgka-engine/src/distributed_convergence.rs). It differs from the terminal-local-leaf wording in [`protocol-core/member-departure.md`](https://github.com/marmot-protocol/marmot/blob/7fabb81b3ed6e2fffeb1b267a0d2ae92b0ab2c89/protocol-core/member-departure.md): it requires retained authenticated recovery material. Destroying that material prevents this recovery; an independently validated fresh Welcome remains the rejoin path.

Removal and disband callbacks use a consumed-attempt record before listeners run. Durable stores suppress another attempt for the same lifecycle event after restart, but failure around that write can lose the callback. They do not promise exactly-once external execution. Terminal disband suppresses a duplicate removal callback from the same commit. Reconcile from loaded `group.status`, and see [Storage](/client/storage#callback-delivery-boundary) for required adapters and failure limits.

Terminal activation and ingestion also retry unfinished history retractions and replay unacknowledged convergence effects. Fully drain ingestion results and durably acknowledge effects after applying them; a terminal status does not itself acknowledge application work.

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

To feed inbound traffic, connect the group through the client. `client.groups.connect()` fetches the group's kind 445 backlog, opens a live subscription, checks each event's signature and `h` tag, and drains everything through `group.ingest()` (see [Receiving group traffic](/client/marmot-client#receiving-group-traffic)):

```typescript
const connection = await client.groups.connect(group.id);
client.groups.on("unreadable", (groupId, event) =>
  console.warn("unreadable", event.id),
);
// later: connection.unsubscribe();
```

### Ingesting events manually

If you run your own subscription, verify each event before ingesting it (`group.ingest` does not check signatures or the `h` tag) and fully drain one `ingest()` generator before starting the next. The generator advances MLS processing and yields a **disposition** per event:

```typescript
import { verifyEvent } from "applesauce-core/helpers/event";
import type { NostrEvent } from "applesauce-core/helpers/event";

async function ingestBatch(events: NostrEvent[]) {
  const trusted = events.filter((event) => verifyEvent(event));
  for await (const result of group.ingest(trusted)) {
    switch (result.kind) {
      case "processed":
        break; // commits/proposals applied; app messages arrive via the event above
      case "deferred":
        break; // held in the ingestion pool and retried automatically
      case "invalidated":
        break; // see "Fork invalidation" below
      case "unreadable":
        console.warn("dropped an unreadable event");
        break;
    }
  }
}
```

Other kinds: `skipped`, `rejected`, `refused` (ingestion pool at capacity), `autoCommit`, `removed`, `appliedNotifications`, and `stateInvalidated` / `stateRevalidated` (a rewind withdrew or restored the state notifications of a commit). See [`DispositionedIngestResult`](https://github.com/marmot-protocol/marmot-ts/blob/master/src/client/session/group-session.ts).

### Fork invalidation

Marmot delivers messages eagerly. If convergence later abandons the branch a message arrived on, `ingest` yields `{ kind: "invalidated", payload }`, where `payload` holds the message's app payload bytes when they are available. The message was already emitted through `applicationMessage` and written to [history](/client/history#fork-invalidated-messages), and the library does not remove it. Retract it from your UI and history yourself.

In the same way, `stateInvalidated` and `stateRevalidated` withdraw or restore the membership and metadata changes of a commit. After your app has applied one, record it with `group.session.acknowledgeConvergenceEffect(result)`.

```typescript
// inside ingestBatch() from the example above
for await (const result of group.ingest(trusted)) {
  if (result.kind === "invalidated" && result.payload) {
    const rumor = deserializeApplicationData(result.payload);
    removeFromTimeline(rumor.id);
  } else if (
    result.kind === "stateInvalidated" ||
    result.kind === "stateRevalidated"
  ) {
    refreshGroupDetails(group);
    await group.session.acknowledgeConvergenceEffect(result);
  }
}
```

The spec requires that a change which lost branch selection not remain visible as completed ([`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md)). These results are only visible when you call `ingest` yourself; `connect()` / `connectAll()` do not surface them.

## Proposals and commits

Use the [`Proposals`](/client/proposals) builders with `client.groups.commit`, or the high-level `client.groups.invite` / `client.groups.leave` shortcuts:

```typescript
import { Proposals } from "@internet-privacy/marmot-ts";

// Builders that return several proposals are resolved against the current
// state first, then committed.
const context = group.session.proposalContext();

// Remove a member (admins only)
const removals = await Proposals.proposeRemoveUser(memberPubkey)(context);
await client.groups.commit(group.id, { extraProposals: removals });

// Update metadata
const updates = await Proposals.proposeUpdateMetadata({ name: "New name" })(
  group.session.proposalContext(),
);
await client.groups.commit(group.id, { extraProposals: updates });
```

A standalone (uncommitted) proposal can be broadcast with `group.propose(action)` / `group.sendProposal(proposal)`, and a key rotation with `group.selfUpdate()`.

## Founding Welcome delivery and retry

When a group is founding-created with `invitees` (see [`client.groups.create`](/client/marmot-client#founding-creation-with-initial-invitees)), each invitee's Welcome is delivered independently and the outcome is exposed as discoverable state on the group — `create()` itself never throws on a failed delivery:

```typescript
group.welcomeDeliveries; // every attempted delivery, in order: { kind: "succeeded" | "failed", recipient, ... }[]
group.pendingWelcomes; // the failed subset still needing delivery
```

A delivery counts as `succeeded` only when **at least one relay acknowledged** the gift-wrapped Welcome (`ok: true`). A publish that every relay rejected — auth-required, rate-limited, blocked, or otherwise — is reported as `failed`, appears in `pendingWelcomes`, and is re-published by `retryWelcome`, even though the underlying publish call itself did not throw. The same rule applies to the per-recipient Welcome outcomes of an ordinary invite (`GroupRuntime`'s `welcomeDelivery.outcomes`).

Check `pendingWelcomes` after a founding create and retry each entry:

```typescript
for (const outcome of group.pendingWelcomes) {
  await group.retryWelcome(outcome.recipient.pubkey);
}
```

`retryWelcome(pubkey)` semantics:

- An unknown `pubkey` (never an invitee of this founding create) throws — it fails loudly rather than silently no-opping.
- A `pubkey` whose Welcome already succeeded returns the existing outcome unchanged, without re-publishing.
- Concurrent calls for the same retained recipient obligation share one delivery; different recipients proceed independently.
- A settled failure clears that obligation's in-flight attempt. A later explicit call retries it; no automatic retry loop is started.
- Success is retained monotonically: a later failing founding fanout or retry cannot replace it. Sharing and settlement are bound to the encoded Welcome, author, recipient pubkey and KeyPackage event id; a changed obligation proceeds separately, and older completions cannot overwrite it.
- The report is **not persisted**: `welcomeDeliveries` / `pendingWelcomes` are in-memory only and empty again after a restart or a fresh load of the group, even though the invitee remains a member who was never told.

While the group remains loaded, explicitly retry its failed retained Welcome
obligations. After a restart or fresh load, a missing report cannot reconstruct
that outbound work: re-invite the member with a **fresh KeyPackage** against the
now-canonical group ([`protocol-core/publish-lifecycle.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/publish-lifecycle.md)).
The original consumed KeyPackage material is not restorable. These retry and
success guarantees are process-local to the retained obligation, without
cross-process coordination or a durable outbound journal.

## Events

`MarmotGroup` extends `EventEmitter`. Available events:

| Event                | Payload                              | Fires when                                                                          |
| -------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `applicationMessage` | `Uint8Array`                         | A decrypted application message is received                                         |
| `stateChanged`       | `ClientState`                        | Group state advances (commit, proposal, message)                                    |
| `stateSaved`         | `MarmotGroup`                        | State was persisted to the store                                                    |
| `removed`            | `MarmotGroup`                        | A non-disband removal of **this** member is realized; consumed-attempt limits apply |
| `destroyed`          | `MarmotGroup`                        | The group's local state was destroyed                                               |
| `disbanded`          | `(MarmotGroup, GroupDisbandedEvent)` | Canonical terminal disband is realized; consumed-attempt limits apply               |
| `historyError`       | `Error`                              | Best-effort history persistence failed (non-blocking)                               |
| `historyChanged`     | `MarmotGroup`                        | Ingest grew the fork-history tree (see [Fork History](/client/fork-history))        |

```typescript
group.on("removed", (g) => {
  // Mark membership inactive in your UI. Keep retained recovery material
  // if you want canonical branch supersession to restore membership.
  console.log(g.idStr, g.status);
});
```

## Recovering commit publication

A commit becomes canonical only after a relay accepts its signed event with a positive NIP-01 `OK`. The OpenTUI adapter returns on the first acceptance while continuing attempts to every selected relay; a slow relay no longer delays admin changes after another has accepted them. A returned response map contains the responses available at that point, rather than necessarily every target.

If the transport throws after publication could have started, or reports a failure with `uncertain: true`, the group keeps the original signed event, relay targets and pending MLS state. It throws `PublicationUncertainError` and remains `PendingPublish`. Own-event echoes do not count as acknowledgments. Retry the retained obligation rather than preparing another commit:

```ts
import { PublicationUncertainError } from "@internet-privacy/marmot-ts/client";

try {
  await client.groups.commit(group.id, options);
} catch (error) {
  if (!(error instanceof PublicationUncertainError)) throw error;
  await group.retryPendingPublication();
}
```

The retry publishes the same event, applies the exact pending state after acceptance, and resumes held inbound messages. Concurrent retries share one attempt. A later rejection cannot erase an earlier uncertain delivery. Cancellation after an external attempt cannot discard that uncertainty. A definitive initial rejection still follows the normal publication-failure rule.

Pending commit records, including private MLS state, live in `rewindStore`; use the same storage protections as for `groupStateStore`. With a durable store, loading restores the pending gate before admitting inbound or outbound work. The TUI attempts recovery when attaching a loaded group and retries an uncertain admin change once; custom clients can call `retryPendingPublication()` after loading or reconnecting. New facade sends attempt outstanding recovery before preparing fresh work. Without `rewindStore`, recovery records are in memory and do not survive unload or process exit. Corrupt or mismatched records fail loading rather than silently discarding possibly published work.

These rules follow Marmot's [publish lifecycle](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/publish-lifecycle.md), [durability boundaries](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/durability.md), and [Nostr acknowledgment and fanout rules](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md#publish-targets-and-acknowledgements). No wire encoding or admin authorization changes are involved. The reference review used MDK `d274dd22`; the local regression tests exercise this library and loopback Nostr relays, rather than claiming a new Android-device test.

## Session and runtime

For advanced integrations, `group.session` (a [`GroupSession`](https://github.com/marmot-protocol/marmot-ts/blob/master/src/client/session/group-session.ts)) is the protocol-state owner and `group.runtime` is the transport publisher. The facade methods delegate to these. Prefer the facade and manager APIs unless you are building a custom transport or persistence layer — in which case see the [Engine module](/guide/architecture#engine-module).

## Next steps

- **[Proposals](/client/proposals)** — building add/remove/metadata proposals
- **[History](/client/history)** — persisting and querying messages
- **[MarmotClient](/client/marmot-client)** — lifecycle and the manager APIs

## Encrypted attachments

Use [encrypted media v2](../core/media.md) to configure group media policy,
prepare source-bound attachments, and fetch/decrypt received files. Preserve the
`expectedParent` on prepared send intents; a changed source requires fresh
encryption and upload. Historical v1 helpers remain explicitly versioned.
