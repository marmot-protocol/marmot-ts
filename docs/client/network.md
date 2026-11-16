# Network interface

Marmot never opens relay connections itself. You give `MarmotClient` a `NostrNetworkInterface` adapter over your relay library, and every manager and group uses it to publish, fetch and subscribe.

## The contract

```typescript
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";

interface NostrNetworkInterface {
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;
  request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]>;
  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<NostrEvent>;
  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
```

`NostrEvent` and `Filter` are applesauce's types; nostr-tools' `Event` and `Filter` are structurally compatible. `Subscribable` is anything with `subscribe(observer)` returning `{ unsubscribe() }`, so RxJS observables fit directly.

The rules that matter:

- **`publish`** returns one `PublishResponse` (`{ from, ok, message? }`) per relay, keyed by relay URL. Report failures as `ok: false` rather than throwing. Set `uncertain: true` when a transport error means the relay might still have accepted the event.
- **`request`** is a one-shot query that resolves after EOSE. **Reject** when the relay errors, closes the request or times out. Group backfill treats a resolved empty array as "this relay has nothing more" and moves its cursor past that window. If you swallow errors and return `[]`, history is silently skipped.
- **`subscription`** emits one event per `next` for as long as the caller stays subscribed. It carries live group traffic (kind 445) and incoming invites (kind 1059).
- **`getUserInboxRelays`** returns the relays from the user's kind 10050 inbox list, which is where Welcomes are delivered. If it **throws**, the client falls back to the group's relays. If it **returns `[]`**, Welcome delivery to that user fails. Return `[]` only when you know the user has no inbox list, and throw when the lookup itself failed.

::: warning A relay ack is not delivery
`ok: true` means a relay accepted the event, not that the recipient received it. An invite sent to fallback relays is only received if the recipient also listens there. Check `group.snapshot.pendingWelcomes` for invites that are still undelivered (see [Groups](/client/groups)).
:::

## Wire up Applesauce (v7)

`applesauce-relay`'s `RelayPool` covers most of the contract. The main work is converting its responses:

```typescript
import { RelayPool } from "applesauce-relay";
import { lastValueFrom, toArray } from "rxjs";
import { getInboxRelays } from "@internet-privacy/marmot-ts";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "@internet-privacy/marmot-ts/client";

const pool = new RelayPool();
const LOOKUP_RELAYS = ["wss://purplepag.es", "wss://relay.damus.io"];

export const network: NostrNetworkInterface = {
  async publish(relays, event) {
    const responses = await pool.publish(relays, event);
    const out: Record<string, PublishResponse> = {};
    for (const { from, ok, message } of responses)
      out[from] = { from, ok, message };
    return out;
  },

  // Errors propagate, so a failed relay rejects instead of returning [].
  request(relays, filters) {
    return lastValueFrom(pool.request(relays, filters).pipe(toArray()));
  },

  subscription(relays, filters) {
    return pool.subscription(relays, filters);
  },

  async getUserInboxRelays(pubkey) {
    const events = await lastValueFrom(
      pool
        .request(LOOKUP_RELAYS, { kinds: [10050], authors: [pubkey] })
        .pipe(toArray()),
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    return latest ? getInboxRelays(latest) : [];
  },
};
```

For relays that require NIP-42 authentication, pass an `onAuthRequired` handler as the options argument to `publish`, `request` and `subscription`. The handler should call `relay.authenticate(signer)`. AUTH is only signed after a relay refuses an operation with `auth-required`, and signing it reveals the account's pubkey to that relay.

The [OpenTUI example's adapter](https://github.com/marmot-protocol/marmot-ts/blob/master/examples/opentui/src/helpers/relay-pool.ts) is a complete reference: it adds per-relay publish handling, AUTH, default relays and shutdown. When the app shuts down, unsubscribe your live subscriptions and close the pool.

## Wire up nostr-tools

```typescript
import { SimplePool } from "nostr-tools/pool";
import { getInboxRelays } from "@internet-privacy/marmot-ts";
import type {
  NostrNetworkInterface,
  PublishResponse,
} from "@internet-privacy/marmot-ts/client";

const pool = new SimplePool();
const LOOKUP_RELAYS = ["wss://purplepag.es", "wss://relay.damus.io"];

export const network: NostrNetworkInterface = {
  async publish(relays, event) {
    const settled = await Promise.allSettled(pool.publish(relays, event));
    const out: Record<string, PublishResponse> = {};
    settled.forEach((result, i) => {
      const from = relays[i];
      // SimplePool resolves connection errors as "connection failure: ..."
      const message =
        result.status === "fulfilled" ? result.value : String(result.reason);
      const ok =
        result.status === "fulfilled" &&
        !message.startsWith("connection failure:");
      out[from] = { from, ok, message: message || undefined };
    });
    return out;
  },

  async request(relays, filters) {
    const list = Array.isArray(filters) ? filters : [filters];
    const results = await Promise.all(
      list.map((f) => pool.querySync(relays, f)),
    );
    const byId = new Map(results.flat().map((e) => [e.id, e]));
    return [...byId.values()];
  },

  subscription(relays, filters) {
    const list = Array.isArray(filters) ? filters : [filters];
    return {
      subscribe(observer) {
        const subs = list.map((f) =>
          pool.subscribe(relays, f, {
            onevent: (event) => observer.next?.(event),
          }),
        );
        return { unsubscribe: () => subs.forEach((s) => s.close()) };
      },
    };
  },

  async getUserInboxRelays(pubkey) {
    const event = await pool.get(LOOKUP_RELAYS, {
      kinds: [10050],
      authors: [pubkey],
    });
    return event ? getInboxRelays(event) : [];
  },
};
```

`querySync` resolves on EOSE or timeout and does not report relay errors. If complete history matters to you, use a request path that can reject.

## Next steps

- [Storage](/client/storage): the other adapter `MarmotClient` needs
- [Messages](/client/messages): `connectAll()` uses `request` and `subscription` to keep groups in sync
- [Key packages](/client/key-packages): NIP-65 write relays and kind 10050 inbox relay helpers
