# Welcome Messages

Welcome messages enable new members to join existing groups. They contain the group's current state and secrets.

## What is a Welcome Message?

When someone is added to a group, they receive a Welcome message containing:

- Current group state
- Encryption keys for the current epoch
- Member list
- Group context (including the app-component dictionary)

The Welcome gives them the secrets for the epoch created by the commit that added them. They can read messages from that epoch onward, but nothing earlier.

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
  author: await senderSigner.getPublicKey(), // inviter's account pubkey; must match the seal signer
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
import {
  createWelcomeRumor,
  createGiftWrap,
} from "@internet-privacy/marmot-ts";

// 1. Create welcome rumor
const welcomeRumor = createWelcomeRumor({
  welcome,
  groupRelays,
  keyPackageEventId: kpEventId,
  author: await senderSigner.getPublicKey(), // must match the seal signer below
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

The rumor and the kind 13 seal are authored by the inviter's account key. Only the outer kind 1059 wrap uses an ephemeral key, which NIP-59 generates for you. If the recipient has no kind 10050 list, the spec only lets the sender use contextual relay hints ([`transports/nostr.md`](https://github.com/marmot-protocol/marmot/blob/master/transports/nostr.md)). The marmot-ts client falls back to the group relays when `getUserInboxRelays` throws. Returning an empty list fails Welcome delivery for that recipient; an adapter that uses contextual fallback hints must return those relays explicitly. See [Network](/client/network#contract).

## Extracting Welcome Messages

When you receive a gift wrap with a Welcome:

```typescript
import { getWelcome } from "@internet-privacy/marmot-ts";
import { unlockGiftWrap } from "applesauce-common/helpers/gift-wrap";

// 1. Verify the outer kind 1059 (NIP-01 id/sig) and that its single `p` tag is your pubkey,
//    then unwrap. (client.invites does these checks for you.)
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
if (!keyPackage?.privatePackage)
  throw new Error("No local private key package");

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

The preview returns the genuine decrypted GroupInfo after MLS signature, tree and confirmation checks; its `signer` identifies the actual inviter leaf, not the joiner. Preview does not adopt a group or retire a KeyPackage, and it does not replace the full Marmot admission checks below.

## Joining from Welcome

Use the client API to join from an unwrapped kind 444 rumor:

```typescript
const { group } = await client.joinGroupFromWelcome({ welcomeRumor });
```

The client finds the matching local KeyPackage and tentatively processes the Welcome. Before saving anything, it validates the current proof profile, every resulting member's account identity proof, required and known group components, supported capabilities and roles, and active group lifecycle. The author is the **MLS-authenticated GroupInfo signer leaf**: that occupied leaf's account identity must be an active admin in the resulting group, with valid admin/member coupling. The delivery envelope alone cannot authorize admission.

An invalid signature, nonadmin inviter, orphaned admin, unsupported required component, malformed known component, inactive group, or bad proof rejects admission. A resulting MLS group id already retained locally also rejects, including concurrent duplicate joins. These rejections preserve the existing group and referenced KeyPackage material; a Welcome cannot silently repair or replace an existing group.

After validation and duplicate rejection, the client records a consumption receipt and durably saves the group. It then removes a consumed **single-use** package's private material, retains public metadata with `used: true`, and clears the completed receipt. A canonical reusable package keeps its private material. The implementation does not zero shared byte arrays because adopted MLS state can still reference them.

After joining:

- Call `await group.selfUpdate()` as soon as practical, before sending messages, to rotate the leaf key for forward secrecy ([`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md)). The client does not do this automatically.
- Publish a replacement with `client.keyPackages.rotate(ref)`. You can find consumed packages with `(await client.keyPackages.list()).filter((p) => p.used)`. Single-use cleanup does not wait for that replacement; reusable material is retained until retirement under its lifecycle policy.

::: tip Cleanup recovery
Group and KeyPackage stores are separate. A storage failure can reject the join call after the group was already adopted, leaving a pending cleanup receipt. Startup retries cleanup; you can also call `await client.keyPackages.finalizeConsumptions()`. Retirement confirms that the group exists durably before removing secrets and clears the receipt only after retirement persistence succeeds. Receipts for groups that were never adopted leave private material untouched. Use persistent stores for recovery across process restarts; see [`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md).
:::

::: warning First-contact trust
Admin authorization is checked against the received branch's own admin set. On first contact this authenticates the signer and validates that branch, but supplies no independent proof that it is the intended group's continuation. An existing member can fork and rewrite that branch's admin policy. Verify the inviter and group context through your application's trusted contact flow; see [`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md), "Welcome-bootstrap trust".
:::

## Welcome Ordering

Per [`protocol-core/joining.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/joining.md), for any Add after group creation the inviter MUST wait for the commit's publish obligation to succeed (at least one relay accepts it with NIP-01 `OK`) before sending Welcomes. Founding creation, including founding invitees, is exempt: there are no existing peers to fork.

**Why?** The Welcome puts the new member directly into the post-commit epoch. If that commit never reaches relays (or loses convergence), the new member is stranded on an epoch existing members never adopt.

**Correct order:**

1. Create commit with add proposal
2. Publish commit event (kind 445)
3. Wait for relay acknowledgment
4. Send Welcome messages (kind 1059 gift wrap)

## Related

- [Key Packages](./key-packages) - Used to generate Welcomes
- [Groups](./groups) - Joining groups from Welcomes
- [Protocol](./protocol) - Welcome event kind (444)
