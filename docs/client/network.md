# Network interface

Marmot never opens relay connections itself. You give `MarmotClient` a `NostrNetworkInterface` adapter over your relay library, and every manager and group uses it to publish, fetch and subscribe.

## The contract

```typescript
import type {
  NostrNetworkInterface,
  BackfillOptions,
  BackfillResult,
  PublishResponse,
  Subscribable,
} from "@internet-privacy/marmot-ts/client";

interface NostrNetworkInterface {
  publish(
    relays: string[],
    event: NostrEvent,
  ): Promise<Record<string, PublishResponse>>;
  request(relays: string[], filters: Filter | Filter[]): Promise<NostrEvent[]>;
  backfill?(
    relays: string[],
    filter: Filter,
    options?: BackfillOptions,
  ): Promise<BackfillResult>;
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
- **`backfill`** optionally owns exhaustive history retrieval. Use negentropy, pagination or another strategy, and report completeness for each relay. When absent, Marmot retains its paginated `request` fallback.
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

The [OpenTUI example's adapter](https://github.com/marmot-protocol/marmot-ts/blob/master/examples/opentui/src/helpers/relay-pool.ts) is a complete reference: it adds sync-loader backfill, per-relay publish handling, AUTH, default relays and shutdown. When the app shuts down, unsubscribe your live subscriptions and close the pool.

## Exhaustive backfill

Implement `backfill` to replace Marmot's pagination without changing its validation, MLS ingestion or durable cursor handling:

```typescript
interface BackfillOptions {
  signal?: AbortSignal;
}

interface BackfillResult {
  events: NostrEvent[];
  relays: RelayBackfillResult[];
}

type RelayBackfillResult = {
  relay: string;
  eventIds: string[];
} & (
  | { status: "complete" }
  | { status: "incomplete"; reason?: string }
  | { status: "failed"; error?: unknown }
  | { status: "skipped"; reason?: string }
);
```

- Return an outcome for every requested relay, using the exact requested URL. `eventIds` identifies returned events retrieved from, or confirmed present on, that relay.
- Report `complete` only after exhausting the filter's range. A timeout, skipped relay, truncated timestamp boundary or ended stream is not proof of completeness. Partial failures should preserve events retrieved successfully.
- Include relevant cached events used during reconciliation: being in your cache does not mean Marmot durably ingested them. Deduplicate only verified copies so an invalid event cannot hide a genuine copy.
- Stop underlying requests and reject on abort. Treat `filter.limit` as a page-size hint, not a total history cap.

Marmot currently calls this once per relay with that relay's `since` range, merges the results, verifies and ingests the backlog, then advances safe cursors for completed relays. Missing provenance or out-of-range responses do not advance cursors. Incomplete relays are retried on later connects. Authentication, page sizes, concurrency and retry policy belong to the adapter; `backfillPageSize` and `backfillMaxPages` configure only the legacy fallback. `fetchPagedBackfill` is also exported from the client entrypoint for adapters that want to reuse that implementation; it returns its richer pagination-specific result rather than `BackfillResult`.

The example's [sync adapter](https://github.com/marmot-protocol/marmot-ts/blob/master/examples/opentui/src/helpers/sync-backfill.ts) uses Applesauce's `createSyncLoader`: NIP-77 when supported, paginated requests otherwise. It reads per-relay terminal states instead of treating `status.done` as success. Fresh stores per relay/run prevent cached-but-uningested events from disappearing on retry; these stores are temporary ciphertext inventories, separate from the UI's discovery store.

Applesauce's current request fallback steps past the oldest timestamp of each page and can miss other events in that second. The example therefore reports `incomplete` if a request page is full or the relay's cap is unknown, even when the loader reports completion. Retrieved events are still ingested, but the cursor stays put. Successful NIP-77 runs and short request pages under a known cap can establish completeness.

Reconciliation still honors the requested `since` boundary. This change preserves Marmot's cursor-and-overlap policy; unlike MDK's route-local retention-window reconciliation, it does not introduce a separate full-history repair policy for older, backdated events (see MDK's `docs/marmot-architecture/relay-delivery-telemetry.md`, “Backfill and reconciliation”).

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
- [Messages](/client/messages): `connectAll()` uses backfill and subscriptions to keep groups in sync
- [Key packages](/client/key-packages): NIP-65 write relays and kind 10050 inbox relay helpers
