# Groups

This page covers the group lifecycle with `client.groups` and `MarmotGroup`: creating, loading, inviting, removing, leaving, disbanding and changing metadata. Sending and receiving messages is on [Messages](/client/messages).

## Create a group

`client.groups.create(name, options)` builds a new group with you as its only member and an admin. Nothing is published until you invite someone or send a message.

```typescript
const group = await client.groups.create("Engineering", {
  description: "Secure team chat",
  relays: ["wss://relay.example.com"], // where group traffic (kind 445) is published
  adminPubkeys: [alicePubkey], // extra admins; you are always one
});

console.log(group.idStr); // hex MLS group id, use it with client.groups.*
```

Without `relays` the group has no Nostr routing and cannot publish, so pass them unless you are only experimenting locally. To enable encrypted attachments at creation, see [Media](/client/media).

## Create a group with founding members

Pass the invitees' key package events as `invitees`. They become members right away and each gets a Welcome. `relays` is required in this case.

```typescript
const group = await client.groups.create("Engineering", {
  relays: ["wss://relay.example.com"],
  invitees: [aliceKeyPackageEvent, bobKeyPackageEvent],
});

// create() does not throw when a Welcome fails to send: check and retry
for (const outcome of group.pendingWelcomes) {
  await group.retryWelcome(outcome.recipient.pubkey);
}
```

::: warning Welcome results are kept in memory only
`group.pendingWelcomes` and `retryWelcome()` only work while this group instance stays loaded. After a restart, a member whose Welcome never arrived can't be reached this way; remove them and invite a fresh key package instead.
:::

## Load, unload and destroy groups

Groups are loaded from storage on demand and cached in memory.

```typescript
const group = await client.groups.get(groupId); // Uint8Array or hex string
const all = await client.groups.loadAll();

await client.groups.unload(groupId); // free memory, keep storage
await client.groups.destroy(groupId); // delete local state and history
```

`client.groups.watch()` yields the stored group list now and after every create, join, load or destroy. Pass `{ includeStateChanges: true }` to also re-yield when a loaded group's state changes, without reading storage. See [UI Frameworks](/client/ui-frameworks) for using these in React, Svelte and others.

```typescript
for await (const groups of client.groups.watch({ signal })) {
  renderGroupList(groups);
}
```

## Read group state

```typescript
import { getGroupMemberPubkeys } from "@internet-privacy/marmot-ts";

group.groupData?.name; // also description, adminPubkeys, relays, avatarUrl
group.info.members.pubkeys; // member pubkeys
getGroupMemberPubkeys(group.state); // same, from raw MLS state
group.info.mls.epoch; // current epoch
group.status; // "active" | "removed" | "disbanded"
```

`groupData` is `null` once a group is disbanded. A `"removed"` group keeps its local state so you can show it; call `client.groups.destroy()` when you no longer need it. For a cheap, cached value to render, use `group.snapshot` and the `changed` event (see [UI Frameworks](/client/ui-frameworks)).

## Invite members

Fetch the person's key packages from their NIP-65 write relays (see [Key Packages](/client/key-packages#read-someone-s-relay-lists)), keep one this group can accept, and invite it. Membership changes require an admin.

```typescript
const candidates = await client.network.request(writeRelays, [
  { kinds: [30443], authors: [memberPubkey] },
]);

const keyPackageEvent = candidates
  .sort((a, b) => b.created_at - a.created_at)
  .find((event) => group.evaluateKeyPackage(event).eligible);

if (keyPackageEvent) await client.groups.invite(group.id, keyPackageEvent);
```

`evaluateKeyPackage` checks the cipher suite, required capabilities, lifetime and existing membership; when `eligible` is `false`, `reasons` says why. `invite()` verifies the event, publishes the commit and, once a relay accepts it, gift-wraps a Welcome to the invitee's inbox relays.

## Invite several key packages at once

To add several people, or every device of one person, put all the Adds in one commit with `createInviteIntent`. Sending it through `client.groups.send` also returns each invitee's Welcome result.

```typescript
import { createInviteIntent } from "@internet-privacy/marmot-ts";

const actorPubkey = await client.signer.getPublicKey();
const intents = eligibleEvents.map((keyPackageEvent) =>
  createInviteIntent({ keyPackageEvent, actorPubkey }),
);

const [result] = await client.groups.send(group.id, {
  kind: "commit",
  actorPubkey,
  extraProposals: intents.flatMap((intent) => intent.extraProposals ?? []),
  welcomeRecipients: intents.flatMap(
    (intent) => intent.welcomeRecipients ?? [],
  ),
});

if (result.welcomeDelivery.kind === "attempted") {
  for (const outcome of result.welcomeDelivery.outcomes)
    if (outcome.kind === "failed")
      console.warn(outcome.recipient.pubkey, outcome.error);
}
```

## Remove members

`Proposals.proposeRemoveUser(pubkey)` removes every device the user has in the group. Commit it as an admin:

```typescript
import { Proposals } from "@internet-privacy/marmot-ts";

await client.groups.commit(group.id, {
  extraProposals: [Proposals.proposeRemoveUser(memberPubkey)],
});
```

If the removed user was an admin, they are dropped from the admin list in the same commit. A commit that would leave the group with no admin is refused.

## Leave a group

