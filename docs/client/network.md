# Network interface

Marmot does not connect to relays itself. You pass a `NostrNetworkInterface` into `MarmotClient`; that same object is used by `KeyPackageManager`, `GroupsManager`, and each `MarmotGroup`. Event and filter types are applesauce's `NostrEvent` and `Filter`; nostr-tools' `Event` and `Filter` are structurally compatible.

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

- **`publish`** — Publish signed events to the listed relays. Return per-relay `ok` / `message` so failures surface after commits and welcomes. Used by `KeyPackageManager` (key packages, deletes), each group's `GroupRuntime` (MLS traffic, app messages), and Welcome delivery (gift wraps).

- **`request`** — One-shot REQ until EOSE; dedupe by `id` if you merge multiple filters. Used by `client.groups.connect()` / `connectAll()` to backfill a group's kind 445 history, one relay and one `limit`-sized page per call. Reject the promise when the relay fails, closes the request, or times out: a resolved empty array means the relay holds nothing more in that window, and the backfill records it as read. The client keeps at most `limit` events of each response, but the adapter receives every response whole: to bound memory against a relay that ignores `limit`, stop collecting in the adapter once it has `limit` events. A backfill can hold up to `backfillPageSize * backfillMaxPages` events per relay in memory (about 25,000 with the defaults); see [Bounded backfill](/client/marmot-client#bounded-backfill) for tuning them on mobile.

- **`subscription`** — Live updates; emit one event per `next`. Used by `client.groups.connect()` / `connectAll()` for live kind 445 traffic and by `client.invites.listen()`.

- **`getUserInboxRelays`** — Where `pubkey` receives gift-wrapped Welcomes (kind 1059), read from their kind 10050 `relay` tags. Welcome delivery calls it for each invitee. If it **throws**, delivery falls back to the group's relays. If it returns an **empty list**, delivery for that invitee fails and is reported as a failed Welcome outcome. Return `[]` only when the user really has no inbox list.

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
import { getInboxRelays } from "@internet-privacy/marmot-ts";
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
        kinds: [10050],
        authors: [pubkey],
        limit: 1,
      });
      if (!ev) return [];
      return getInboxRelays(ev);
    },
  };
}
```

KeyPackage discovery uses the account's kind 10002 NIP-65 write relays (`getNip65Relays(event, "write")`); Welcome delivery uses kind 10050 inbox relays (`getInboxRelays(event)`). See [`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md).

## Connecting groups

`await client.groups.connect(groupId, options?)` backfills kind 445 events, fully drains that batch, then installs a live subscription. It returns an `Unsubscribable`. `client.groups.connectAll(options?)` returns its handle immediately and follows the set of loaded groups, starting and stopping their connections as groups are loaded, joined, removed, or unloaded.

Both APIs accept `{ signal?: AbortSignal, fallbackRelays?: string[] }`, plus the backfill bounds `backfillSlackSeconds`, `backfillPageSize` and `backfillMaxPages` (see [Bounded backfill](/client/marmot-client#bounded-backfill)). Group relays take precedence over fallback relays; groups with neither are skipped. Use an `AbortSignal` to stop a direct connection while its backfill request is still pending:

```typescript
const controller = new AbortController();
const pendingConnection = client.groups.connect(group.id, {
  signal: controller.signal,
});

// On application teardown, even before pendingConnection resolves:
controller.abort();
const connection = await pendingConnection;
connection.unsubscribe(); // also safe after abort
```

Cancellation stops intake; it does not cancel the network adapter's outstanding `request` promise. When that request resolves, cancelled backfill is not admitted and no live subscription is installed. `connectAll().unsubscribe()` also cancels connections whose backfill is pending.

### Serialization and disconnect

Backfill and live events enter one queue per group, shared by every connection handle for that group. Each admitted batch's `ingest()` generator is completely drained before the next starts. A failed batch does not permanently stall the queue, and another group can proceed independently. Signature verification and exact singleton `h` routing validation precede insertion into the shared bounded dedup cache.

`unsubscribe()` or abort closes intake immediately. Already admitted batches still run and finish reconciliation; their results remain observable while they drain. The result listener is released when no connection or admitted work remains. The unsubscribe handle is synchronous and supplies no promise for drain completion. Keep application result handlers alive while observing that final work.

This queue covers manager-owned connection intake. If you also call `group.ingest()` directly, serialize those calls with your other operations and consume every yielded result before starting another batch; an abandoned generator has not completed ingestion.

### Connection results and invalidation

Subscribe before connecting:

```typescript
client.groups.on("ingestResult", (groupId, result) => {
  if (result.kind === "invalidated") {
    recordForkRetraction(groupId, {
      rumorId: result.rumorId,
      transportId: result.transportId,
      losingTag: result.tag,
      losingEpoch: result.epoch,
      producingCommit: result.commitDigest,
    });
  }
});
const connections = client.groups.connectAll();
```

The manager forwards the facade's reconciled result once per connected group, including live, timer-driven, and explicit convergence results. Consuming ingest yields does not produce a second manager notification. Existing `unreadable` and trust-boundary `rejected` events remain available.

For `invalidated`, `rumorId` is the strict canonical inner rumor ID; `transportId` is the signed envelope ID and `event` retains that envelope. `payload` contains decrypted application bytes, and `message` contains the MLS application message. `tag` and `epoch` name the losing delivery state. Optional `commitDigest: Uint8Array` identifies the edge that produced that losing state. It never identifies the commit that triggered reconciliation or the winning branch; root states have no producing commit. The optional fields preserve compatibility, so consumers must handle absent evidence.

Supported history removal completes before the public result when persistence succeeds. Backend errors emit `historyError` and preserve the invalidation and pending retry evidence. Restart attribution requires persisted ingestion state and rewind history; plaintext history alone is insufficient. See [History](/client/history#fork-invalidated-messages) for custom-store migration and failure handling.

## Cancellable group watches

`client.groups.watch({ signal })` yields fresh group-list arrays. Abort finishes an idle or loading watch promptly without waiting for an update. Returning the iterator also wakes a pending `next()` before completion and removes listeners; `throw()` and async disposal perform the same cleanup. A storage request already in progress may finish later, with its rejection handled. Updates arriving during loading or between pulls remain pending for a later snapshot.

```typescript
const controller = new AbortController();
const updates = client.groups.watch({ signal: controller.signal });
const observing = (async () => {
  for await (const groups of updates) renderGroups(groups);
})();

// On view teardown:
controller.abort();
await observing;
```

## Production convergence policy

Keep the existing finite profile-1 default (`maxRewindCommits: 5`) for production unless you have deliberately chosen another bounded horizon. Configure a policy at the client boundary to pass it to groups. The horizon controls rollback eligibility; it does not promise complete pruning of every full-history tree or plaintext history record.

`maxRewindCommits: Infinity` is an explicit debugging or forensic choice that keeps arbitrarily old forks eligible and can retain unbounded evidence. It is not production guidance. Broader history-tree, delivery-evidence, and memory-retention pruning remains separate work. See [`protocol-core/convergence.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/convergence.md) and [`protocol-core/retained-history.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/retained-history.md).
