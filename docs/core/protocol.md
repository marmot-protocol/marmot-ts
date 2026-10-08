# Protocol Constants & Concepts

## Protocol Constants

### Event Kinds

Marmot uses specific Nostr event kinds for different purposes:

```typescript
import {
  ADDRESSABLE_KEY_PACKAGE_KIND, // 30443
  WELCOME_EVENT_KIND, // 444
  GROUP_EVENT_KIND, // 445
  NIP65_RELAY_LIST_KIND, // 10002
  INBOX_RELAY_LIST_KIND, // 10050
} from "@internet-privacy/marmot-ts";
```

- **30443 (ADDRESSABLE_KEY_PACKAGE_KIND):** Addressable key package advertisement events
- **444 (WELCOME_EVENT_KIND):** Welcome messages for new members (wrapped in NIP-59 gift wraps)
- **445 (GROUP_EVENT_KIND):** Group messages (commits, proposals, application messages)
- **10002 (NIP65_RELAY_LIST_KIND):** NIP-65 relay list. KeyPackages are published to, and fetched from, the account's _write-capable_ set (`r` entries marked `write` or unmarked; `read`-only entries are excluded); use `getNip65Relays(event, "write")`. There is no dedicated key-package relay list.
- **10050 (INBOX_RELAY_LIST_KIND):** Inbox relay list; welcomes are gift-wrapped to a recipient's inbox relays

### Extension Types

MLS extensions used by Marmot:

```typescript
import { LAST_RESORT_EXTENSION_TYPE } from "@internet-privacy/marmot-ts"; // 0x000a
```

- **0x000a (LAST_RESORT_EXTENSION_TYPE):** the legacy MLS `last_resort` KeyPackage extension, which marmot-ts currently emits (and advertises in capabilities and the `mls_extensions` tag) for reusable KeyPackages

::: warning Spec deviation
The spec marks last-resort KeyPackages with the empty-data `last_resort_key_package` component (`0x0004`) in the KeyPackage's `app_data_dictionary`, not an MLS extension ([`foundation/key-packages.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/key-packages.md), [`foundation/registries.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/registries.md)). marmot-ts still emits the legacy `0x000a` extension.
:::

In Marmot v2, group metadata is no longer carried in a single `0xf2ee` extension — it lives in the **app-component dictionary** described below.

### Protocol Versions

Key package events use MLS protocol version tag value `"1.0"`. The exported `MLS_VERSIONS` name is a TypeScript type alias for supported values.

## App Components (group state)

Marmot v2 stores group state as versioned **app components** inside the MLS
`app_data_dictionary` GroupContext extension (`0x0006`, draft-ietf-mls-extensions-10),
replacing the v1 `MarmotGroupData` monolith. Each component has a stable id and
its own binary codec; the dictionary is cryptographically bound to the group
state and mutated through `app_data_update` proposals (`0x0008`).

### Group components

| Id       | Component                                | Holds                                       |
| -------- | ---------------------------------------- | ------------------------------------------- |
| `0x8001` | `marmot.group.profile.v1`                | name, description                           |
| `0x8003` | `marmot.group.admin-policy.v1`           | admin Nostr pubkeys                         |
| `0x8004` | `marmot.transport.nostr.routing.v1`      | nostr group id + relays                     |
| `0x8005` | `marmot.group.message-retention.v1`      | retention window (seconds)                  |
| `0x8006` | `marmot.group.agent-text-stream.quic.v1` | agent stream policy / required roles        |
| `0x8007` | `marmot.group.avatar-url.v1`             | avatar URL                                  |
| `0x8008` | `marmot.group.encrypted-media.v1`        | frozen legacy media policy                  |
| `0x800b` | `marmot.group.encrypted-media.v2`        | blob-store policy for media                 |
| `0x800c` | `marmot.group.lifecycle.v1`              | protocol lifecycle (`active` / `disbanded`) |

New groups carry and require `marmot.group.encrypted-media.v2` (`0x800b`) by
default, as MDK does; pass `encryptedMedia: false` to `createSimpleGroup` /
`groups.create` for a group without media. Media references in a v2 group use
the `encrypted-media-v2` format (`group.uploadMedia`, `group.downloadMedia`,
`parseMediaAttachment`, `encodeMediaImetaTag`).

`0x8009` (`marmot.member.account-identity-proof.v2`) is LeafNode-only: it has
no GroupContext state, only an entry in the group's required `app_components`
list.

### Reading group state

`getMarmotGroupView` projects the recognized components into one object:

```typescript
import { getMarmotGroupView } from "@internet-privacy/marmot-ts";

const view = getMarmotGroupView(clientState);
view?.name; // "Developer Chat"
view?.adminPubkeys; // ["admin-pubkey-hex"]
view?.relays; // ["wss://relay.example.com"]
view?.nostrGroupId; // Uint8Array(32) | undefined (undefined without the routing component)
view?.avatarUrl; // "https://..." | undefined
view?.encryptedMedia; // EncryptedMediaPolicyV1 | undefined (legacy 0x8008)
view?.encryptedMediaV2; // EncryptedMediaPolicyV2 | undefined (0x800b)
view?.messageRetention; // bigint seconds | undefined
view?.protocolLifecycle; // "active" | "disbanded" | undefined
```

Individual components can be read from `clientState.groupContext.extensions`
with the typed getters (`getGroupProfile(extensions)`, `getAdminPolicy`,
`getNostrRouting`, `getGroupAvatarUrl`, `getEncryptedMediaPolicy`,
`getEncryptedMediaPolicyV2`, `getMessageRetention`, `getGroupLifecycle`, ...)
and built with the matching entry builders (`groupProfileEntry`,
`adminPolicyEntry`, `nostrRoutingEntry`, ...).

### Required capabilities

New groups declare a `required_capabilities` (`0x0003`) extension covering the
Marmot baseline — `app_data_dictionary` (`0x0006`) and the `app_data_update`
(`0x0008`) / `self_remove` (`0x000a`) proposals — so MLS refuses to add a
member whose KeyPackage does not advertise them. Every new group's
`app_components` required list always includes `0x8001` (profile), `0x8003`
(admin policy), `0x8009` (account identity proof), and `0x800c` (lifecycle,
seeded as `active`), plus any components you pass.

## Specification Reference

See the Marmot spec: [`app-components/README.md`](https://github.com/marmot-protocol/marmot/blob/master/app-components/README.md) and
[`foundation/registries.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/registries.md) for component ids, and
[`foundation/identity.md`](https://github.com/marmot-protocol/marmot/blob/master/foundation/identity.md) plus [`protocol-core/group-setup.md`](https://github.com/marmot-protocol/marmot/blob/master/protocol-core/group-setup.md) for
capability negotiation.
