# Key Package Distribution

Key packages are published as Nostr events so others can add you to groups.

## Key Package Events (Kind 30443)

### Creating Key Package Events

```typescript
import { createKeyPackageEvent } from "@internet-privacy/marmot-ts";

const event = await createKeyPackageEvent({
  keyPackage: keyPackage.publicPackage,
  identifier: "my-app-desktop",
  relays: ["wss://relay1.com", "wss://relay2.com"],
  client: "my-app-v1.0", // Optional client identifier
});

// Sign and publish to relays
const signed = await signer.signEvent(event);
await network.publish(["wss://relay1.com", "wss://relay2.com"], signed);
```

### Event Structure

```
kind: 30443
content: base64-encoded KeyPackage
tags:
  - ["d", "my-app-desktop"]
  - ["mls_protocol_version", "1.0"]
  - ["mls_ciphersuite", "0x0001"]
  - ["mls_extensions", "0xf2ee", "0x000a"]
  - ["relays", ...urls]
  - ["client", "client-name"] (optional)
  - ["encoding", "base64"]
```

### Extracting Key Packages

```typescript
import { getKeyPackage } from "@internet-privacy/marmot-ts";

// Fetch from relays
const events = await fetchEvents(relays, {
  kinds: [30443, 443],
  authors: [targetPubkey],
  limit: 1,
});

// Extract key package
const keyPackage = getKeyPackage(events[0]);
```

### Deleting Key Packages

```typescript
import { createDeleteKeyPackageEvent } from "@internet-privacy/marmot-ts";

// Create kind 5 deletion event
const deleteEvent = createDeleteKeyPackageEvent({
  events: [keyPackageEvent],
});

const signedDeleteEvent = await signer.signEvent(deleteEvent);
await network.publish(relays, signedDeleteEvent);
```

## Relay List Events (NIP-65, Kind 10002)

Marmot discovers where to publish and fetch an account's key packages from its
NIP-65 relay list. There is no dedicated key-package relay list, and kind 30443
key-package events do not repeat their relays.

### Creating Relay Lists

```typescript
import { createNip65RelayListEvent } from "@internet-privacy/marmot-ts";

const eventTemplate = createNip65RelayListEvent({
  pubkey: myPubkey,
  relays: ["wss://relay.damus.io", "wss://relay.snort.social", "wss://nos.lol"],
});

const signed = await signer.signEvent(eventTemplate);
await network.publish(relays, signed);
```

### Reading Relay Lists

```typescript
import {
  getNip65Relays,
  isValidNip65RelayListEvent,
} from "@internet-privacy/marmot-ts";

// Fetch the account's NIP-65 relay list
const events = await fetchEvents(relays, {
  kinds: [10002],
  authors: [targetPubkey],
  limit: 1,
});

if (isValidNip65RelayListEvent(events[0])) {
  const relays = getNip65Relays(events[0]);
  // Fetch key packages from these relays
}
```

> Welcomes are delivered separately, to a recipient's **inbox** relay list
> (kind 10050). Use `getInboxRelays` / `createInboxRelayListEvent` for that set.

## Discovery Flow

1. **Publish Relay List:** User publishes a NIP-65 (kind 10002) relay list
2. **Discover Relays:** Others fetch the account's NIP-65 list
3. **Publish Key Packages:** User publishes kind 30443 to their NIP-65 relays
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
