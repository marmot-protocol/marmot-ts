# The Ingest Pipeline

When building a decentralized app on Nostr, your clients constantly receive events over WebSocket streams. `marmot-ts` handles incoming Nostr events targeted at a specific group via the `MarmotGroup.ingest(events: NostrEvent[])` method.

Because these events arrive unverified, from untrusted sources, and potentially out of order, the `ingest()` method is heavily fortified. It implements dual-layer decryption, automatic retry loops, and error shielding to prevent simple malformed packets from creating Denial of Service (DoS) states on your client.

## Dual-Layer Decryption (MIP-01)

An incoming Marmot Group Event (Kind `445`) is processed in two steps:

1. **Outer Transport Layer:** The event is NIP-44 authenticated and decrypted using a symmetric "exporter secret" derived from the current active MLS Epoch. If the decryption fails, the event is immediately discarded. This shields the expensive MLS engine from processing spam.
2. **Inner MLS Layer:** The decrypted binary payload is passed to the core `ts-mls` engine (`state.processMessage`). This layer advances the epoch, modifies the state tree, or extracts an application message.

## Using `ingest()`

The `ingest()` function is an `AsyncGenerator`. As you pass it a list of raw Nostr events, it yields results sequentially as they successfully parse through the dual layers.

```typescript
const incomingEvents: NostrEvent[] = [
  /* ... fetched from relay ... */
];

// The generator starts processing the events
const results = group.ingest(incomingEvents);

for await (const result of results) {
  // result is a ProcessMessageResult type

  if (result.kind === "applicationMessage") {
    // We've successfully processed a data packet
    const messageBytes = result.message;
    console.log(`New incoming data: ${bytesToHex(messageBytes)}`);
  }

  if (result.kind === "commit") {
    // A group state mutation (e.g. member added/removed) occurred
    console.log("The group state advanced to a new epoch.");
  }
}
```

### Unreadable Events & Retry Logic

Because Nostr relays offer no strict global ordering guarantees, it's very common to receive MLS Messages "from the future" (i.e. messages encrypted for Epoch 10 when you are currently at Epoch 9).

If the inner MLS Layer throws an error (e.g. "invalid epoch"), the `ingest()` method assumes the message might be resolvable later. It categorizes the event as **"unreadable"**.

1. The generator completes processing all readable events in the batch.
2. It recursively calls itself with the remaining "unreadable" events.
3. This loop repeats up to `maxRetries` (default: 5) times.

If after 5 loops an event is still unreadable, it is permanently dropped.

```typescript
// Customizing the retry logic
const results = group.ingest(incomingEvents, {
  maxRetries: 10, // Increase robustness on flaky connections
});
```

### DoS Protection

It is critical that `ingest()` never throws an unhandled exception to the caller for malformed network data.

> "IMPORTANT: ingest() processes untrusted network input. If we throw here, a single permanently-unreadable message (e.g. encrypted under an epoch we can never decrypt, malformed ciphertext, spam) can DoS consumers."

Instead of throwing, the library swallows the network parsing errors and silently discards the malicious/broken payload during its retry loop.

---

Finally, check out the [Examples](examples.md) for quick-start snippets utilizing these concepts.
