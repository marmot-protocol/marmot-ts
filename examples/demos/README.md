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

`src/services/accounts.ts` exposes `account$`, `accounts$`, and async login,
selection, forgetting, and logout actions. Its internal applesauce `AccountManager`
restores saved accounts from localStorage and saves every change back. Components
import the observables directly and subscribe with `use$`; there are no account hooks.
The active account is stored only in sessionStorage: reloads keep the tab's identity,
while a new session generates a fresh development identity with a random name.
Its signed kind-0 profile is published to the local worker relay, never automatically
to public relays. Generating an identity in one tab does not change another tab's
active account.

`src/services/client-id.ts` generates one Marmot `clientId` and saves it in
localStorage, shared by all accounts and tabs. Private key packages stay in
sessionStorage, separated by client ID, account, and local/live mode. Simulated
actors can still use their own ephemeral client ids.

The service's `rotateClientId()` action rotates this ID, rebuilds active clients across
open tabs, and remounts their demos. Every account then uses a fresh key-package
namespace, without automatically publishing. Saved logins and relay events are
unchanged. Old private bundles remain in their previous sessionStorage namespaces,
but are no longer loaded; storage from the earlier per-account client IDs is also
left unused.

The account switcher opens a login screen supporting a NIP-07
extension, NIP-46 remote signers (bunker URI or `nostrconnect://` QR code), and
a pasted or freshly generated private key. The sidebar shows the active account
with **switch** (back to the login screen, account kept) and **log out**
(account forgotten). Switching accounts remounts every demo. The default NIP-46
signer relay is `wss://bucket.coracle.social`.

## How demos work

Services are ordinary ES modules under `src/services/`, with no React provider,
context, service registry, or combined session object. Each service imports its
dependencies directly and owns its resource lifetime:

```text
mode$ ──► transport$
account$ + mode$ + clientId$ ──► sessionDatabase$
sessionDatabase$ + account$ + transport$ + clientId$ ──► client$ ──► key-package publication
account$ + transport$ ──► contacts$ (Users with reactive profiles)
```

Transport works without an account. Changing mode replaces its connection.
Contacts owns the profile/event cache and disposes it with discovery.
Changing the active account replaces the client and contacts,
but leaves the account-independent transport connected.

The sidebar switches modes independently in each tab:

- **Tabs (local)** is the default. A named SharedWorker relay with an Applesauce
  EventStore shares events between local tabs, with BroadcastChannel as a fallback.
  No demo or contacts traffic goes to public relays. Contacts are the distinct active
  identities of other local-mode tabs with key packages, excluding your own identity.
  Contacts manages presence over a separate BroadcastChannel, not the relay transport. Graceful departures
  disappear immediately; abruptly closed tabs expire after two minutes without a heartbeat.
- **Live network** uses an Applesauce RelayPool. Demo events are published to real
  relays (`relay.damus.io` and `nos.lol` by default). Contacts come from the active
  account's NIP-02 follow list on its NIP-65 write/outbox relays, discovered using
  `purplepag.es` and the default relays. Applesauce User casts expose contacts and
  their reactive profiles. Accounts without a relay list fall back to the default relays.

Switching modes or accounts disposes the old client and contacts and remounts the
demo. Local events, private key packages, and group state are never forwarded to
the live network. NIP-46 login still contacts its explicitly selected signing relay,
even when the demo transport is local.

### Reactive services

Import each service directly and use Applesauce's `use$` hook for existing observables.
`client$` emits the actual, unmodified `MarmotClient`; library commands and watchers
remain visible in the demo source, rather than being forwarded through a facade.

```tsx
import { use$ } from "applesauce-react/hooks";
import { account$ } from "../../services/accounts.js";
import { client$ } from "../../services/client.js";
import { contacts$ } from "../../services/contacts.js";
import { useAsyncLatest } from "../../hooks/use-async-latest.js";

const account = use$(account$);
const client = use$(client$)!; // The app mounts demos only after the client is ready.
const contacts = use$(contacts$);
const invites = useAsyncLatest(
  (signal) => client.watchInvites({ signal }),
  [client],
);
```

- `services/mode.ts` exports the deliberately writable `mode$` BehaviorSubject.
  The sidebar calls `mode$.next("local" | "live")`.
- `services/client-id.ts` exports the readonly `clientId$` and async
  `rotateClientId()` action. The shared ID persists in localStorage; rotation
  starts fresh for all accounts and propagates to other open tabs.
- `services/session-database.ts` exports `sessionDatabase$`, which owns database
  initialization and closing for the active account, mode, and client ID. It emits
  `undefined` while logged out or opening a database.
- `services/client.ts` exports `client$`. It emits
  `undefined` while logged out or replacing a client. Call APIs such as
  `client.groups.create()`, `client.groups.send()`, and `client.invites.markAsRead()`
  directly. Missing client API surface is a library finding, not a reason to add a wrapper.
- `services/contacts.ts` exports `contacts$` (Applesauce `User[]`), `peers$`
  (all other local-mode tabs, even without key packages), and `error$`.
  Each User carries its own `profile$` and `outboxes$`; `profile$(pubkey)` also
  serves identities displayed outside the contact list. Profile loading stays here.
- `services/transport.ts` exports only `transport$`, a bare `NostrNetworkInterface`.
  Mode changes dispose the old implementation; client initialization passes the
  interface directly to MarmotClient, without a transport wrapper or state facade.
