# UI Framework Integration

`MarmotClient` exposes reactive APIs through **async generators** (`watchGroups()` and `watchKeyPackages()`) that emit updates whenever state changes. To integrate with UI frameworks, you'll need to convert these async generators into your framework's native reactivity system.

This guide shows how to consume these async iterators in different frameworks and patterns for managing the client instance lifecycle.

## Understanding Async Generators

The client provides two primary reactive APIs that return [async generators](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function*):

```typescript
// Emits whenever groups are created, joined, loaded, or destroyed
for await (const groups of client.watchGroups()) {
  console.log(`You have ${groups.length} groups`);
}

// Emits whenever key packages change
for await (const packages of client.watchKeyPackages()) {
  console.log(`You have ${packages.length} key packages`);
}
```

**What are async generators?** They're functions that can yield multiple values over time, with each value wrapped in a Promise. Think of them as streams of data that you can consume at your own pace.

### Using `for await...of` (Recommended)

The `for await...of` loop is the most convenient way to consume async generators. It automatically:

- Waits for each Promise to resolve
- Handles the iteration protocol
- Breaks cleanly when the generator completes

### Using Manual `.next()` API

For more control, you can manually iterate using the `.next()` method:

```typescript
const iterator = client.watchGroups()[Symbol.asyncIterator]();

// Get first value
const { value: groups1, done } = await iterator.next();
if (!done) {
  console.log(`Current groups:`, groups1);
}

// Get next value when ready
const { value: groups2 } = await iterator.next();
console.log(`Updated groups:`, groups2);

// Clean up when done
await iterator.return?.();
```

**When to use manual `.next()`:**

- Building custom observables or reactive wrappers
- Implementing backpressure (controlling the rate of updates)
- Creating specialized iteration patterns
- Debugging or inspecting individual updates

**Your framework integration needs to:**

1. Start iterating when the component/view mounts
2. Update UI state with each emitted value
3. Cancel the iterator when the component/view unmounts

## React Integration

### Custom Hook Pattern

React components re-render frequently, so you need to ensure the async generator is created **once** and persists across renders:

```typescript
import { useState, useEffect, useRef } from "react";
import type { MarmotClient, MarmotGroup } from "@internet-privacy/marmots";

function useWatchGroups(client: MarmotClient | null) {
  const [groups, setGroups] = useState<MarmotGroup[]>([]);
  const genRef = useRef<AsyncGenerator<MarmotGroup[]> | null>(null);

  useEffect(() => {
    if (!client) {
      setGroups([]);
      return;
    }

    // Create generator only once
    if (!genRef.current) {
      genRef.current = client.watchGroups();
    }

    let cancelled = false;
    const gen = genRef.current;

    (async () => {
      for await (const groups of gen) {
        if (cancelled) break;
        setGroups(groups);
      }
    })();

    return () => {
      cancelled = true;
      gen.return?.(); // Properly close the generator
    };
  }, [client]);

  return groups;
}

// Usage
function GroupList({ client }) {
  const groups = useWatchGroups(client);

  return (
    <ul>
      {groups.map(group => (
        <li key={group.groupId}>{group.name}</li>
      ))}
    </ul>
  );
}
```

**Key points:**

- `useRef` stores the generator so it survives re-renders
- `gen.return()` properly closes the generator on cleanup to prevent memory leaks
- `cancelled` flag prevents state updates after unmount
- Empty dependency array on the inner effect (if you extract it) ensures the loop starts once

**Reusable for key packages:**

```typescript
function useWatchKeyPackages(client: MarmotClient | null) {
  const [packages, setPackages] = useState([]);
  const genRef = useRef(null);

  useEffect(() => {
    if (!client) {
      setPackages([]);
      return;
    }

    if (!genRef.current) {
      genRef.current = client.watchKeyPackages();
    }

    let cancelled = false;
    const gen = genRef.current;

    (async () => {
      for await (const pkgs of gen) {
        if (cancelled) break;
        setPackages(pkgs);
      }
    })();

    return () => {
      cancelled = true;
      gen.return?.();
    };
  }, [client]);

  return packages;
}
```

## Svelte 5 Integration

### Reusable Function Pattern

Svelte 5 uses runes (`$state`, `$effect`) which work in `.svelte.js` files for reusable reactive logic:

```typescript
// useWatchGroups.svelte.js
export function useWatchGroups(client) {
  let groups = $state([]);
  const gen = client.watchGroups();
  let cancelled = false;

  $effect(() => {
    (async () => {
      for await (const value of gen) {
        if (cancelled) break;
        groups = value;
      }
    })();

    return () => {
      cancelled = true;
      gen.return?.();
    };
  });

  return {
    get value() {
      return groups;
    },
  };
}
```

```svelte
<!-- GroupList.svelte -->
<script>
  import { useWatchGroups } from "./useWatchGroups.svelte.js";

  export let client;

  const stream = useWatchGroups(client);
</script>

<ul>
  {#each stream.value as group}
    <li>{group.name}</li>
  {/each}
</ul>
```

**Why this works:**

- Svelte 5 component scripts run once (not on every re-render like React)
- Generator is created outside `$effect`, so it's stable
- `gen.return()` properly closes the generator on cleanup

## SolidJS Integration

SolidJS components run once, making this the cleanest integration:

