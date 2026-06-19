# Proposals

Group changes — adding members, removing members, updating metadata, leaving — are expressed as MLS **proposals** that an admin gathers into a **commit**. The `Proposals` namespace provides type-safe builders for the common Marmot operations.

```typescript
import { Proposals } from "@internet-privacy/marmot-ts";
```

Each builder returns a `ProposalAction` — an async function `(context) => Proposal | Proposal[]` that is resolved against the current group state when the commit is built. You usually pass these actions straight into `client.groups.commit(...)` via `extraProposals`; the session resolves and applies them in a single epoch advance.

## Inviting users

`proposeInviteUser` builds an Add proposal from a key package event (or a raw `KeyPackage`). The invitee's LeafNode must carry a valid `marmot.account-identity-proof.v1` — the builder verifies it and throws if it is missing or invalid.

For a single invite, the `client.groups.invite` shortcut handles the commit and Welcome delivery for you:

```typescript
await client.groups.invite(group.id, keyPackageEvent);
```

To add several key packages (e.g. multiple devices) in one commit, build the proposals explicitly and supply `welcomeRecipients` so each invitee receives a gift-wrapped Welcome:

```typescript
import type { WelcomeRecipient } from "@internet-privacy/marmot-ts/client";

const events = [keyPackageEventA, keyPackageEventB];

const welcomeRecipients: WelcomeRecipient[] = events.map((event) => ({
  pubkey: event.pubkey,
  keyPackageEventId: event.id,
  keyPackageEvent: event,
}));

await client.groups.commit(group.id, {
  extraProposals: events.map((event) => Proposals.proposeInviteUser(event)),
  welcomeRecipients,
});
```

## Removing users

`proposeRemoveUser(pubkey)` removes **all** leaf nodes (devices) belonging to a Nostr user. It throws if the user is not a member.

```typescript
await client.groups.commit(group.id, {
  extraProposals: [Proposals.proposeRemoveUser(memberPubkey)],
});
```

## Updating metadata

`proposeUpdateMetadata(fields)` produces a single app-data update proposal. All fields are optional; only the ones you set change. Supported fields map onto the group's app components:

```typescript
await client.groups.commit(group.id, {
  extraProposals: [
    Proposals.proposeUpdateMetadata({
      name: "Engineering",
      description: "Secure team chat",
      adminPubkeys: [alice, bob],
      relays: ["wss://relay.example.com"],
      avatarUrl: "https://example.com/avatar.png",
      messageRetention: 0, // seconds; 0 = retain indefinitely
    }),
  ],
});
```

You can combine it with other proposals in the same commit — for example, removing a member and shrinking the admin set at once:

```typescript
await client.groups.commit(group.id, {
  extraProposals: [
    Proposals.proposeRemoveUser(memberPubkey),
    Proposals.proposeUpdateMetadata({ adminPubkeys: remainingAdmins }),
  ],
});
```

## Leaving a group

A member leaves with an MLS `self_remove` proposal. Because RFC 9420 forbids a committer from removing their own leaf, the proposal is committed by **another** member (the deterministically-elected auto-committer or an admin), not by the leaver. The high-level helper publishes the proposal for you:

```typescript
await client.groups.leave(group.id);
```

The builder `Proposals.proposeLeaveGroup(ownPubkey)` is available if you need the raw action.

## Combining proposals into a commit

`client.groups.commit(groupId, options)` accepts:

| Option              | Type                                      | Purpose                                                       |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `extraProposals`    | `(Proposal \| ProposalAction \| array)[]` | Proposals (or builders) to include in this commit             |
| `proposalRefs`      | `string[]`                                | References to proposals already broadcast to the group        |
| `welcomeRecipients` | `WelcomeRecipient[]`                      | Invitees to deliver gift-wrapped Welcomes to after the commit |

Committing requires admin rights. The commit advances the group epoch, is published as a kind 445 event, and (when adding members) delivers a kind 444 Welcome inside a kind 1059 gift wrap to each recipient.

::: tip Standalone proposals
To broadcast a proposal without committing it immediately, use `group.propose(action)` or `group.sendProposal(proposal)`. Other members collect it and an admin commits it later (reference it via `proposalRefs`).
:::

## Next steps

- **[MarmotGroup](/client/marmot-group)** — the group surface that hosts commits and events
- **[Members](/core/members)** — how membership maps to MLS leaf nodes
- **[Welcome Messages](/core/welcome)** — how invitees join from a Welcome
