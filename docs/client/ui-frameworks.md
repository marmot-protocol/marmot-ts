# UI frameworks

This page shows how to bind Marmot state to a UI. You can read **snapshots**, which are synchronous, reference-stable objects paired with a `changed` event, or consume **watchers**, which are async generators that yield new values over time. Both work in any framework.

## Async generators in 10 lines

Every `watch*()` method returns an async generator. It yields the current value immediately and then yields again on each change:

```typescript
const controller = new AbortController();

(async () => {
  for await (const packages of client.keyPackages.watchKeyPackages({
    signal: controller.signal,
  })) {
    render(packages);
  }
})();

controller.abort(); // stops the loop and removes listeners
```

The watchers you'll use most are `client.groups.watch()`, `group.watch()`, `client.keyPackages.watchKeyPackages()`, `client.invites.watchUnread()` and `client.watchInvites()`. Each one accepts `{ signal }`.

## React: snapshots with `useSyncExternalStore` (recommended)

`client.groups.snapshot` is an array of `MarmotGroupSnapshot` objects, one for each loaded group. `group.snapshot` is the snapshot of a single group. A snapshot keeps the same reference until its `changed` event fires, which is exactly what `useSyncExternalStore` expects:

```tsx
import { useCallback, useSyncExternalStore } from "react";
import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmot-ts";

export function useGroups(client: MarmotClient) {
  const subscribe = useCallback(
    (notify: () => void) => {
      client.groups.on("changed", notify);
      return () => void client.groups.off("changed", notify);
    },
    [client],
  );
  return useSyncExternalStore(subscribe, () => client.groups.snapshot);
}

export function useGroupSnapshot(group: MarmotGroup) {
  const subscribe = useCallback(
    (notify: () => void) => {
      group.on("changed", notify);
      return () => void group.off("changed", notify);
    },
    [group],
  );
  return useSyncExternalStore(subscribe, () => group.snapshot);
}

function GroupList({ client }: { client: MarmotClient }) {
  const groups = useGroups(client);
  return (
    <ul>
      {groups.map((g) => (
        <li key={g.id}>{g.groupData?.name ?? "(disbanded)"}</li>
      ))}
    </ul>
  );
}
```

The snapshot getters never read storage. They only cover loaded groups, so call `await client.groups.loadAll()` once at startup. When one group changes, the other groups keep their snapshot identity, so memoized rows don't re-render. For server rendering, also pass a `getServerSnapshot`.

For lists that live in storage, such as key packages and invites, consume a watcher inside an effect:

```tsx
function useUnreadInvites(client: MarmotClient) {
  const [invites, setInvites] = useState<UnreadInvite[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      for await (const list of client.invites.watchUnread({
        signal: controller.signal,
      }))
        setInvites(list);
    })();
    return () => controller.abort();
  }, [client]);
  return invites;
}
```

## Svelte 5

```typescript
// groups.svelte.ts
export function watchGroups(client: MarmotClient) {
  let groups = $state<MarmotGroupSnapshot[]>([]);
  $effect(() => {
    const controller = new AbortController();
    (async () => {
      for await (const list of client.groups.watch({
        includeStateChanges: true,
        signal: controller.signal,
      }))
        groups = list.map((group) => group.snapshot);
    })();
    return () => controller.abort();
  });
  return {
    get value() {
      return groups;
    },
  };
}
```

## SolidJS

```tsx
function useGroups(client: MarmotClient) {
  const [groups, setGroups] = createSignal(client.groups.snapshot);
  const update = () => setGroups(client.groups.snapshot);
  client.groups.on("changed", update);
  onCleanup(() => client.groups.off("changed", update));
  return groups;
}
```

## Vue 3

```typescript
import { onUnmounted, shallowRef } from "vue";

export function useGroups(client: MarmotClient) {
  const groups = shallowRef(client.groups.snapshot);
  const update = () => (groups.value = client.groups.snapshot);
  client.groups.on("changed", update);
  onUnmounted(() => client.groups.off("changed", update));
  return groups;
}
```

## Vanilla JavaScript

```typescript
const list = document.getElementById("groups")!;

function render() {
  list.replaceChildren(
    ...client.groups.snapshot.map((g) => {
      const li = document.createElement("li");
      li.textContent = g.groupData?.name ?? "(disbanded)";
      return li;
    }),
  );
}

client.groups.on("changed", render);
render();
```

## Cancel watchers with `signal`

Every watcher must stop when its view unmounts or the active account changes. Otherwise it keeps its listeners alive and keeps reading the old account's stores.

- Pass `{ signal }` and call `controller.abort()` during cleanup. Aborting stops the generator immediately, even while it is waiting for the next value, and removes its listeners.
- If you are iterating manually, `return()` on the generator does the same thing. A `break` inside `for await` also closes it.
- Create a fresh watcher for each mount. A generator can be consumed only once.
- `group.watch()` also ends on its own when the group is unloaded or destroyed.

```typescript
const controller = new AbortController();
const updates = group.watch({ signal: controller.signal });
const done = (async () => {
  for await (const snapshot of updates) renderHeader(snapshot);
})();

// On teardown:
controller.abort();
await done;
```

Event listeners added with `.on()` need a matching `.off()`. For switching accounts and tearing down everything that belongs to an account, see [Multi-account](/client/multi-account).
