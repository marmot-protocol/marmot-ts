# Invites

When someone adds you to a group, they send you a Welcome gift-wrapped (kind 1059) to your inbox relays. This page covers receiving those invites with `client.invites`, showing them to the user, and joining.

## Listen for invites

Call `client.invites.listen()` with your kind 10050 inbox relays (see [Key Packages](/client/key-packages#publish-your-relay-lists)). It subscribes for gift wraps addressed to you, decrypts them with your signer, and stores the result as an unread invite.

```typescript
const inviteSync = await client.invites.listen(inboxRelays);

// On shutdown
inviteSync.unsubscribe();
```

Listening on any other relays silently misses invites. Received and unread invites are kept in the client's `storage`, so with a durable storage they survive a restart (see [Storage](/client/storage)).

## Watch for invites

`client.watchInvites()` yields the unread invites now and after every change. Each entry carries `joinable`: whether you still hold the key package the Welcome was sent to. An invite to a key package you have rotated or deleted can't be joined.

```typescript
for await (const invites of client.watchInvites({ signal })) {
  renderInvites(invites.filter(({ joinable }) => joinable));
}
```

`client.invites.watchUnread()` yields the same list without the `joinable` flag, and `client.invites.getUnread()` reads it once. Invites stay unread until you call `markAsRead`:

```typescript
await client.invites.markAsRead(invite.id);
```

## Preview an invite

Before joining, show the user who sent the invite and what group it is for. `previewWelcome()` never throws; `group` is `null` if the Welcome can't be decrypted with a key package you hold.

```typescript
const preview = await client.previewWelcome(invite);

console.log("From:", invite.pubkey); // the inviter
console.log("Group:", preview.group?.name, preview.group?.description);
console.log("Admins:", preview.group?.adminPubkeys);
```

::: warning Confirm the inviter before joining
On first contact, the library checks that the Welcome is validly signed by an admin of the group it describes. It can't tell whether that group is the one the user expects: anyone can create a group with any name and admin list, and an existing member can fork a group and rewrite its admins. Confirm the inviter (`invite.pubkey`) through your app's own contact or trust flow before treating the group as genuine.
:::

## Join a group

`client.joinGroupFromWelcome()` validates the Welcome, finds the matching key package, saves the new group and returns it. The group is added to `client.groups` and the `joined` event fires.

```typescript
const { group } = await client.joinGroupFromWelcome({ welcomeRumor: invite });
await client.invites.markAsRead(invite.id);
```

It throws if no matching key package is held, the inviter is not an admin of the group, a member's identity proof is invalid, the group needs features this client doesn't support, the group is no longer active, or you already have this group. A rejected Welcome leaves your existing groups and key packages untouched.

If you use `connectAll()`, the new group starts receiving messages automatically (see [Messages](/client/messages)).

## After joining

The library leaves two follow-up steps to you.

**Rotate your leaf key.** Call `group.selfUpdate()` promptly, and before sending messages if you can, so that keys from the Welcome stop protecting your traffic. The commit is queued until the group settles, so you can call it right after joining.

**Replace the used key package.** Joining marks the consumed key package `used`. A single-use package's private material is deleted at that point; a reusable (last-resort, the default) package keeps it so it can accept more invites. Either way, rotate it so you have a fresh, unused package published, and so reusable private material doesn't linger:

```typescript
await group.selfUpdate();

for (const pkg of await client.keyPackages.list()) {
  if (pkg.used) await client.keyPackages.rotate(pkg.keyPackageRef);
}
```

`rotate` publishes a replacement in the same slot and deletes the old private material (see [Key Packages](/client/key-packages#rotate-a-used-key-package)).

## Complete example

```typescript
const inviteSync = await client.invites.listen(inboxRelays);
const groupSync = client.groups.connectAll();

for await (const invites of client.watchInvites({ signal })) {
  for (const { invite, joinable } of invites) {
    if (!joinable) continue;

    const preview = await client.previewWelcome(invite);
    if (!(await askUserToAccept(invite.pubkey, preview))) {
      await client.invites.markAsRead(invite.id);
      continue;
    }

    const { group } = await client.joinGroupFromWelcome({
      welcomeRumor: invite,
    });
    await client.invites.markAsRead(invite.id);
    await group.selfUpdate();

    for (const pkg of await client.keyPackages.list()) {
      if (pkg.used) await client.keyPackages.rotate(pkg.keyPackageRef);
    }
  }
}
```

## Retry invites that failed to decrypt

`listen()` tries each gift wrap once. If decryption failed because the signer was unavailable or the user declined a prompt, the gift wrap stays in `client.invites.getReceived()`. Retry them explicitly once the signer is back; this may prompt the signer again.

```typescript
await client.invites.decryptGiftWraps();
```

Listen to `client.invites.on("error", (error, eventId) => ...)` to see failures as they happen.
