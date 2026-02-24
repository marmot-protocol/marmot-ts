# History

Optional message storage with querying and pagination.

## GroupRumorHistory

Stores decrypted application messages as rumors.

### Creating History

```typescript
import { GroupRumorHistory } from "@internet-privacy/marmots/client";

const history = new GroupRumorHistory(groupId, backend);

// Or create factory for MarmotClient
const factory = GroupRumorHistory.makeFactory(
  (groupId) => new MyBackend(groupId),
);

const client = new MarmotClient({
  // ...
  groupHistoryFactory: factory,
});
```

### Querying Messages

```typescript
// Query with Nostr filters
const rumors = await group.history?.queryRumors({
  kinds: [1],
  authors: [pubkey],
  since: timestamp,
  limit: 50,
});
```

### Paginated Loading

```typescript
// Create paginated loader
const loader = group.history?.createPaginatedLoader({
  kinds: [1],
  limit: 20,
});

// Load pages
for await (const page of loader) {
  displayMessages(page);
  if (shouldStop) break;
}
```

### Purging History

```typescript
await group.history?.purgeMessages();
```

## Custom History Backends

Implement `BaseGroupHistory`:

```typescript
interface BaseGroupHistory {
  saveMessage(message: MLSMessage): Promise<void>;
  saveRumor(rumor: Rumor): Promise<void>;
  queryRumors(filter: NostrFilter): Promise<Rumor[]>;
  createPaginatedLoader(filter: NostrFilter): AsyncGenerator<Rumor[]>;
  purgeMessages(): Promise<void>;
}
```

### Example Backend

```typescript
class MyCustomHistory implements BaseGroupHistory {
  async saveRumor(rumor: Rumor) {
    await db.insert("rumors", rumor);
  }

  async queryRumors(filter: NostrFilter) {
    return db.query("rumors", filter);
  }

  async *createPaginatedLoader(filter: NostrFilter) {
    let offset = 0;
    const limit = filter.limit || 20;

    while (true) {
      const page = await db.query("rumors", { ...filter, offset, limit });
      if (page.length === 0) break;
      yield page;
      offset += limit;
    }
  }

  async purgeMessages() {
    await db.delete("rumors", { groupId: this.groupId });
  }
}
```

## History Events

```typescript
group.on("historyError", ({ error }) => {
  console.error("Non-blocking history error:", error);
});
```

History failures don't prevent message processing.
