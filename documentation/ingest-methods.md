# The Ingest Pipeline

When building a decentralized app on Nostr, your clients constantly receive events over WebSocket streams. `marmot-ts` handles incoming Nostr events targeted at a specific group via the `MarmotGroup.ingest(events: NostrEvent[])` method.

Because these events arrive unverified, from untrusted sources, and potentially out of order, `ingest()` is heavily fortified. It implements dual-layer decryption, automatic retry loops, and error shielding to prevent malformed packets from creating Denial of Service (DoS) states on your client.

## Dual-Layer Decryption (MIP-01)

An incoming Marmot Group Event (kind `445`) is processed in two stages:

1. **Outer Transport Layer:** the event's NIP-44 payload is decrypted using the symmetric "exporter secret" derived from the current MLS epoch. If decryption fails, the event is held back for possible retry after state advances — this shields the MLS engine from spending work on spam.
2. **Inner MLS Layer:** the decrypted binary payload is passed to the core `ts-mls` engine (`processMessage`). This layer advances the epoch, mutates the state tree, or extracts an application message.

## Using `ingest()`

`ingest()` is an `AsyncGenerator<IngestResult>`. As you pass it a list of raw Nostr events it yields one `IngestResult` per event, describing whether that event was processed, skipped, rejected by the admin-policy callback, or was ultimately unreadable:

```ts
type IngestResult =
  | {
      kind: "processed";
      result: ProcessMessageResult;
      event: NostrEvent;
      message: MlsMessage;
    }
  | {
      kind: "rejected";
      result: ProcessMessageResult;
      event: NostrEvent;
      message: MlsMessage;
    }
  | {
      kind: "skipped";
      event: NostrEvent;
      message: MlsMessage;
      reason: "past-epoch" | "wrong-wireformat" | "self-echo";
    }
  | { kind: "unreadable"; event: NostrEvent; errors: unknown[] };
```

Application messages surface inside `kind: "processed"` with `result.result.kind === "applicationMessage"` and the decrypted bytes at `result.result.message`:

```typescript
import { deserializeApplicationRumor } from "@internet-privacy/marmot-ts";

const incomingEvents: NostrEvent[] = [
  /* ... fetched from relay ... */
];

for await (const outcome of group.ingest(incomingEvents)) {
  if (outcome.kind !== "processed") continue;

  const { result } = outcome;

  if (result.kind === "applicationMessage") {
    // Decode the MLS binary payload back into a Nostr rumor
    const rumor = deserializeApplicationRumor(result.message);
    console.log(`New message from ${rumor.pubkey}: ${rumor.content}`);
  }

  if (result.kind === "newState") {
    // A commit or proposal advanced the group state (e.g. member added/removed).
    console.log(
      "Group advanced to epoch",
      group.state.groupContext.epoch.toString(),
    );
  }
}
```

`MarmotGroup` also emits a convenience `applicationMessage` event for every successfully processed application message, so you can attach a listener instead of (or in addition to) iterating the generator:

```typescript
group.on("applicationMessage", (bytes) => {
  const rumor = deserializeApplicationRumor(bytes);
  // ...render the rumor...
});
```

### Admin-only commits (MIP-03)

Commits are additionally checked against the group's `adminPubkeys` list before they advance local state. Commits from non-admins that cannot be attributed to a self-update are yielded as `{ kind: "rejected", ... }` and do **not** change group state. Proposals are always accepted (they only add to `state.unappliedProposals`).

### Unreadable Events & Retry Logic

Because Nostr relays offer no strict global ordering guarantees, it is common to receive MLS messages "from the future" (e.g. encrypted for epoch 10 while you are still at epoch 9), or to have the NIP-44 layer fail because you haven't yet processed a commit that rotated the exporter secret.

When an event can't be processed in the current round, `ingest()` treats it as **unreadable**:

1. The generator completes processing all readable events in the batch (proposals, application messages, then sorted commits).
2. If any unreadable events remain, it recursively calls itself with just those events.
3. This loop repeats up to `maxRetries` (default: 5) times.

If after `maxRetries` loops an event is still unreadable, it is yielded as `{ kind: "unreadable", event, errors }` with the full chronological list of errors captured across every attempt.

```typescript
// Customising the retry logic
for await (const outcome of group.ingest(incomingEvents, { maxRetries: 10 })) {
  if (outcome.kind === "unreadable") {
    console.warn(
      "Could not process event",
      outcome.event.id,
      outcome.errors.at(-1),
    );
  }
}
```

### DoS Protection

It is critical that `ingest()` never throws an unhandled exception for malformed network data.

> "IMPORTANT: ingest() processes untrusted network input. If we throw here, a single permanently-unreadable message (e.g. encrypted under an epoch we can never decrypt, malformed ciphertext, spam) can DoS consumers."

Instead of throwing, the library captures network / decoding errors, attaches them to the event's `unreadable` result after the retry budget is spent, and keeps the generator moving.

---

Finally, check out the [Examples](examples.md) for quick-start snippets utilising these concepts.
