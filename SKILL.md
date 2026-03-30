---
name: key-package-lifecycle
description: Handles key package lifecycle in Marmot apps: creating and publishing packages, tracking kind-443 relay events, marking consumed packages, rotating stale/used packages, and deleting via remove or purge. Use when writing code that calls client.keyPackages, manages invite readiness, replenishes key package supply, or cleans up relay-published packages.
---

# Key Package Lifecycle

## API Overview

All operations live on `client.keyPackages` (`KeyPackageManager`):

| Method | Effect |
|---|---|
| `create(options)` | Generate, store locally, sign and publish kind-443 to relays |
| `track(event)` | Record an observed kind-443 event; returns `false` if not applicable |
| `markUsed(ref)` | Flag a package as consumed without deleting it |
| `rotate(ref, options?)` | Publish kind-5 deletion for old events, create+publish replacement, remove old local material |
| `remove(ref)` | Local store deletion only — no relay cleanup |
| `purge(refs)` | Publish kind-5 deletion for all known event IDs, remove local material (bulk-friendly) |

## Core Rules

1. **Never transmit `privatePackage`** — private material stays local only.
2. **`create()` requires non-empty `relays`** — throws `MissingRelayError` otherwise.
3. **Track continuously** — feed all incoming kind-443 events to `track()` so publish records stay accurate across devices. This is required for `rotate()` and `purge()` to know which relay event IDs to delete.
4. **Prefer `rotate()` over `remove()` for published packages** — rotation cleans relays and replenishes supply atomically.
5. **`used` is rotation debt** — packages marked used should be rotated in the background, not immediately during the join flow.
6. **Relay deletion is best-effort** — kind-5 events are advisory; do not block UX on confirmation.

## App Workflow

### 1. Bootstrap supply

Publish at least two key packages on onboarding (or when inventory is low) to reduce invite race failures:

```typescript
await client.keyPackages.create({ relays, isLastResort: true });
await client.keyPackages.create({ relays, isLastResort: true });
```

### 2. Ingest relay state

Subscribe to kind `443` for the user's pubkey and feed events to the manager:

```typescript
for (const event of kind443Events) {
  await client.keyPackages.track(event); // false = not a valid key package, safe to ignore
}
```

### 3. After a group join (consumption)

`MarmotClient` calls `markUsed()` automatically when processing a Welcome. Apps should schedule rotation in the background — do not block the join flow:

```typescript
// After client.acceptInvite() resolves, rotate in background
void maintainKeyPackages(client, relays);
```

### 4. Periodic maintenance

```typescript
async function maintainKeyPackages(
  client: MarmotClient,
  relays: string[],
): Promise<void> {
  const entries = await client.keyPackages.list();

  for (const entry of entries) {
    if (entry.used) {
      await client.keyPackages.rotate(entry.keyPackageRef);
    }
  }

  if ((await client.keyPackages.count()) < 2) {
    await client.keyPackages.create({ relays, isLastResort: true });
  }
}
```

### 5. User-initiated deletion

- **Delete everywhere** (relay + local): `await client.keyPackages.purge(refs)`
- **Local only** (package was never published, or relay cleanup already handled): `await client.keyPackages.remove(ref)`

For deletion UX that operates on raw Nostr events (e.g. a relay browser), track the events first so `purge()` has the event IDs:

```typescript
for (const event of eventsToDelete) {
  await client.keyPackages.track(event);
}
const refs = eventsToDelete.map(getKeyPackageReference).filter(Boolean);
await client.keyPackages.purge(refs);
```

## Error Handling

| Error | Thrown by | Resolution |
|---|---|---|
| `MissingRelayError` | `create()` | Prompt user for relay configuration |
| `KeyPackageNotFoundError` | `rotate()` | Refresh local state; fall back to `create()` |
| `KeyPackageRotatePreconditionError` | `rotate()` | Pass `options.relays` explicitly |

If a package has no tracked `published` events, `rotate()`/`purge()` still removes local material but skips the kind-5 deletion step.
