# marmot-opentui

A terminal chat client for `@internet-privacy/marmot-ts`, rendered with the
[OpenTUI](https://opentui.com) **React** reconciler. It speaks the same
darkmatter **Marmot v2** wire format as the sibling [`tui-chat`](../tui-chat)
example and interoperates with the Rust reference crates on the happy path:

> publish KeyPackage → discover peer → invite → welcome → join → exchange text

Where `tui-chat` is a readline loop, this app is a live, multi-pane TUI: a group
sidebar, a sticky-scrolling message timeline, and pending-invite list — all
updating reactively as protocol state changes.

## Why this example exists

It is a testbed for the library's **React / async-generator integration**. The
UI is driven by three of the library's own async surfaces:

| Library surface                  | Type            | Consumed by                                                                    |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| `client.groups.watch()`          | async generator | `useWatchedGroups()` → the sidebar group list                                  |
| `client.invites.watchUnread()`   | async generator | `useWatchedInvites()` → the pending-invite list (filtered to held KeyPackages) |
| `group.ingest(events)`           | async generator | the controller, to decrypt incoming relay events                               |
| `group.on("applicationMessage")` | event emitter   | the controller, to append to the message timeline                              |

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
- **`src/hooks/`** — `useAsyncIterable` (the generator → state bridge),
  `useChat` / `useWatchedGroups` / `useWatchedInvites` (the React entry points),
  and `useProfile` / `useDisplayName` (applesauce's `castUser(...).profile$`
  cast + the `use$` hook, so member/author display names auto-load and stay
  reactive instead of being prefetched and threaded through the controller).
- **`src/components/`** — the OpenTUI React tree (`App` owns focus/keyboard,
  `Sidebar` + `ChatView` + `InputBar` + `Header`, plus the
  interactive `ActionBar`/`Button` and the `TextPrompt`/`ChoicePrompt` modals).
  `focus.ts` defines the pane cycle.
- **`src/helpers/`** — `RelayPool`, `Directory` (imperative relay-list/profile
  lookups that read from the shared `EventStore`, whose loader auto-fetches and
  de-duplicates — the same cache the reactive UI casts read), `FileKeyValueStore`,
  and the account-proof signer.

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

| Flag                  | Default     | Meaning                                                             |
| --------------------- | ----------- | ------------------------------------------------------------------- |
| `--name <label>`      | `default`   | Profile name; data + identity live in `~/.marmot-opentui/<label>/`. |
| `--sec <hex>`         | (generated) | Use a specific 32-byte hex Nostr secret key.                        |
| `--ephemeral`         | off         | Keep app state in memory; audit can still write when enabled.       |
| `--audit`             | off         | Record Marmot forensic audit JSONL for this account/device.         |
| `--audit-path <path>` | account dir | Write audit JSONL to a custom path; implies `--audit`.              |
| `--debug`             | off         | Include full stack traces (and `cause` chains) in status errors.    |
| `--logs <path>`       | off         | Enable `debug` logging and append status/debug lines to this file.  |
| `--help`, `-h`        | off         | Print the options and exit without starting the OpenTUI UI.         |

Relays are no longer chosen with a flag. The app bootstraps discovery from a
default set (`wss://relay.damus.io`, `wss://nos.lol`) and then operates on the
account's own **published** relay lists — its NIP-65 outbox (kind 10002) and
welcome inbox (kind 10050). Set them when creating an account (profile panel →
**o**) or edit them in-app (**r** → relays).

> Many public relays reject MLS event kinds (443/30443/444/445/1059). For
> reliable testing, run a permissive local relay (e.g. `strfry`,
> `nostr-rs-relay`) and point your account's relay lists at
> `ws://localhost:<port>` via the new-account flow or the in-app relay editor.

An account is generated on first run and persisted under the `--name` label.
Local state (groups, KeyPackages, invites, and message history) lives in a single
`state.db` SQLite database in that directory, alongside the raw `identity.key`;
`--ephemeral` keeps the app's group/invite/message state in memory.
With `--audit`, obfuscated-sensitive forensic rows are appended to
`audit-<engine_id>.jsonl` in the same directory by default, with a stable
`audit-device-id` file used to derive the audit engine id. Use `--audit-path` to
write the JSONL somewhere else for upload into Goggles.
To switch identities without restarting, focus the **profile** panel and press
**o**. A form asks for a display name (published as your kind 0 profile) and an
optional relay list used for both your inbox and outbox — it defaults to
`wss://relay.us.whitenoise.chat`. Creating the account wipes that label's stored
identity, groups, KeyPackages, and invites, generates a fresh key, publishes the
new profile + relay lists, and reconnects in place. (Use a different `--name`
instead if you want to keep both accounts around.)

## Compile a standalone binary

```bash
pnpm --filter marmot-opentui compile        # or: cd here && bun run compile
./dist/marmot-opentui --name alice
```

`compile` runs `bun build --compile` (see `scripts/compile.ts`) and produces a
single, self-contained executable in `dist/` — no Bun or `node_modules` needed
to run it. OpenTUI's native renderer (`libopentui.so`) is embedded into the
binary, so the artifact is **platform-specific**: it targets the OS/arch you
build on. The same runtime flags apply (`--name`, `--sec`, …).

## Debug with VS Code

This repo includes VS Code debug configurations for the OpenTUI example.

To attach to a running TUI process, start Bun with the inspector enabled:

```bash
cd examples/opentui
bun --inspect=9229 run src/index.tsx --name alice --logs ./alice.log
```

Then run **Attach: OpenTUI Bun (9229)** from VS Code's Run and Debug panel.
Use **Launch: OpenTUI Bun Inspector** if you want VS Code to start the process
for you in an integrated terminal.

## Using it

There are no slash-commands or action buttons. The UI follows a lazygit-style
keyboard model: one panel is focused, the focused panel has a gold border, and
the footer shows the keys that apply right now.

**Global keys:**

- **Tab / Shift+Tab** — cycle panels: **groups**, **invites**, **chat**.
- **h/l** or **←/→** — move focus to the previous/next panel.
- **j/k** or **↑/↓** — move the selection inside the focused list panel.
- **?** or **:** — open keyboard help for the current panel.
- **q** or **Ctrl+C** — quit.

**Panel keys:**

- **Groups** — **Enter** opens the selected group, **n** creates a group,
  **i** invites to the active group, **e** edits the selected group's info when
  you are an admin, **L** leaves the active group.
- **Invites** — **Enter** or **a** accepts the selected invite, **d** dismisses
  it (drops it from the list without joining). Only invites whose KeyPackage you
  still hold are listed; ones you can't accept are filtered out.
- **Chat** — **n** or **Enter** starts composing a message; the input stays
  focused after each **Enter** so you can send several in a row, and **Esc**
  stops composing. **r** enters reply-select mode: **j/k** move a cursor
  through the timeline (starting at the newest message), **Enter** picks the
  highlighted message and starts composing the reply, and **Esc** cancels. The
  reply carries a NIP-C7 `q` tag quoting the target and a banner names it while
  you type. **c** enters react-select mode: **j/k** move the same timeline
  cursor, and the number keys **1**–**6** react to the highlighted message with
  an emoji from the palette shown above the composer (👍 ❤️ 😂 🎉 😮 😢), and
  **Esc** cancels. Reactions are NIP-25 kind 7 application messages and appear as
  aggregated `emoji count` chips under each message (your own reactions are
  highlighted). **i** invites to the active group, **m** opens the
  members list, **g** opens the group debug view, **e** edits the active
  group's info when you are an admin, **R** opens relay settings, **p** opens
  profile settings, and **K** opens the KeyPackage publish/rotate chooser.
- **Profile** — **i** shows your invite QR, **p** edits your profile, **r** edits
  your relays, **K** opens the KeyPackage chooser, and **o** logs out and creates
  a fresh account (prompting for a name and optional relays).

Text prompts use **Enter** to confirm and **Esc** to cancel. Clicking a panel
still focuses it, but the intended path is keyboard-first.

**Managing your relays.** `Relays` edits the two relay lists this account
advertises on Nostr, each a whitespace/comma-separated list of `wss://` URLs:

- **Outbox** — your **NIP-65** list (kind 10002). Marmot reads it to discover
  where you publish your KeyPackages, so peers fetch them from here when they
  invite you.
- **Inbox** — your **kind 10050** list. This is where gift-wrapped welcomes are
  delivered to you.

After the UI is ready, the app loads whatever you've already published in the
background so your edits survive restarts without blocking startup. Pressing
Enter in the Relays modal re-signs and republishes both lists; the values are
normalised, de-duplicated, and stripped of invalid URLs before publishing.

A two-party session: copy each peer's npub from the header (or click it to show
a scannable QR code), press **n** in the groups panel and name a group, press
**i** and paste the other's npub. The app fetches that peer's published
KeyPackages and lists them newest-first; **space** selects which device(s) to
invite, **f** toggles between only-invitable and all KeyPackages (each row shows
whether it's invitable to this group or why not), and **Enter** sends the
invite(s). On the other side focus **invites** and press **Enter** or **a** to
join.

## Known-divergent — avoid in interop tests

These map to open items in the repo's `SPEC_GAP_REVIEW.md` and are inherited
from the shared lifecycle (they do **not** break happy-path turn-taking chat):

- **Concurrent commits** (two members committing at once) — convergence /
  quiescence settlement is not implemented yet (gap **B5**).
- **`/leave`** — sends a plain MLS `Remove`; spec peers expect MLS `SelfRemove`
  with a deterministic auto-committer (gap **B6**). The status log warns you
  when `--logs <path>` is enabled.
- **Heavy message reordering / dropped relays** — out-of-order inputs are not
  yet retried via the `deferred` disposition (gap **B7**).
