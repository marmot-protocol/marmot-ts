# marmot-ts demos

A Vite + React app of small, focused demos. Each tab in the sidebar is one
self-contained file in `src/demos/` that shows how one part of the client works
and doubles as a hands-on test that the public API is enough for a downstream app.

```bash
pnpm install
pnpm demos
```

By default Vite aliases `@internet-privacy/marmot-ts` to the library's `src/`,
so demos run against your working copy with hot reload and no rebuild. To run
against the built package, exactly as a downstream app would, build the
library first and set `MARMOT_DIST=1`:

```bash
pnpm build
MARMOT_DIST=1 pnpm demos
```

## Accounts and login

`src/accounts.ts` holds the one applesauce `AccountManager` for the whole app.
It restores saved accounts from localStorage and saves every change back. It
also exports `login()`, `switchAccount()`, `logout()` and the hooks
`useActiveAccount()`, `useAccount()` and `useAccounts()`.
The active account is stored only in sessionStorage: reloads keep the tab's identity,
while a new session generates a fresh development identity with a random name.
Its signed kind-0 profile is published to the local worker relay, never automatically
to public relays. Generating an identity in one tab does not change another tab's
active account.

The app does not manage a Marmot `clientId`. Each example creates and keeps
its own and passes it to the actor helpers.

The account switcher opens a login screen supporting a NIP-07
extension, NIP-46 remote signers (bunker URI or `nostrconnect://` QR code), and
a pasted or freshly generated private key. The sidebar shows the active account
with **switch** (back to the login screen, account kept) and **log out**
(account forgotten). Switching accounts remounts every demo. The default NIP-46
signer relay is `wss://bucket.coracle.social`.

## How demos work

`src/services.tsx` owns a shared transport, EventStore, and contacts service for
the tab's current account and mode. Demos get the transport with `useTransport()`
and use its `relays` and `network(actor)` methods rather than creating their own
relay or hardcoding relay URLs. `createUserActor(account, transport, clientId)`
builds the logged-in participant; `createPeerActor()` builds a throwaway peer.

The sidebar switches modes independently in each tab:

- **Tabs (local)** is the default. A named SharedWorker relay with an Applesauce
  EventStore shares events between local tabs, with BroadcastChannel as a fallback.
  No demo or contacts traffic goes to public relays. Contacts are the distinct active
  identities of other local-mode tabs, excluding your own identity. Graceful departures
  disappear immediately; abruptly closed tabs expire after two minutes without a heartbeat.
- **Live network** uses an Applesauce RelayPool. Demo events are published to real
  relays (`relay.damus.io` and `nos.lol` by default). Contacts come from the active
  account's NIP-02 follow list on its NIP-65 write/outbox relays, discovered using
  `purplepag.es` and the default relays. Applesauce User casts expose contacts and
  their reactive profiles. Accounts without a relay list fall back to the default relays.

Switching modes or accounts disposes contacts, connections, and the in-memory
EventStore, and remounts the demo. Local events and identities are never forwarded
to the live network. NIP-46 login still contacts its explicitly selected signing relay,
even when the demo transport is local.

`useContacts()` exposes `contacts$` (Applesauce `User[]`) and `error$`.
`useDemoServices()` also exposes the mode and shared EventStore.

**Reset** remounts only the demo, keeping the shared transport and contacts.
**Copy code** copies its source without opening a code panel.

## Local relay inspector

Open `/relay` directly, or use **Local relay inspector** in the sidebar to open it
in a separate tab without interrupting the demo. No login is required, and no
demo actors or live-network connections are started. The inspector connects to
the same named SharedWorker and keeps it alive.

The view shows worker health (checked every two seconds), demo connections,
active subscription IDs and filters, stored event JSON, and traffic history
including activity before the inspector opened. Search filters the selected view;
expand a traffic entry or event for full JSON, and use **Show more** for large lists.

**Reset relay data** clears stored events, traffic history, and queued publishes
across connected tabs after confirmation. Active subscriptions, accounts, and
demo groups remain. Pause running demos first if you want the relay to stay
empty; they can publish again immediately after reset. This does not terminate
the worker or clear browser account storage.

Inspection requires SharedWorker support; it does not inspect the
BroadcastChannel fallback or live-network relays.

## Clock group

Open **Groups → Clock group** (`#/groups/clock`), enter a group name, and click
**Create group & start clock**. Your account creates the group and invites a
throwaway clock participant, which posts an encrypted UTC timestamp every second.
The received messages panel shows your latest 60 decrypted ticks; `/relay` shows
the encrypted local relay traffic.

**Pause clock** stops new ticks; **Resume clock** restarts them. Reset, navigating
away, or switching accounts stops the clock and releases the group connections.
Keep the tab open: browser background throttling can slow the one-second timer.
The relay is shared across tabs, but each demo's group keys and membership remain
local to its run; opening another tab does not automatically join that group.

Run the demo integration tests from the repository root:

```bash
pnpm exec vitest run --config examples/demos/vitest.config.ts
```

## Adding a demo

1. Create `src/demos/<category>/<name>.tsx` with a default-exported component:

   ```tsx
   import { useAccount } from "../../accounts.js";

   export default function Demo() {
     const account = useAccount();
     /* ... */
   }
   ```

2. Add it to the list in `src/demos.ts`, under a section label, with its title:

   ```ts
   { label: "Groups", demos: [{ id: "groups/create-group", title: "Create group" }] },
   ```

The `id` is the file path under `src/demos/` without `.tsx`, and is also the
URL (`#/groups/create-group`). The sidebar follows the order of the list.
**Copy code** copies the demo's source.

Guidelines:

- Import only from public entrypoints (`@internet-privacy/marmot-ts`,
  `/client`, `/extra`, …), never from `src/` paths. If a demo needs something
  the public API doesn't expose, that gap is a finding.
- Keep library calls inline in the demo rather than hiding them in helpers;
  the code is the explanation.
- Run as the logged-in user: get the account with `useAccount()` and build
  the client with `createUserActor()`. Use `createPeerActor()` for anyone else.
- Shared helpers in `src/lib/` are limited to demo plumbing: the actor
  factories, `DemoRelay`, the React hooks (`useGroups`, `useGroupSnapshot`, `useWatch`,
  `useSetup`) and UI pieces (`Panel`, `Action`, `Json`, `RelayLog`).
- Style with [Tailwind CSS](https://tailwindcss.com) utilities and
  [daisyUI](https://daisyui.com) components (`btn`, `input`, `card`, `badge`,
  `alert`, …) instead of custom CSS. Use daisyUI's semantic colors
  (`bg-base-100`, `text-base-content/60`, `text-error`) so light and dark
  themes both work.
