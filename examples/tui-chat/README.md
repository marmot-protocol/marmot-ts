# marmot-tui-chat

A minimal terminal chat client built on `@internet-privacy/marmot-ts`. It speaks
the darkmatter **Marmot v2** wire format and is intended to interoperate with
peers running the Rust crates (`darkmatter/crates`) **on the happy path**:

> publish KeyPackage → discover peer → invite → welcome → join → exchange text

It is a demo, not a product: a tiny `WebSocket` relay pool, a JSON file store,
and a readline prompt. Use it to exercise and prove cross-implementation interop.

## What it demonstrates

Every wire surface this app touches was verified byte-for-byte against the Rust
reference:

- KeyPackage events (kind `30443`) with the full required tag set and standard
  base64 — no forbidden `encoding` tag.
- NIP-65 discovery (kind `10002`, `r` tags) and inbox relays (kind `10050`,
  `relay` tags).
- Welcome via gift wrap (kind `1059`) wrapping a kind `444` rumor.
- Group messages (kind `445`): `MLS-Exporter("marmot","group-event",32)` →
  ChaCha20-Poly1305, 12-byte nonce, empty AAD, `base64(nonce‖ciphertext)`.
- Mandatory account identity proof (`0xf2f1`, BIP-340) on every leaf.

## Prerequisites

Build the library first (the example imports its built `dist/`):

```bash
pnpm install          # from the repo root
pnpm build            # builds @internet-privacy/marmot-ts
```

## Run

```bash
# from the repo root
pnpm --filter marmot-tui-chat start -- --name alice
# in a second terminal
pnpm --filter marmot-tui-chat start -- --name bob
```

### Flags

| Flag             | Default                                 | Meaning                                                         |
| ---------------- | --------------------------------------- | --------------------------------------------------------------- |
| `--name <label>` | `default`                               | Profile name; data + identity live in `~/.marmot-tui/<label>/`. |
| `--relay <url>`  | `wss://relay.damus.io`, `wss://nos.lol` | Repeatable. Point all peers at the **same** relay(s).           |
| `--sec <hex>`    | (generated)                             | Use a specific 32-byte hex Nostr secret key.                    |
| `--ephemeral`    | off                                     | Keep all state in memory (nothing written to disk).             |
| `--debug`        | off                                     | Print full stack traces (and `cause` chains) on errors.         |

> Many public relays reject MLS event kinds (443/30443/444/445/1059). For
> reliable testing, run a permissive local relay (e.g. `strfry`,
> `nostr-rs-relay`) and pass it with `--relay ws://localhost:<port>`. Point your
> Rust peer at the same relay.

On startup with an **existing** identity, the app looks up your published NIP-65
(kind 10002) relay list on the bootstrap relays and adopts those relays for the
session (unioned with any `--relay` you pass), so a returning user doesn't have
to re-specify them. A brand-new identity just uses the bootstrap relays and
publishes a fresh NIP-65 list to them.

## A two-party session

```
# terminal A (alice)
/whoami                      # copy alice's npub (hex also shown)
/new demo                    # create a group, becomes active

# terminal B (bob)
/whoami                      # copy bob's npub

# terminal A
/invite <bob-npub-or-hex>    # discovers bob's KeyPackage and sends a welcome

# terminal B
/invites                     # the welcome shows up
/join 0                      # join; group becomes active
hello from bob               # plain text -> sent to the group

# terminal A
hi bob                       # messages flow both ways
```

`/invite` accepts an `npub` (NIP-19) or a 64-char hex pubkey.

## KeyPackage management

Your KeyPackage (kind 30443) is what lets others invite you. The app publishes
one on first run; manage it with:

```
/keypackage            # or /keypackage show — list stored KeyPackages
/keypackage publish    # publish a fresh KeyPackage to your relays
/keypackage rotate     # replace this device's KeyPackage (same slot), cleaning up the old one
```

`show` marks the entry for this device (`this-client`) and whether each is
`active` or `used` (consumed by a join). Rotate publishes a new package under the
same `d`-slot — relays supersede the old kind 30443 automatically; legacy kind
443 packages also get a NIP-09 deletion.

To interop with a Rust peer, have the Rust client publish its KeyPackage +
NIP-65 (10002) + inbox (10050) to the shared relay, then `/invite` its npub
(or have it invite you and `/join`).

## Known-divergent — avoid in interop tests

These map to open items in the repo's `SPEC_GAP_REVIEW.md`. They do **not** break
happy-path turn-taking chat, but will fork against a spec-conformant peer:

- **Concurrent commits** (two members committing at once) — convergence
  status / quiescence settlement is not implemented yet (gap **B5**).
- **`/leave`** — sends a plain MLS `Remove`; spec peers expect MLS `SelfRemove`
  with a deterministic auto-committer (gap **B6**). The command warns you.
- **Heavy message reordering / dropped relays** — out-of-order inputs are not
  yet retried via the `deferred` disposition (gap **B7**).

Keep early interop tests to turn-taking text with no departures, and these are
non-issues.

## Layout

| File                   | Role                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `src/index.ts`         | CLI args, identity, stores, readline loop, commands.                            |
| `src/chat.ts`          | `ChatApp` — the marmot-ts lifecycle (publish / invite / join / send / receive). |
| `src/relay-pool.ts`    | `RelayPool` — `NostrNetworkInterface` adapter over `applesauce-relay`.          |
| `src/file-store.ts`    | `FileKeyValueStore` — JSON persistence with `Uint8Array`/`bigint` tagging.      |
| `src/account-proof.ts` | Builds the mandatory account-identity-proof signer from the local key.          |
