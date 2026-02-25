# Welcome Messages

Welcome messages enable new members to join existing groups. They contain the group's current state and secrets.

## What is a Welcome Message?

When someone is added to a group, they receive a Welcome message containing:

- Current group state
- Encryption keys for the current epoch
- Member list
- Group context (including MarmotGroupData)

The Welcome allows them to decrypt past messages from the current epoch and participate in the group.

## Creating Welcome Rumors

After creating a commit that adds members, you get Welcome messages:

```typescript
import { createWelcomeRumor } from "@internet-privacy/marmots";

// After MLS createCommit with add proposals
const { welcome } = commitResult;

const welcomeRumor = createWelcomeRumor({
  welcome, // Welcome from MLS commit
  relays: groupRelays, // Array of relay URLs
  keyPackageEventId, // Optional: the key package event ID used
  author: myEphemeralPubkey, // Nostr pubkey for this rumor
});

// welcomeRumor is kind 444, ready to be gift-wrapped
```

### Event Structure

```
kind: 444
content: base64-encoded Welcome message
tags:
  - ["relays", ...groupRelays]
  - ["e", keyPackageEventId] (optional)
  - ["encoding", "base64"]
```

## Distributing Welcome Messages

Welcome messages are wrapped in NIP-59 gift wraps for privacy (MIP-00):

```typescript
import { createWelcomeRumor } from "@internet-privacy/marmots";
import { createGiftWrap } from "applesauce-core/nip59";

// 1. Create welcome rumor
const welcomeRumor = createWelcomeRumor({
  welcome,
  relays,
  keyPackageEventId: kpEventId,
  author: myEphemeralPubkey,
});

// 2. Wrap in gift wrap
const giftWrap = await createGiftWrap(
  welcomeRumor,
  recipientPubkey,
  senderPrivateKey,
);

// 3. Send to recipient's relay list
await network.publish(recipientRelays, giftWrap);
```

See [MIP-00](https://github.com/parres-hq/marmot/blob/main/00.md) for gift wrap specifications.

## Extracting Welcome Messages

When you receive a gift wrap with a Welcome:

```typescript
import { getWelcome } from "@internet-privacy/marmots";
import { unwrapGiftWrap } from "applesauce-core/nip59";

// 1. Unwrap gift wrap
const rumor = unwrapGiftWrap(giftWrapEvent, myPrivateKey);

// 2. Extract Welcome
const welcome = getWelcome(rumor);

// 3. Use Welcome to join group (with matching private key package)
```

## Joining from Welcome

```typescript
import { getWelcome } from "@internet-privacy/marmots";
import { joinGroup } from "ts-mls";

// Get Welcome from rumor
const welcome = getWelcome(welcomeRumor);

// Get matching private key package from storage
const keyPackage = await keyPackageStore.get(keyPackageRef);

// Join the group
const clientState = joinGroup(
  welcome,
  keyPackage.privatePackage,
  ciphersuiteImpl,
);

// You're now a member!
```

## Welcome Ordering

Per [MIP-02](https://github.com/parres-hq/marmot/blob/main/02.md), commits MUST be published and acknowledged BEFORE sending Welcome messages.

**Why?** The Welcome references the commit that added the member. If the Welcome arrives first, the new member can't fetch the commit and will fail to join.

**Correct Order:**

1. Create commit with add proposal
2. Publish commit event (kind 445)
3. Wait for relay acknowledgment
4. Send Welcome messages

## Related

- [Key Packages](./key-packages) - Used to generate Welcomes
- [Groups](./groups) - Joining groups from Welcomes
- [Protocol](./protocol) - Welcome event kind (444)