```typescript
import { createSignal, onCleanup } from "solid-js";
import type { MarmotClient } from "@internet-privacy/marmots";

function useWatchGroups(client: MarmotClient) {
  const [groups, setGroups] = createSignal([]);
  const gen = client.watchGroups();
  let cancelled = false;

  (async () => {
    for await (const value of gen) {
      if (cancelled) break;
      setGroups(value);
    }
  })();

  onCleanup(() => {
    cancelled = true;
    gen.return?.();
  });

  return groups;
}

// Usage
function GroupList(props) {
  const groups = useWatchGroups(props.client);

  return (
    <ul>
      <For each={groups()}>{(group) => <li>{group.name}</li>}</For>
    </ul>
  );
}
```

**Why SolidJS is ideal:**

- Component body runs **once**, no re-render issues
- No need for `useRef` or memoization tricks
- Natural fit for async generator pattern

## Vue 3 Integration

Vue's Composition API with `<script setup>` also runs once per mount:

```typescript
// useWatchGroups.js
import { ref, onUnmounted } from "vue";

export function useWatchGroups(client) {
  const groups = ref([]);
  const gen = client.watchGroups();
  let cancelled = false;

  (async () => {
    for await (const value of gen) {
      if (cancelled) break;
      groups.value = value;
    }
  })();

  onUnmounted(() => {
    cancelled = true;
    gen.return?.();
  });

  return groups;
}
```

```vue
<!-- GroupList.vue -->
<script setup>
import { useWatchGroups } from "./useWatchGroups";

const props = defineProps(["client"]);
const groups = useWatchGroups(props.client);
</script>

<template>
  <ul>
    <li v-for="group in groups" :key="group.groupId">{{ group.name }}</li>
  </ul>
</template>
```

## Vanilla JavaScript

### Direct Async Generator Usage

```typescript
const client = new MarmotClient({
  /* ... */
});
const gen = client.watchGroups();
let cancelled = false;

(async () => {
  for await (const groups of gen) {
    if (cancelled) break;

    // Update DOM
    const container = document.getElementById("groups");
    container.innerHTML = "";

    groups.forEach((group) => {
      const li = document.createElement("li");
      li.textContent = group.name;
      container.appendChild(li);
    });
  }
})();

// Cleanup when navigating away
window.addEventListener("beforeunload", () => {
  cancelled = true;
  gen.return?.();
});
```

### Event Listener Pattern

For simpler use cases, subscribe to client events instead:

```typescript
client.on("groupsUpdated", ({ groups }) => {
  updateGroupListUI(groups);
});

client.on("groupCreated", ({ group }) => {
  showNotification(`New group: ${group.name}`);
});
```

## Framework Comparison

| Framework    | Setup Complexity | Generator Stability | Cleanup                            |
| ------------ | ---------------- | ------------------- | ---------------------------------- |
| **React**    | Medium           | Needs `useRef`      | `gen.return()` in cleanup          |
| **Svelte 5** | Low              | Natural (runs once) | `gen.return()` in `$effect` return |
| **SolidJS**  | Low              | Natural (runs once) | `gen.return()` in `onCleanup`      |
| **Vue 3**    | Low              | Natural (runs once) | `gen.return()` in `onUnmounted`    |
| **Vanilla**  | Lowest           | Manual management   | Manual cleanup                     |

**The core pattern is always the same:**

1. Create the async generator once
2. Loop with `for await...of`
3. Update your framework's reactive state
4. Set a `cancelled` flag on cleanup
5. Call `gen.return()` to properly close the generator

## Multi-Account Considerations

### Per-Account Storage Isolation

**Critical:** Each user account must have isolated storage to prevent key material from mixing:

```typescript
function getStorageForAccount(pubkey: string) {
  // IndexedDB
  return new IndexedDBStateStore(`marmot-${pubkey}`);

  // Or LocalForage
  return localforage.createInstance({
    name: `marmot-${pubkey}`,
    storeName: "groups",
  });
}

function getKeyPackageStoreForAccount(pubkey: string) {
  return new KeyPackageStore(
    localforage.createInstance({
      name: `marmot-${pubkey}`,
      storeName: "keyPackages",
    }),
  );
}
```

**Why this matters:**

- Each user has different private keys for MLS
- Mixing storage would leak keys between accounts
- Security requires complete isolation per account

### Account Switching Pattern

When a user switches accounts, destroy the old client and create a new one:

```typescript
let currentClient: MarmotClient | null = null;

async function switchToAccount(account: Account) {
  // Clean up old client (optional, but good practice)
  currentClient = null;

  // Create new client with account-specific storage
  currentClient = new MarmotClient({
    signer: account.signer,
    network: sharedNetworkInterface, // Can be shared
    groupStateBackend: getStorageForAccount(account.pubkey),
    keyPackageStore: getKeyPackageStoreForAccount(account.pubkey),
  });

  return currentClient;
}
```

**Framework-specific handling:**

- **React:** Update state with new client, `useEffect` will handle cleanup
- **Svelte:** Reassign the client variable, reactive statements will re-run
- **Vanilla:** Cancel old iterators and start new ones

## Background Synchronization

::: warning
`MarmotClient` does **not** automatically keep groups synchronized with relays. Your application needs to:

1. Subscribe to group events from relays (kind 445)
2. Call `group.ingest(events)` to process new commits and messages
3. Maintain these subscriptions even when the UI is on different pages

Without background synchronization, groups will drift out of sync and fail to decrypt new messages.
:::

See the [`MarmotGroup` documentation](/client/marmot-group#processing-events) for details on ingesting events.

## Next Steps

- **[MarmotClient](/client/marmot-client)** - Understand the client's role and lifecycle
- **[MarmotGroup](/client/marmot-group)** - Learn about group-level operations
- **[Storage](/client/storage)** - Implement persistent storage backends
- **[Network Interface](/client/network)** - Connect to Nostr relays
- **[Best Practices](/client/best-practices)** - Production deployment patterns
