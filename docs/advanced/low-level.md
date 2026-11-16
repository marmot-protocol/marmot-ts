# Low-level APIs

`MarmotClient` covers almost every app. This page is for the rare cases where you need the protocol building blocks underneath it. Full signatures live in the [API reference](pathname:///reference/index.html).

## When to skip the client

Use `@internet-privacy/marmot-ts/core` or `/engine` directly when you are:

- carrying Marmot over a transport other than Nostr relays;
- building your own persistence, scheduling or group registry instead of the client's managers;
- writing tests, fixtures, protocol tooling or interop checks;
- experimenting with new app components or protocol extensions.

The core layer is pure: it never touches the network or storage. If you skip the client you take over everything it does for you, including signature checks on inbound events, publishing commits before applying them, resolving concurrent commits, delivering Welcomes after the commit is accepted, and key package consumption. Prefer [`GroupSession`](#main-entry-points) or `MarmotGroupEngine` over raw core calls when you need any of that.

## Main entry points

All of these are exported from the package root as well as their subpath.

| Export                                                     | Subpath   | Purpose                                                                                    |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `createCredential`                                         | `/core`   | Build an MLS basic credential from a Nostr pubkey                                          |
| `generateKeyPackage`                                       | `/core`   | Create a key package (public + private) with its signed account identity proof             |
| `createKeyPackageEvent` / `getKeyPackage`                  | `/core`   | Encode a key package as an unsigned kind 30443 event / decode one from an event            |
| `evaluateKeyPackageForGroup`                               | `/core`   | Check whether a key package event can be added to a given group                            |
| `createSimpleGroup` / `createGroup`                        | `/core`   | Create a group with the default components / with components you choose                    |
| `getMarmotGroupView`                                       | `/core`   | Read name, description, admins, relays and other metadata from group state                 |
| `getGroupMemberPubkeys`                                    | `/core`   | List the member pubkeys of a group                                                         |
| `serializeApplicationRumor` / `deserializeApplicationData` | `/core`   | Encode a rumor as MLS application data / decode received application data back to a rumor  |
| `createGroupEvent`                                         | `/core`   | Wrap an MLS message in a kind 445 event signed by a fresh ephemeral key                    |
| `decryptGroupMessages`                                     | `/core`   | Decrypt the outer layer of kind 445 events into MLS messages, separating unreadable ones   |
| `createWelcomeRumor` / `getWelcome`                        | `/core`   | Build a kind 444 Welcome rumor / decode the MLS Welcome from one                           |
| `readWelcomeMarmotGroupView`                               | `/core`   | Preview a Welcome's group metadata before joining                                          |
| `createGiftWrap`                                           | `/utils`  | NIP-59 gift-wrap a rumor for a recipient                                                   |
| `serializeClientState` / `deserializeClientState`          | `/core`   | Encode group state to bytes for storage / decode it again                                  |
| `marmotAuthService`                                        | `/core`   | MLS authentication service enforcing Marmot's credential policy, for direct ts-mls calls   |
| `MarmotGroupEngine`                                        | `/engine` | Transport-independent group state machine: ingest, convergence, commit lifecycle           |
| `GroupSession`                                             | `/client` | The engine plus persistence; what `MarmotGroup` uses internally, without the Nostr runtime |

MLS primitives, ciphersuites and the crypto provider come from the bundled ts-mls fork at `@internet-privacy/marmot-ts/mls`.

## Example: create a group without the client

This builds a key package and a Nostr-routed group in memory, then serializes the state for your own storage. Nothing is published.

```typescript
import {
  createCredential,
  createSimpleGroup,
  generateKeyPackage,
  getMarmotGroupView,
  serializeClientState,
} from "@internet-privacy/marmot-ts/core";
import { getCiphersuiteImpl } from "@internet-privacy/marmot-ts/mls";

const ciphersuiteImpl = await getCiphersuiteImpl(
  "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519",
);
const pubkey = await signer.getPublicKey();

const keyPackage = await generateKeyPackage({
  credential: createCredential(pubkey),
  signer, // signs the account identity proof
  ciphersuiteImpl,
});

const { clientState } = await createSimpleGroup(
  keyPackage,
  ciphersuiteImpl,
  "Research Group",
  { description: "Low-level demo", relays: ["wss://relay.example.com"] },
);

console.log(getMarmotGroupView(clientState)?.name); // "Research Group"
await myStore.setItem("group", serializeClientState(clientState));
```

From here, sending a message means creating an MLS application message with ts-mls, wrapping it with `createGroupEvent`, and publishing it yourself; receiving means `decryptGroupMessages` followed by ts-mls message processing. That is the work `MarmotClient` already does, so reach for it again once your experiment needs real messaging.
