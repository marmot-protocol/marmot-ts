# Network interface

Marmot does not connect to relays itself. You pass a `NostrNetworkInterface` into `MarmotClient`; that same object is used by `KeyPackageManager`, `GroupsManager`, and each `MarmotGroup`. Event and filter types are the usual nostr shapes (e.g. nostr-tools’ `Event` and `Filter`).

## Contract

```typescript
interface NostrNetworkInterface {
  publish(
    relays: string[],
    event: Event,
  ): Promise<Record<string, PublishResponse>>;

  request(relays: string[], filters: Filter | Filter[]): Promise<Event[]>;

  subscription(
    relays: string[],
    filters: Filter | Filter[],
  ): Subscribable<Event>;

  getUserInboxRelays(pubkey: string): Promise<string[]>;
}
```

`Subscribable` is `{ subscribe(observer) → { unsubscribe() } }`; RxJS observables fit if they expose that shape.

- **`publish`** — Publish signed events to the listed relays. Return per-relay `ok` / `message` so failures surface after commits and welcomes. Used by `KeyPackageManager` (key packages, deletes) and `MarmotGroup` (MLS traffic, app messages, welcome gift wraps).

- **`request`** — One-shot REQ/EOSE-style fetch; dedupe by `id` if you merge multiple filters. Not called inside Marmot’s core MLS paths; useful on the same object for app-level discovery.

- **`subscription`** — Live updates; emit one event per `next`. Not required for core MLS flows inside the library; handy for background sync next to the client.

- **`getUserInboxRelays`** — Where `pubkey` receives wrapped welcomes (`kind` 1059). `MarmotGroup` uses this when adding members; on failure or empty list it falls back to group relays. Typical input: the recipient's inbox relay list (`kind` 10050).

## Wiring `nostr-tools`

Minimal `SimplePool` adapter sketch:

```typescript
import type { Event } from "nostr-tools";
import type { Filter } from "nostr-tools/filter";
import type {
  NostrNetworkInterface,
  PublishResponse,
  Subscribable,
  Unsubscribable,
} from "@internet-privacy/marmot-ts/client";
import { SimplePool } from "nostr-tools/pool";

const pool = new SimplePool();
const METADATA_RELAYS = ["wss://relay.damus.io"];

function dedupeById(events: Event[]): Event[] {
  const seen = new Set<string>();
  return events.filter((e) =>
    seen.has(e.id) ? false : (seen.add(e.id), true),
  );
}

export function nostrToolsNetwork(): NostrNetworkInterface {
  return {
    async publish(relays, event) {
      const out: Record<string, PublishResponse> = {};
      const pending = pool.publish(relays, event);
      await Promise.all(
        relays.map(async (url, i) => {
          try {
            const reason = await pending[i];
            const msg = String(reason);
            const softFail = msg.startsWith("connection failure:");
            out[url] = {
              from: url,
              ok: !softFail,
              message: softFail ? msg : msg || undefined,
            };
          } catch (err) {
            out[url] = {
              from: url,
              ok: false,
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return out;
    },

    async request(relays, filters) {
      const list = Array.isArray(filters) ? filters : [filters];
      const all: Event[] = [];
      for (const f of list) {
        all.push(...(await pool.querySync(relays, f)));
      }
      return dedupeById(all);
    },

    subscription(relays, filters): Subscribable<Event> {
      const list = Array.isArray(filters) ? filters : [filters];
      return {
        subscribe(observer): Unsubscribable {
          const subs = list.map((f) =>
            pool.subscribe(relays, f, {
              onevent(ev) {
                observer.next?.(ev);
              },
            }),
          );
          return { unsubscribe: () => subs.forEach((s) => void s.close()) };
        },
      };
    },

    async getUserInboxRelays(pubkey) {
      const ev = await pool.get(METADATA_RELAYS, {
        kinds: [10002],
        authors: [pubkey],
        limit: 1,
      });
      if (!ev) return [];
      return ev.tags.filter((t) => t[0] === "r" && t[1]).map((t) => t[1]!);
    },
  };
}
```

Tune relay lists and `getUserInboxRelays` to match how you resolve NIP-65 vs key-package relay lists in production.