- `services/relays.ts` exports the mode-dependent `relays$` configuration used by
  demo operations and key-package publication.
- `services/key-packages.ts` owns sidebar publication state and async
  `publish()` / `rotate()` actions. It maintains packages and invite listening
  using the real client's APIs, without owning or wrapping the client.
- `services/relay.ts` provides the anonymous inspector's state and reset action.

Use `useAsyncLatest` for the library's async watchers, forwarding its abort signal.
No parallel observable API is attached to the client. Internal implementations
live under `services/internal/`; JSX lives under `components/`, pure helpers under
`utils/`, and existing test fixtures under `testing/`.

**Reset** remounts only the demo, keeping the shared transport and contacts.
**Copy code** copies its source without opening a code panel.

## Local relay inspector

Open `/relay` directly, or use **Local relay inspector** in the sidebar to open it
in a separate tab without interrupting the demo. No login is required, and no
demo actors or live-network connections are started. The inspector connects to
the same named SharedWorker and keeps it alive.

The view shows worker health (checked every two seconds), demo connections,
active subscription IDs and filters, stored event JSON, and traffic history
including activity before the inspector opened. Search filters the selected view.
Traffic and events use tables with aligned metadata columns; click **JSON** on a
row to expand its full data, and use **Show more** for large lists. Tables scroll
horizontally on narrow screens.

**Reset relay data** clears stored events and traffic history
across connected tabs after confirmation. Active subscriptions, accounts, and
demo groups remain. Pause running demos first if you want the relay to stay
empty; they can publish again immediately after reset. This does not terminate
the worker or clear browser account storage.

Inspection requires SharedWorker support; it does not inspect the
BroadcastChannel fallback or live-network relays.
There are no duplicate inline traffic panels or hold/flush controls.

## Simple chat

Open **Groups → Simple chat** (`#/groups/chat`) in two independent tabs, keeping
both in **Tabs (local)** mode with different accounts.

1. In the first tab, choose **Create group**, enter a name, and click **Create**.
2. Select the other tab's contact and click **Invite**. Local development accounts
   publish their key packages automatically; live accounts must opt in from the sidebar.
3. In the second tab, choose **Join invite** and click **Join** beside the inviter.
4. Send messages from either tab. The group displays its members and latest 100
   decrypted messages; `/relay` shows the encrypted Nostr traffic.

`src/demos/groups/chat.tsx` keeps creation, invitation, joining, connection,
post-join leaf rotation, sending, and history subscriptions inline. It reuses the
session client for key packages and invite listening, with no simulated peers.
The creator can invite more contacts into the same group. Invites look up key
packages on the selected transport's relays, so participants should use the same
transport mode. Live mode publishes to real relays.

Group state is in memory: reloading or resetting does not restore the chat.
Navigating away disconnects the chat without leaving the group; create a fresh
group for a fresh run.

## Session key packages

New development identities automatically publish a kind-30443 key package once,
when created in local mode. Logged-in and restored accounts (and live mode) opt in
with **Publish key package** in the sidebar. Existing private packages enable
invite listening without publishing or signing a replacement.

**Rotate** creates fresh keys in the same addressable publication slot.
Reloads restore the slot and private bundles without re-publishing; use **Publish
again** if the local worker lost the publication. Old bundles remain available for delayed
Welcomes until their replacement grace period (24 hours) or signed expiry, whichever
comes first. Publishing and rotating after a package is consumed or expires are
explicit sidebar actions, not timer or demo side effects. Local private material
is never copied into live mode.

The sessionStorage bundles contain unencrypted MLS secrets: use development accounts.
Only key-package material survives reloads, not the demo's group state or history.

## Clock group

Open **Groups → Clock group** (`#/groups/clock`) and choose **Host clock** or
**Receive clock**. The choice disappears until **Reset**.

In the host tab, start a named feed, then **Invite** a contact. In another local
tab, choose **Receive clock** and **Accept invite**. The host sends an encrypted UTC
timestamp every second as the signed-in account; both views show the latest tick
as a large clock with a bounded recent feed. Invites stay above the feed.

The host discovers live contacts' key packages on their outboxes and the default
relays. This focused demo invites the most recent compatible device slot rather
than every device of an account. Existing accounts must publish a session package
before they can accept an invite.

**Pause** stops new ticks; **Resume** restarts them. Reset, navigating away, or
switching accounts stops the feed and releases its connections while keeping the
session key-package service. Keep the host tab open: background throttling can
slow the timer. `/relay` shows the encrypted local traffic.

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
- Run as the logged-in user: import `client$`, `account$`, and other services
  directly from their modules and subscribe with `use$`.
- Call real library APIs directly; use `useAsyncLatest` for async state watchers.
- Shared relay internals live in `src/services/internal/relay/`; inspector UI
  lives in `src/components/relay/`.
- Keep service implementations framework-independent, presentation in `components/`,
  and pure helpers in `utils/`. There is no miscellaneous `lib/` folder.
- Style with [Tailwind CSS](https://tailwindcss.com) utilities and
  [daisyUI](https://daisyui.com) components (`btn`, `input`, `card`, `badge`,
  `alert`, …) instead of custom CSS. Use daisyUI's semantic colors
  (`bg-base-100`, `text-base-content/60`, `text-error`) so light and dark
  themes both work.
