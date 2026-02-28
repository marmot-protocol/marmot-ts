# Proposals

Type-safe proposal builders for group operations.

## Available Proposals

### Invite User

```typescript
import { Proposals } from "@internet-privacy/marmots";

await group.propose(Proposals.proposeInviteUser(keyPackageEvent));

// Or with inline commit
await group.commit({
  by: [Proposals.proposeInviteUser(keyPackageEvent)],
});
```

### Remove User

Removes all devices for a user:

```typescript
import { Proposals } from "@internet-privacy/marmots";

await group.propose(Proposals.proposeKickUser(targetPubkey));
```

### Update Metadata

Updates group metadata (partial updates supported):

```typescript
import { Proposals } from "@internet-privacy/marmots";

await group.propose(
  Proposals.proposeUpdateMetadata({
    name: "New Group Name",
    description: "Updated description",
    relays: ["wss://new-relay.com"],
    adminPubkeys: [...existingAdmins, newAdmin],
  }),
);
```

## Custom Proposals

You can create custom proposal functions:

```typescript
// Define custom proposal action
const myProposal: ProposalAction = async (context) => {
  const { state, ciphersuite, groupData } = context;

  // Return Proposal or Proposal[]
  return createCustomProposal(/* ... */);
};

// Use it
await group.propose(myProposal);
```

## Proposal System Types

```typescript
// Context passed to proposal actions
interface ProposalContext {
  state: ClientState;
  ciphersuite: CiphersuiteImpl;
  groupData: MarmotGroupData;
}

// Proposal action function
type ProposalAction<T extends Proposal | Proposal[]> = (
  context: ProposalContext,
) => Promise<T>;

// Proposal builder (higher-order function)
type ProposalBuilder<Args, T> = (...args: Args) => ProposalAction<T>;
```

## Workflow

1. **Propose:** Create and send proposal to group
2. **Wait:** Proposals are pending until committed
3. **Commit:** Admin creates commit with proposals
4. **Sync:** All members process commit and apply changes

## Best Practices

- **Batch proposals:** Combine multiple proposals in one commit for efficiency
- **Admin coordination:** Multiple admins should coordinate to avoid conflicting commits
- **Verify before commit:** Check proposals are valid before committing

See [MarmotGroup](./marmot-group) for usage examples.