`leave()` publishes a self-remove proposal, then deletes your local copy of the group. Another member commits your removal later.

```typescript
await client.groups.leave(group.id);
```

If no relay accepts the proposal, `leave()` throws and keeps local state so you can try again.

## Disband a group

An admin can end a group for everyone. `disband()` removes every other member and marks the group disbanded in one commit. It returns a result rather than throwing:

```typescript
const result = await group.disband();
if (result.kind === "rejected" && result.reason === "notEnabled") {
  // Groups created by older clients must turn disbanding on first
  await group.enableDisbanding();
}
```

Groups created by this library have disbanding enabled already, so `enableDisbanding()` returns `{ kind: "alreadyEnabled" }` for them. It fails with `reason: "unsupportedMembers"` if a member's client can't handle disbanding. Once the disband commit is selected, `group.status` becomes `"disbanded"` and the `disbanded` event fires on every member's client.

## Update metadata

`Proposals.proposeUpdateMetadata` changes only the fields you pass. Commit it as an admin:

```typescript
await client.groups.commit(group.id, {
  extraProposals: [
    Proposals.proposeUpdateMetadata({
      name: "Engineering (new)",
      relays: ["wss://relay.example.com", "wss://relay2.example.com"],
    }),
  ],
});
```

Supported fields are `name`, `description`, `adminPubkeys`, `relays`, `avatarUrl`, `messageRetention` (seconds; `0` keeps messages indefinitely), `encryptedMedia` and `nostrGroupId`. For group images, see [Group Images](/client/group-images).

## Combine changes in one commit

`client.groups.commit` accepts any mix of proposal builders in `extraProposals`, so related changes land in one epoch:

```typescript
await client.groups.commit(group.id, {
  extraProposals: [
    Proposals.proposeRemoveUser(memberPubkey),
    Proposals.proposeUpdateMetadata({ adminPubkeys: remainingAdmins }),
  ],
});
```

| Builder                                  | Effect                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `proposeInviteUser(keyPackageEvent)`     | Add one key package (prefer `createInviteIntent`, which also checks the event and sends the Welcome) |
| `proposeRemoveUser(pubkey)`              | Remove all of a user's devices                                                                       |
| `proposeUpdateMetadata(fields)`          | Change name, admins, relays and so on                                                                |
| `proposeSetEncryptedMediaPolicy(policy)` | Turn encrypted media on, change it or turn it off ([Media](/client/media))                           |
| `proposeLeaveGroup(ownPubkey)`           | Self-remove; use `client.groups.leave` instead                                                       |

To publish a proposal without committing it, use `group.propose(action)`. An admin can later commit received proposals by passing keys of `group.unappliedProposals` as `proposalRefs`. Any member can rotate their own keys with `group.selfUpdate()`.

## Recover a failed publication

If the relays' answer to a commit is uncertain, the commit throws `PublicationUncertainError` and the group waits. Retry the same commit instead of building a new one:

```typescript
import { PublicationUncertainError } from "@internet-privacy/marmot-ts";

try {
  await client.groups.commit(group.id, options);
} catch (error) {
  if (!(error instanceof PublicationUncertainError)) throw error;
  await group.retryPendingPublication();
}
```

Every new send also retries an outstanding publication first. Pending publications are kept in the client's `storage`, so with a durable storage they survive a restart (see [Storage](/client/storage)). For founding Welcomes that failed, use `retryWelcome()` as shown in [Create a group with founding members](#create-a-group-with-founding-members).

## Events

`client.groups` emits events for every group:

| Event                             | Fires when                                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| `created` / `joined` / `imported` | A group was created, joined from a Welcome, or imported                    |
| `loaded` / `unloaded`             | A group was loaded from or dropped from memory                             |
| `updated`                         | The set of loaded groups changed                                           |
| `changed`                         | The loaded set or any loaded group's snapshot changed                      |
| `destroyed` / `left`              | Local state was deleted, or you left the group                             |
| `removed`                         | Someone else's commit removed you                                          |
| `disbanded`                       | The group was disbanded                                                    |
| `ingestResult`                    | A connected group produced an ingest result ([Messages](/client/messages)) |
| `rejected` / `unreadable`         | A connected group's event failed validation or could not be read           |

Each `MarmotGroup` emits events about itself:

| Event                | Fires when                                                   |
| -------------------- | ------------------------------------------------------------ |
| `changed`            | `group.snapshot` changed                                     |
| `applicationMessage` | A message was decrypted ([Messages](/client/messages))       |
| `ingestResult`       | Ingest produced a result                                     |
| `stateChanged`       | The MLS state advanced                                       |
| `stateSaved`         | The state was written to storage                             |
| `removed`            | You were removed from the group                              |
| `disbanded`          | The group was disbanded                                      |
| `historyChanged`     | The fork history grew ([Fork History](/client/fork-history)) |
| `historyError`       | Saving to history failed                                     |
| `disposed`           | The instance was unloaded and its watchers ended             |
| `destroyed`          | Local state was deleted                                      |

```typescript
client.groups.on("removed", (groupId) => markInactive(groupId));
group.on("disbanded", (g, { actorPubkey }) => showDisbandedBy(actorPubkey));
```

See the [API reference](pathname:///reference/index.html) for every option and result type.
