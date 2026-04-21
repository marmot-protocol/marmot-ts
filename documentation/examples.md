# Code Examples

These practical examples demonstrate common use cases when building with `marmot-ts`. They assume you've already initialised a `MarmotClient` as shown in [Getting Started](getting-started.md).

## 1. Creating a Group

When creating a group, you must define the base group info (`name`, `description`, etc.) and any additional admin pubkeys. The creator is always added to the group and admin list automatically.

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";

const group = await client.groups.create("Engineering Sync", {
  description: "Secure comms for the backend team",
  relays: ["wss://relay.nostr.info"],
  adminPubkeys: ["<other-admin-pubkey-hex>"],
  // Optional: override MLS ciphersuite
  ciphersuite: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
});

// The group ID is the MLS private groupId (Uint8Array). For the public
// nostr_group_id (used in the kind 445 "h" tag), read group.groupData.nostrGroupId.
console.log(`Created group with ID: ${bytesToHex(group.id)}`);
```

## 2. Publishing a Key Package

Before anyone can invite you, you must publish a key package event (kind 30443). The manager handles generation, signing, publishing, and local persistence in one call.

```typescript
const stored = await client.keyPackages.create({
  relays: ["wss://relay.example.com"],
  // `identifier` falls back to MarmotClient.clientId when omitted.
  identifier: "my-app-desktop",
});

console.log("Published key package ref:", stored.keyPackageRef);
```

## 3. Inviting a Member

To invite a new member, fetch one of their published key package events (kind 443 or kind 30443) and pass it to the group. `inviteByKeyPackageEvent` builds the Add proposal, commits it, and delivers the Welcome message as a NIP-59 Gift Wrap to the invited user's NIP-65 inbox relays.

```typescript
const memberPubkey = "abc123def456...";
const [keyPackageEvent] = await client.network.request(
  ["wss://relay.example.com"],
  [{ kinds: [443, 30443], authors: [memberPubkey], limit: 1 }],
);

if (keyPackageEvent) {
  // Returns a map of relay URL → PublishResponse for the commit event.
  const publishResults = await group.inviteByKeyPackageEvent(keyPackageEvent);
  console.log("Invited user. Relays responded:", publishResults);
}
```

## 4. Receiving and Joining an Invite

When someone invites you, their Welcome message is wrapped in a NIP-59 gift wrap (kind 1059) and delivered to one of your NIP-65 inbox relays. `InviteManager` ingests the raw gift wraps, decrypts them into kind 444 rumors, and lets you drive the UI from that decrypted set.

```typescript
// 1. Feed observed kind 1059 events into the invite manager.
await client.invites.ingestEvents(giftWrapsFromRelaySync);

// 2. Decrypt all pending gift wraps (this prompts the signer, so trigger it
//    from a deliberate user action — e.g. opening the "Invites" screen).
await client.invites.decryptGiftWraps();

// 3. Read unread invites and join the ones the user accepts.
for (const welcomeRumor of await client.invites.getUnread()) {
  // Optional: preview the group metadata before joining.
  const preview = await client.readInviteGroupInfo(welcomeRumor);

  const { group } = await client.joinGroupFromWelcome({ welcomeRumor });
  console.log(`Joined group: ${group.idStr}`);

  // Rotate leaf key material for forward secrecy (MIP-02 SHOULD).
  await group.selfUpdate();

  // Remove the invite from the "unread" bucket.
  await client.invites.markAsRead(welcomeRumor.id);
}
```

If you already have the decrypted kind 444 rumor from another source (e.g. a custom pipeline), you can skip the `InviteManager` entirely and call `client.joinGroupFromWelcome({ welcomeRumor })` directly — the client locates the matching local key package by comparing `KeyPackageRef`s against `welcome.secrets[*].newMember`.

## 5. Sending a Message

Messages sent within a group are packaged as MLS `applicationMessage` payloads. You can construct a generic Nostr rumor yourself and call `sendApplicationRumor`, or use the `sendChatMessage` helper for the common kind 9 case.

```typescript
// Convenience: kind 9 chat message with optional tags.
await group.sendChatMessage("Hello everyone, the server is deployed!");
await group.sendChatMessage("Reply", [["e", replyToId]]);
```

For any other kind, build the rumor yourself:

```typescript
import { getEventHash } from "applesauce-core/helpers";
import type { Rumor } from "applesauce-common/helpers/gift-wrap";

const rumor: Rumor = {
  id: "",
  kind: 7, // reaction
  pubkey: await client.signer.getPublicKey(),
  created_at: Math.floor(Date.now() / 1000),
  content: "+",
  tags: [["e", messageId]],
};
rumor.id = getEventHash(rumor);

await group.sendApplicationRumor(rumor);
```

## 6. Receiving Messages

To receive messages, subscribe to kind `445` events on the group's relays (tagged with the group's public `nostrGroupId`) and feed the stream into `group.ingest()`.

```typescript
import { bytesToHex } from "@noble/hashes/utils.js";
import { deserializeApplicationRumor } from "@internet-privacy/marmot-ts";

const subscription = client.network.subscription(group.relays!, [
  {
    kinds: [445],
    "#h": [bytesToHex(group.groupData!.nostrGroupId)],
  },
]);

subscription.subscribe({
  next: async (event) => {
    for await (const outcome of group.ingest([event])) {
      if (
        outcome.kind === "processed" &&
        outcome.result.kind === "applicationMessage"
      ) {
        const rumor = deserializeApplicationRumor(outcome.result.message);
        console.log(`New message from ${rumor.pubkey}: ${rumor.content}`);
      }
    }
  },
});

// Or listen for the convenience event:
group.on("applicationMessage", (bytes) => {
  const rumor = deserializeApplicationRumor(bytes);
  console.log(`[${group.idStr.slice(0, 8)}] ${rumor.pubkey}: ${rumor.content}`);
});
```

For batched ingest (e.g. initial sync via `request`), pass all events in one call — the generator handles ordering and retries for messages that arrive ahead of the commits they depend on. See [Ingest Methods](ingest-methods.md) for details on retry/DoS behaviour.
