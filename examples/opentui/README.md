# marmot-opentui

A terminal chat client for `@internet-privacy/marmot-ts`, rendered with the
[OpenTUI](https://opentui.com) **React** reconciler. It speaks the same
darkmatter **Marmot v2** wire format as the sibling [`tui-chat`](../tui-chat)
example and interoperates with the Rust reference crates on the happy path:

> publish KeyPackage → discover peer → invite → welcome → join → exchange text

Where `tui-chat` is a readline loop, this app is a live, multi-pane TUI: a group
sidebar, a sticky-scrolling message timeline, pending-invite list, and a status
feed — all updating reactively as protocol state changes.

## Why this example exists

It is a testbed for the library's **React / async-generator integration**. The
UI is driven by three of the library's own async surfaces:

| Library surface                  | Type            | Consumed by                                       |
| -------------------------------- | --------------- | ------------------------------------------------- |
| `client.groups.watch()`          | async generator | `useWatchedGroups()` → the sidebar group list     |
| `client.invites.watchUnread()`   | async generator | `useWatchedInvites()` → the pending-invite list   |
| `group.ingest(events)`           | async generator | the controller, to decrypt incoming relay events  |
| `group.on("applicationMessage")` | event emitter   | the controller, to append to the message timeline |

The generic [`useAsyncIterable`](src/hooks/use-async-iterable.ts) hook is the
bridge: it pumps each value an `async *` generator yields into React state and
`return()`s the generator on unmount so the library's internal listeners are
detached. That hook is the thing this example is really here to exercise.

## Architecture

- **`src/marmot/controller.ts`** — `MarmotController`, a headless driver for the
  marmot-ts lifecycle (publish identity, restore groups, subscribe to relays,
  drain `ingest`, local echo). It exposes an immutable snapshot for React via
  `useSyncExternalStore`. This is the imperative half the async generators can't
  express.
- **`src/hooks/`** — `useAsyncIterable` (the generator → state bridge) and
  `useChat` / `useWatchedGroups` / `useWatchedInvites` (the React entry points).
- **`src/components/`** — the OpenTUI React tree (`App` owns focus/keyboard,
  `Sidebar` + `ChatView` + `InputBar` + `Header` + `ActivityLog`, plus the
  interactive `ActionBar`/`Button` and the `TextPrompt`/`ChoicePrompt` modals).
  `focus.ts` defines the pane cycle.
- **`src/helpers/`** — `RelayPool`, `Directory` (relay-list/profile discovery
  via applesauce's address loader), `FileKeyValueStore`, and the account-proof
  signer, carried over verbatim from `tui-chat` (they are UI-agnostic).

## Runtime

OpenTUI's renderer uses native FFI. **Bun is required** (Node needs 26.3+ with
experimental FFI flags). This example's scripts run under Bun; the rest of the
repo still uses pnpm for installs.

## Prerequisites

Build the library first (the example imports its built `dist/`):

```bash
pnpm install          # from the repo root
pnpm build            # builds @internet-privacy/marmot-ts
```

You also need [Bun](https://bun.sh) on your PATH.

## Run

```bash
# from the repo root
pnpm --filter marmot-opentui start -- --name alice
# in a second terminal
pnpm --filter marmot-opentui start -- --name bob
```

(`pnpm … start --` forwards the flags to the Bun process. You can also `cd`
into this directory and run `bun run src/index.tsx --name alice`.)

### Flags

| Flag             | Default                                 | Meaning                                                             |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------- |
| `--name <label>` | `default`                               | Profile name; data + identity live in `~/.marmot-opentui/<label>/`. |
| `--relay <url>`  | `wss://relay.damus.io`, `wss://nos.lol` | Repeatable. Point all peers at the **same** relay(s).               |
| `--sec <hex>`    | (generated)                             | Use a specific 32-byte hex Nostr secret key.                        |
| `--ephemeral`    | off                                     | Keep all state in memory (nothing written to disk).                 |
| `--debug`        | off                                     | Show full stack traces (and `cause` chains) in the activity feed.   |

> Many public relays reject MLS event kinds (443/30443/444/445/1059). For
> reliable testing, run a permissive local relay (e.g. `strfry`,
> `nostr-rs-relay`) and pass it with `--relay ws://localhost:<port>`.

## Compile a standalone binary

```bash
pnpm --filter marmot-opentui compile        # or: cd here && bun run compile
./dist/marmot-opentui --name alice
```

`compile` runs `bun build --compile` (see `scripts/compile.ts`) and produces a
single, self-contained executable in `dist/` — no Bun or `node_modules` needed
to run it. OpenTUI's native renderer (`libopentui.so`) is embedded into the
binary, so the artifact is **platform-specific**: it targets the OS/arch you
build on. The same runtime flags apply (`--name`, `--relay`, …).

## Using it

There are no slash-commands — the UI is keyboard- and mouse-driven.

**Panes & focus.** The app has four focus targets: the message input, the
**groups** list, the **invites** list, and the **action bar**. The focused pane
has a gold border.

- **Tab / Shift+Tab** — cycle focus between panes (mouse-click a pane to focus it too).
- **Message input** (focused by default) — type and press **Enter** to send to
  the active group.
- **Groups list** — **↑/↓** to highlight (the chat switches live), **Enter** to
  confirm and jump back to the input.
- **Invites list** — **↑/↓** to highlight, **Enter** to accept (join).
- **Action bar** — **←/→** to highlight a button, **Enter** to run it. Buttons
  are also clickable with the mouse.
- **Ctrl+C** — exit.

**Action buttons:** `New group`, `Invite`, `Leave`, `My QR`, `Profile`,
`Relays`, `KeyPkg`, `Quit`. `New group` and `Invite` open a small modal prompt
(Enter confirms, Esc cancels); `My QR` shows your npub as a scannable QR code
(also opened by clicking your npub in the header); `Profile` opens a kind-0
metadata editor; `Relays` opens the relay-list editor (below); `KeyPkg` opens a
publish/rotate chooser.

**Managing your relays.** `Relays` edits the two relay lists this account
advertises on Nostr, each a whitespace/comma-separated list of `wss://` URLs:

- **Outbox** — your **NIP-65** list (kind 10002). Marmot reads it to discover
  where you publish your KeyPackages, so peers fetch them from here when they
  invite you.
- **Inbox** — your **kind 10050** list. This is where gift-wrapped welcomes are
  delivered to you.

On startup the app loads whatever you've already published (so your edits
survive restarts) and only publishes defaults — the operating relays — when a
list has never been published. Pressing Enter re-signs and republishes both
lists; the values are normalised, de-duplicated, and stripped of invalid URLs
before publishing.

A two-party session: copy each peer's npub from the header (or click it / press
**My QR** to show a scannable QR code), click **New group** on one side and name
it, click **Invite** and paste the other's npub, then on the other side select
the invite in the sidebar and press **Enter** to join.

> The mouse works (clicks on buttons and pane focus), but the keyboard path is
> the most reliable across terminals.

## Known-divergent — avoid in interop tests

These map to open items in the repo's `SPEC_GAP_REVIEW.md` and are inherited
from the shared lifecycle (they do **not** break happy-path turn-taking chat):

- **Concurrent commits** (two members committing at once) — convergence /
  quiescence settlement is not implemented yet (gap **B5**).
- **`/leave`** — sends a plain MLS `Remove`; spec peers expect MLS `SelfRemove`
  with a deterministic auto-committer (gap **B6**). The activity feed warns you.
- **Heavy message reordering / dropped relays** — out-of-order inputs are not
  yet retried via the `deferred` disposition (gap **B7**).
