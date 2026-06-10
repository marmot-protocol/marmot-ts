# Welcome Messages

Welcome messages enable new members to join existing groups. They contain the group's current state and secrets.

## What is a Welcome Message?

When someone is added to a group, they receive a Welcome message containing:

- Current group state
- Encryption keys for the current epoch
- Member list
- Group context (including the app-component dictionary)

The Welcome allows them to decrypt past messages from the current epoch and participate in the group.

## Creating Welcome Rumors

After creating a commit that adds members, you get Welcome messages:

```typescript
import { createWelcomeRumor } from "@internet-privacy/marmot-ts";

// After MLS createCommit with add proposals
const { welcome } = commitResult;

const welcomeRumor = createWelcomeRumor({
  welcome, // Welcome from MLS commit
  groupRelays, // Non-empty relay URLs for group message fetch
  keyPackageEventId, // Required: 32-byte hex KeyPackage event id (e tag)
  author: myEphemeralPubkey, // Nostr pubkey for this rumor
});

// welcomeRumor is kind 444, ready to be gift-wrapped
```

### Event Structure

Per the Marmot v2 Nostr transport spec (`transports/nostr.md` "Welcome delivery"):

```
kind: 444
content: base64-encoded MLSMessage (wireformat mls_welcome)
tags:
  - ["relays", ...groupRelays]   (required, non-empty)
  - ["e", keyPackageEventId]     (required, 32-byte hex Nostr event id)
```

The rumor MUST NOT include an `encoding` tag. Content is always standard base64.

## Distributing Welcome Messages

Welcome messages are wrapped in NIP-59 gift wraps (kind 1059 → kind 13 seal → kind 444 rumor) and published to the invitee's inbox relay set:

```typescript
import { createWelcomeRumor } from "@internet-privacy/marmot-ts";
import { createGiftWrap } from "applesauce-core/nip59";

// 1. Create welcome rumor
const welcomeRumor = createWelcomeRumor({
  welcome,
  groupRelays,
  keyPackageEventId: kpEventId,
  author: myEphemeralPubkey,
});

// 2. Wrap in gift wrap addressed to the invitee
const giftWrap = await createGiftWrap({
  rumor: welcomeRumor,
  recipient: recipientPubkey,
  signer: senderSigner,
});

// 3. Publish to the recipient's inbox relays (kind 10050 relay list)
await network.publish(recipientInboxRelays, giftWrap);
```

## Extracting Welcome Messages

When you receive a gift wrap with a Welcome:

```typescript
import { getWelcome } from "@internet-privacy/marmot-ts";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";

// 1. Unwrap gift wrap (validates recipient binding)
const rumor = await unlockGiftWrap(giftWrapEvent, mySigner);

// 2. Extract and validate the Welcome (e tag, relays tag, MLS decode)
const welcome = getWelcome(rumor);

// 3. Join the group or preview metadata before joining
```

## Previewing Group Metadata

Before joining, you can decrypt group info or the Marmot app-component view from a Welcome:

```typescript
import {
  getWelcome,
  readWelcomeGroupInfo,
  readWelcomeMarmotGroupView,
} from "@internet-privacy/marmot-ts";

const welcome = getWelcome(welcomeRumor);
const keyPackage = await keyPackageStore.get(keyPackageRef);

const groupInfo = await readWelcomeGroupInfo({
  welcome,
  keyPackage,
  ciphersuiteImpl,
});

const groupView = await readWelcomeMarmotGroupView({
  welcome,
  keyPackage,
  ciphersuiteImpl,
});
// groupView?.name, groupView?.relays, groupView?.adminPubkeys, etc.
```

## Joining from Welcome

Use the client API to join from an unwrapped kind 444 rumor:

```typescript
const { group } = await client.joinGroupFromWelcome({ welcomeRumor });
```

The client finds the matching local KeyPackage, validates member identity proofs, and persists the resulting group state.

## Welcome Ordering

Per `protocol-core/joining.md`, commits MUST be published and acknowledged **before** sending Welcome messages (except initial one-member group creation).

**Why?** The Welcome references the commit that added the member. If the Welcome arrives first, the new member can't fetch the commit and will fail to join.

**Correct order:**

1. Create commit with add proposal
2. Publish commit event (kind 445)
3. Wait for relay acknowledgment
4. Send Welcome messages (kind 1059 gift wrap)

## Related

- [Key Packages](./key-packages) - Used to generate Welcomes
- [Groups](./groups) - Joining groups from Welcomes
- [Protocol](./protocol) - Welcome event kind (444)
