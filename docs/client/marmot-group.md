# MarmotGroup

`MarmotGroup` represents a single MLS group and handles all group-level operations.

## Properties

```typescript
group.id; // MLS group_id (Uint8Array)
group.idStr; // MLS group_id (hex)
group.groupData.nostrGroupId; // MarmotGroupData nostr_group_id (Uint8Array)
group.name; // Group name
group.description; // Group description
group.relays; // Relay URLs
group.adminPubkeys; // Admin pubkeys
group.members; // Member pubkeys (from current state)
group.epoch; // Current epoch
group.state; // ClientState
group.history; // Optional history instance
```

## Sending Messages

```typescript
await group.sendApplicationRumor({
  kind: 1,
  content: "Hello, group!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
  pubkey: myPubkey,
  id: rumorId,
});
```

## Creating Proposals

```typescript
import { Proposals } from "@internet-privacy/marmots";

// Invite user
await group.propose(Proposals.proposeInviteUser(keyPackageEvent));

// Remove user
await group.propose(Proposals.proposeRemoveUser(targetPubkey));

// Update metadata
await group.propose(
  Proposals.proposeUpdateMetadata({
    name: "New Name",
    description: "New Description",
  }),
);
```

## Making Commits

```typescript
// Commit pending proposals
await group.commit();

// Commit with inline proposals
await group.commit({
  extraProposals: [
    Proposals.proposeInviteUser(kpEvent1),
    Proposals.proposeInviteUser(kpEvent2),
  ],
});
```

## Inviting by Key Package

```typescript
const recipients = await group.inviteByKeyPackageEvent(keyPackageEvent);
// Welcome messages sent automatically
```

## Processing Events

```typescript
// Fetch and process group events
const events = await network.request(groupRelays, {
  kinds: [GROUP_EVENT_KIND],
  "#h": [bytesToHex(group.groupData.nostrGroupId)],
});

const results = group.ingest(events);

for await (const result of results) {
  // Handle commits, application messages, and unreadable packets
}
```

### How Ingest Works

The `ingest()` method processes untrusted Nostr events through **dual-layer decryption**:

1. **Outer Layer (NIP-44):** Events are decrypted using a symmetric key derived from the current MLS epoch. This shields the MLS engine from spam—malformed packets fail fast.
2. **Inner Layer (MLS):** Valid payloads are processed by `ts-mls` to advance state, update membership, or extract application messages.

**Out-of-Order Messages:** Nostr relays provide no ordering guarantees. When receiving "future" messages (encrypted for a later epoch), `ingest()` categorizes them as **unreadable** and retries after processing other events. This continues up to `maxRetries` (default: 5).

**DoS Protection:** `ingest()` never throws on malformed network data. Bad packets are silently discarded to prevent permanently-broken messages from crashing your client.

## Events

```typescript
group.on("stateChanged", ({ state }) => {
  /* ... */
});
group.on("applicationMessage", ({ rumor }) => {
  /* ... */
});
group.on("stateSaved", ({ groupId }) => {
  /* ... */
});
group.on("historyError", ({ error }) => {
  /* ... */
});
group.on("destroyed", ({ groupId }) => {
  /* ... */
});
```

## State Management

```typescript
// Save manually
await group.save();

// Destroy
await group.destroy();
```
