# Best Practices

Recommended patterns for using the Client module effectively.

## When to Commit vs Propose

### Propose Only

- Coordinating with other admins
- Want others to review changes first
- Multiple proposals need coordination

### Propose + Commit Immediately

- Immediate actions (adding members, updating metadata)
- You're the only admin
- Proposals are ready to finalize

```typescript
// Propose only
await group.propose(Proposals.proposeInviteUser(kpEvent));

// Propose and commit
await group.commit({
  by: [Proposals.proposeInviteUser(kpEvent)],
});
```

## State Persistence

### Auto-Save

Groups automatically save after ingestion. No manual save needed in most cases.

### Manual Save

Save after making local changes if not committing immediately:

```typescript
await group.propose(/* ... */);
await group.save();
```

### Backup Strategy

Export all group states periodically:

```typescript
const groups = await client.loadAllGroups();
for (const [groupId, group] of groups) {
  const serialized = serializeClientState(group.state);
  await backupStorage.save(groupId, serialized);
}
```

## Relay Selection

### Group Relays

- Use 3-5 relays for redundancy
- Mix popular and niche relays
- Consider latency and geographic distribution

```typescript
const relays = [
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://nos.lol",
  "wss://relay.private.com",
];
```

### Key Package Relays

- Publish to widely-used relays for discoverability
- Update relay list (kind 10051) when changing relays

## Key Package Rotation

**When to rotate:**

- After joining a group (key package consumed)
- Periodically for security (every 30-90 days)
- After key compromise

```typescript
// Generate new key package
const newPackage = await generateKeyPackage({
  pubkey: myPubkey,
  ciphersuite: CipherSuite.MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519,
  lifetime: 7776000,
});

// Store privately
await keyPackageStore.set(ref, newPackage);

// Publish publicly
const event = createKeyPackageEvent({
  keyPackage: newPackage.publicPackage,
  relays: myRelays,
});
const signed = await signer.signEvent(event);
await network.publish(myRelays, signed);
```

## Admin Management

### Single Admin (Simple)

```typescript
const groupData = {
  adminPubkeys: [creatorPubkey],
  // ...
};
```

### Multiple Admins (Coordination Required)

```typescript
const groupData = {
  adminPubkeys: [admin1, admin2, admin3],
  // ...
};

// Admins should coordinate to avoid conflicting commits
```

### Adding/Removing Admins

```typescript
await group.commit({
  by: [
    Proposals.proposeUpdateMetadata({
      adminPubkeys: [...currentAdmins, newAdmin],
    }),
  ],
});
```

## Error Handling

### Retry Failed Operations

```typescript
async function sendWithRetry(rumor: Rumor, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await group.sendApplicationRumor(rumor);
      return;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(1000 * Math.pow(2, i));
    }
  }
}
```

### Handle Non-Blocking History Errors

```typescript
group.on("historyError", ({ error }) => {
  console.error("History save failed:", error);
  // Message still processed, only history storage failed
});
```

## Concurrency

### Group Load Deduplication

```typescript
// Multiple concurrent calls return same promise
const [group1, group2] = await Promise.all([
  client.getGroup(groupId),
  client.getGroup(groupId),
]);
assert(group1 === group2);
```

### Event Processing Order

```typescript
// Batch events for correct ordering
const allEvents = [...events1, ...events2];
await group.ingest(allEvents);
```

## Type Safety

### Generic History Types

```typescript
// No history
const client1 = new MarmotClient<undefined>({
  /* ... */
});

// With GroupRumorHistory
const client2 = new MarmotClient<GroupRumorHistory>({
  groupHistoryFactory: GroupRumorHistory.makeFactory(/* ... */),
});

// Type inference
type MyGroup = InferGroupType<typeof client2>;
```

## Performance

- **Cache groups:** Use `getGroup()` for automatic caching
- **Batch operations:** Combine multiple proposals in one commit
- **Lazy load:** Only load groups when needed
- **Paginate history:** Use `createPaginatedLoader()` for large histories
- **Async generators:** Clean up subscriptions with break/return
