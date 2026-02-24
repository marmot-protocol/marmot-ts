# Key Package Distribution

Key packages are published as Nostr events so others can add you to groups.

## Key Package Events (Kind 443)

### Creating Key Package Events

```typescript
import { createKeyPackageEvent } from "@internet-privacy/marmots/core";

const event = createKeyPackageEvent({
  keyPackage: keyPackage.publicPackage,
  relays: ["wss://relay1.com", "wss://relay2.com"],
  client: "my-app-v1.0", // Optional client identifier
});

// Sign and publish to relays
const signed = signEvent(event);
await publishToRelays(signed, relays);
```

### Event Structure

```
kind: 443
content: base64-encoded KeyPackage
tags:
  - ["mls_protocol_version", "1.0"]
  - ["mls_ciphersuite", "0x0001"]
  - ["mls_extensions", "0xf2ee", "0x000a"]
  - ["relays", ...urls]
  - ["client", "client-name"] (optional)
  - ["encoding", "base64"]
```

### Extracting Key Packages

```typescript
import { getKeyPackage } from "@internet-privacy/marmots/core";

// Fetch from relays
const events = await fetchEvents(relays, {
  kinds: [443],
  authors: [targetPubkey],
  limit: 1,
});

// Extract key package
const keyPackage = getKeyPackage(events[0]);
```

### Deleting Key Packages

```typescript
import { createDeleteKeyPackageEvent } from "@internet-privacy/marmots/core";

// Create kind 5 deletion event
const deleteEvent = createDeleteKeyPackageEvent(
  keyPackageEventId,
  "Key package consumed", // Optional reason
);

await publishEvent(signEvent(deleteEvent), relays);
```

## Relay List Events (Kind 10051)

Tell others where to find your key packages.

### Creating Relay Lists

```typescript
import { createKeyPackageRelayListEvent } from "@internet-privacy/marmots/core";

const event = createKeyPackageRelayListEvent([
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://nos.lol",
]);

// Sign and publish
await publishEvent(signEvent(event), relays);
```

### Reading Relay Lists

```typescript
import {
  getKeyPackageRelayList,
  isValidKeyPackageRelayListEvent,
} from "@internet-privacy/marmots/core";

// Fetch user's relay list
const events = await fetchEvents(relays, {
  kinds: [10051],
  authors: [targetPubkey],
  limit: 1,
});

if (isValidKeyPackageRelayListEvent(events[0])) {
  const relays = getKeyPackageRelayList(events[0]);
  // Fetch key packages from these relays
}
```

## Discovery Flow

1. **Publish Relay List:** User publishes kind 10051 to well-known relays
2. **Discover Relays:** Others fetch the relay list
3. **Publish Key Packages:** User publishes kind 443 to their relay list
4. **Fetch Key Packages:** Others fetch from the discovered relays
5. **Add to Group:** Use key package to create add proposal

## Best Practices

### Relay Selection

- Use 3-5 relays for redundancy
- Mix popular and niche relays
- Update relay list when changing relays

### Key Package Lifecycle

- Publish new key packages regularly (after use)
- Delete old key packages after consumption
- Keep last_resort packages available

### Privacy Considerations

- Key packages are public (anyone can see)
- Don't include sensitive info in client field
- Rotate key packages periodically

## Related

- [Key Packages](./key-packages) - Generating key packages
- [Protocol](./protocol) - Event kinds and constants
