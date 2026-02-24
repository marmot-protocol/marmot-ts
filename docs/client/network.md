# Network Interface

`NostrNetworkInterface` abstracts Nostr relay operations for any client library.

## Interface

```typescript
interface NostrNetworkInterface {
  publish(relays: string[], event: NostrEvent): Promise<PublishResponse>;
  request(relays: string[], filters: NostrFilter[]): Promise<NostrEvent[]>;
  subscription(
    relays: string[],
    filters: NostrFilter[],
  ): Subscribable<NostrEvent>;
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
```

## Example: nostr-tools

```typescript
import { SimplePool } from "nostr-tools/pool";

class NostrToolsInterface implements NostrNetworkInterface {
  constructor(private pool: SimplePool) {}

  async publish(relays: string[], event: NostrEvent) {
    const results = await Promise.allSettled(this.pool.publish(relays, event));

    return {
      success: results.some((r) => r.status === "fulfilled"),
      relays: relays.filter((_, i) => results[i].status === "fulfilled"),
    };
  }

  async request(relays: string[], filters: NostrFilter[]) {
    return this.pool.querySync(relays, filters);
  }

  subscription(relays: string[], filters: NostrFilter[]) {
    const sub = this.pool.subscribeMany(relays, filters, {
      onevent: (event) => {
        /* ... */
      },
    });
    return subscriptionToObservable(sub);
  }

  async getUserInboxRelays(pubkey: string) {
    const events = await this.request(defaultRelays, [
      {
        kinds: [10002],
        authors: [pubkey],
        limit: 1,
      },
    ]);

    return extractRelaysFromEvent(events[0]);
  }
}
```

## Observable Types

```typescript
interface Subscribable<T> {
  subscribe(observer: Observer<T>): Unsubscribable;
}

interface Observer<T> {
  next(value: T): void;
  error?(error: any): void;
  complete?(): void;
}

interface Unsubscribable {
  unsubscribe(): void;
}
```

## Usage

```typescript
const client = new MarmotClient({
  // ...
  network: new NostrToolsInterface(pool),
});
```

The client uses the network interface for:

- Publishing group events (kind 445)
- Publishing key package events (kind 443)
- Fetching key packages
- Sending Welcome messages
- Discovering relay lists
