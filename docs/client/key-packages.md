# Key Packages

A key package (kind 30443) is what other people need to add you to a group. This page covers publishing and maintaining yours with `client.keyPackages`, and publishing the relay lists peers use to find you.

## Give each install a slot id

Every install publishes its key package into one addressable slot: the event's `d` tag. Pass it to the client as `clientId`. It must be 32 random bytes written as 64 lowercase hex characters. Generate it once, persist it, and reuse it on every start.

```typescript
import { MarmotClient } from "@internet-privacy/marmot-ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// `settings` stands in for your app's own persistent settings storage
let clientId = await settings.get("marmotKeyPackageSlot");
if (!clientId) {
  clientId = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await settings.set("marmotKeyPackageSlot", clientId);
}

const client = new MarmotClient({
  signer,
  network,
  storage,
  clientId,
});
```

::: warning Never derive the slot id
Don't build the slot id from a device name, a pubkey or any other identity material, and don't regenerate it on every start. Publication rejects anything that is not 64 lowercase hex characters. Without a `clientId` (or an explicit `identifier`), `create()` and `ensurePublished()` throw `MissingSlotIdentifierError`.
:::

## Publish your relay lists

Peers fetch your key packages from the **write** relays in your NIP-65 list (kind 10002), and they deliver Welcomes to your inbox relays (kind 10050). Publish both before you expect invites.

```typescript
import {
  createInboxRelayListEvent,
  createNip65RelayListEvent,
} from "@internet-privacy/marmot-ts";

const pubkey = await client.signer.getPublicKey();
const outboxRelays = ["wss://relay.example.com"]; // where your key packages live
const inboxRelays = ["wss://inbox.example.com"]; // where you receive Welcomes

const nip65 = await client.signer.signEvent(
  createNip65RelayListEvent({ pubkey, relays: outboxRelays }),
);
const inbox = await client.signer.signEvent(
  createInboxRelayListEvent({ pubkey, relays: inboxRelays }),
);

// Also publish to well-known lookup relays (e.g. "wss://purplepag.es")
// so peers can find the lists
await client.network.publish([...outboxRelays, ...lookupRelays], nip65);
await client.network.publish([...outboxRelays, ...lookupRelays], inbox);
```

`createNip65RelayListEvent` writes unmarked `r` tags (read and write) unless you pass `usage: "read" | "write"`.

## Read someone's relay lists

Use `getNip65Relays` and `getInboxRelays` to read lists you fetched. You need a peer's write relays to [invite them](/client/groups#invite-members). Your network adapter's `getUserInboxRelays` does the inbox lookup for Welcome delivery (see [Network](/client/network)).

```typescript
import { getInboxRelays, getNip65Relays } from "@internet-privacy/marmot-ts";
import type { NostrEvent } from "applesauce-core/helpers/event";

const newest = (events: NostrEvent[]) =>
  events.sort((a, b) => b.created_at - a.created_at)[0];

const nip65 = newest(
  await client.network.request(lookupRelays, [
    { kinds: [10002], authors: [peerPubkey] },
  ]),
);
const writeRelays = nip65 ? getNip65Relays(nip65, "write") : [];

const inbox = newest(
  await client.network.request(lookupRelays, [
    { kinds: [10050], authors: [peerPubkey] },
  ]),
);
const inboxRelays = inbox ? getInboxRelays(inbox) : [];
```

`getNip65Relays(event, "write")` keeps relays marked `write` and unmarked ones.

## Keep a key package published

Call `ensurePublished` on every startup. It does nothing if this slot already has an unused key package with a currently valid lifetime; otherwise it creates and publishes a new one.

```typescript
await client.keyPackages.ensurePublished({ relays: outboxRelays });
```

To publish unconditionally, call `create`. It generates the key material, stores the private part in the client's `storage`, and publishes the kind 30443 event to `relays`:

```typescript
const keyPackage = await client.keyPackages.create({
  relays: outboxRelays,
  client: "my-chat-app", // optional client tag
});
```

Kind 30443 is addressable, so a new package in the same slot replaces the old event on relays. To have several packages discoverable at once, pass a different random `identifier` (also 64 lowercase hex) for each extra slot.

Key packages are last-resort (reusable) by default, so one published package can be used for several invites while you are offline. Pass `isLastResort: false` to create a single-use package instead.

## List and watch your key packages

`list()` returns everything in the local store, without private material. Each entry has `keyPackageRef`, `identifier`, `published` events and a `used` flag. `nonCurrent: true` marks old packages that lack a current account identity proof.

```typescript
const packages = await client.keyPackages.list();
const used = packages.filter((pkg) => pkg.used);
```

`watchKeyPackages()` yields the same list now and after every change. Pass a `signal` to stop it (see [UI Frameworks](/client/ui-frameworks)).

```typescript
for await (const packages of client.keyPackages.watchKeyPackages({ signal })) {
  renderKeyPackages(packages);
}
```

## Rotate a used key package

After you [join a group](/client/invites#after-joining), the consumed package is marked `used`. Rotate it: `rotate` publishes a replacement in the same slot (relays replace the old event) and deletes the old package's private material.

```typescript
for (const pkg of await client.keyPackages.list()) {
  if (pkg.used) await client.keyPackages.rotate(pkg.keyPackageRef);
}
```

By default the replacement goes to the same relays as the old one; pass `{ relays }` to change them. Rotating periodically, not only after use, also limits the impact of a leaked key.

## Delete key packages

- `remove(ref)` deletes the local copy only. Nothing is published, so the event stays discoverable on relays.
- `purge(ref | refs[])` publishes a NIP-09 deletion (kind 5) for the package's events, then deletes the local copy.

```typescript
// Retire old packages that can no longer be used for invites
const stale = (await client.keyPackages.list()).filter((pkg) => pkg.nonCurrent);
if (stale.length > 0)
  await client.keyPackages.purge(stale.map((pkg) => pkg.keyPackageRef));
```

::: warning Removing private material breaks pending invites
A Welcome sent to a key package can only be opened while you still hold its private material. After `remove`, `purge` or `rotate`, invites addressed to that package show up as not [`joinable`](/client/invites#watch-for-invites).
:::

## Related

- [Invites](/client/invites): receive Welcomes and join groups
- [Groups](/client/groups#invite-members): fetch and evaluate someone else's key package
- [API reference](pathname:///reference/index.html): `KeyPackageManager` options and errors
