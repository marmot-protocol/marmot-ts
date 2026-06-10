---
heroImage: /images/marmot-protocol.png
heroImageAlt: A pixel-art marmot in uniform holding a clipboard next to a stone tablet with checkmarks
---

# Protocol Constants & Concepts

## Protocol Constants

### Event Kinds

Marmot uses specific Nostr event kinds for different purposes:

```typescript
import {
  KEY_PACKAGE_KIND, // 443 (legacy)
  ADDRESSABLE_KEY_PACKAGE_KIND, // 30443
  WELCOME_EVENT_KIND, // 444
  GROUP_EVENT_KIND, // 445
  NIP65_RELAY_LIST_KIND, // 10002
  INBOX_RELAY_LIST_KIND, // 10050
} from "@internet-privacy/marmot-ts";
```

- **443 (KEY_PACKAGE_KIND):** Legacy key package advertisement events (read/delete compatibility)
- **30443 (ADDRESSABLE_KEY_PACKAGE_KIND):** Addressable key package advertisement events published by current clients
- **444 (WELCOME_EVENT_KIND):** Welcome messages for new members (wrapped in NIP-59 gift wraps)
- **445 (GROUP_EVENT_KIND):** Group messages (commits, proposals, application messages)
- **10002 (NIP65_RELAY_LIST_KIND):** NIP-65 relay list; Marmot discovers an account's key-package relays here (there is no dedicated key-package relay list)
- **10050 (INBOX_RELAY_LIST_KIND):** Inbox relay list; welcomes are gift-wrapped to a recipient's inbox relays

### Extension Types

MLS extensions used by Marmot:

```typescript
import {
  MARMOT_GROUP_DATA_EXTENSION_TYPE, // 0xf2ee
  LAST_RESORT_EXTENSION_TYPE, // 0x000a
} from "@internet-privacy/marmot-ts";
```

- **0xf2ee (MARMOT_GROUP_DATA_EXTENSION_TYPE):** Custom extension containing Marmot group metadata ([MIP-01](https://github.com/parres-hq/marmot/blob/main/01.md))
- **0x000a (LAST_RESORT_EXTENSION_TYPE):** Marks key packages as reusable

### Protocol Versions

Key package events use MLS protocol version tag value `"1.0"`. The exported `MLS_VERSIONS` name is a TypeScript type alias for supported values.

## App Components (group state)

Marmot v2 stores group state as versioned **app components** inside the MLS
`app_data_dictionary` GroupContext extension (`0x0006`, draft-ietf-mls-extensions-09),
replacing the v1 `MarmotGroupData` monolith. Each component has a stable id and
its own binary codec; the dictionary is cryptographically bound to the group
state and mutated through `app_data_update` proposals (`0x0008`).

### Group components

| Id       | Component                    | Holds                       |
| -------- | ---------------------------- | --------------------------- |
| `0x8001` | `group.profile.v1`           | name, description           |
| `0x8003` | `admin-policy.v1`            | admin Nostr pubkeys         |
| `0x8004` | `transport.nostr.routing.v1` | nostr group id + relays     |
| `0x8005` | `message-retention.v1`       | retention window (seconds)  |
| `0x8007` | `group.avatar-url.v1`        | avatar URL                  |
| `0x8008` | `group.encrypted-media.v1`   | blob-store policy for media |

### Reading group state

`getMarmotGroupView` projects the recognized components into one object:

```typescript
import { getMarmotGroupView } from "@internet-privacy/marmot-ts";

const view = getMarmotGroupView(clientState);
view?.name; // "Developer Chat"
view?.adminPubkeys; // ["admin-pubkey-hex"]
view?.relays; // ["wss://relay.example.com"]
view?.nostrGroupId; // Uint8Array(32)
view?.avatarUrl; // "https://..." | undefined
view?.encryptedMedia; // EncryptedMediaPolicyV1 | undefined
```

Individual components can be read with the typed getters
(`getGroupProfile`, `getAdminPolicy`, `getNostrRouting`, `getGroupAvatarUrl`,
`getEncryptedMediaPolicy`, ...) and built with the matching entry builders
(`groupProfileEntry`, `adminPolicyEntry`, `nostrRoutingEntry`, ...).

### Required capabilities

New groups declare a `required_capabilities` (`0x0003`) extension covering the
Marmot baseline — `app_data_dictionary` (`0x0006`), account-identity-proof
(`0xF2F1`), and the `app_data_update` proposal (`0x0008`) — so MLS refuses to
add a member whose KeyPackage does not advertise them.

## Specification Reference

See the darkmatter (Marmot v2) spec for the complete app-component and
capability-negotiation model.
