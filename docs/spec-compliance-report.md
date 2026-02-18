# Marmot TS Implementation: Spec Compliance Report (MIP-00..03)

**Date:** 2026-02-18  
**Scope:** MIP-00, MIP-01, MIP-02, MIP-03  
**Status:** Analysis complete (implementation vs current specs)

This report compares the current code in [`src/`](src/index.ts:1) against the current MIP specs in [`marmot/00.md`](marmot/00.md:1) .. [`marmot/03.md`](marmot/03.md:1). It aims to be **accuracy-first** and avoids spec claims that are not directly supported by code evidence.

---

## Executive Summary

The implementation is **largely compliant** with the current MIPs. The previously-identified
interoperability-critical gaps have been addressed:

1. **MIP-01 Marmot Group Data extension v2 is implemented** (QUIC varint vectors + `image_upload_key`).
2. **MIP-00 / MIP-02 decoding is base64-only** (hex and missing tags are rejected).
3. **MIP-00 KeyPackage events include the required `i` tag** (`KeyPackageRef`).
4. **MIP-01 MLS `group_id` is private and distinct from `nostr_group_id`**.
5. **MIP-03 commit race ordering matches the spec** (`created_at`, then lexicographically smallest `id`).

Remaining notable gaps / deviations from strict MIP text:

- **MIP-02 self-update “MUST within 24 hours”** is implemented as best-effort immediate self-update with no persistent tracking.
- **MIP-00 relays tag**: generation/decoding do not hard-enforce the presence of `relays` (warnings only).

Areas that are in better shape:

- Credential identity is stored as raw 32-byte pubkey bytes.
- Commit publishing waits for relay acknowledgment before sending Welcomes.
- Local KeyPackage deletion after successful join is implemented.

---

## MIP-00: Credentials & Key Packages

### MLS Credentials

| Requirement                                                |                                   Status | Evidence                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------- |
| BasicCredential identity is raw 32-byte Nostr pubkey bytes |                             ✅ Compliant | [`createCredential()`](src/core/credential.ts:11) sets `identity: hexToBytes(pubkey)`                                            |
| Credential identity is treated as immutable                | ⚠️ Not directly enforced at Marmot layer | No explicit proposal/commit validation exists in Marmot TS for “identity change”; behavior depends on ts-mls validation policies |

### KeyPackage Events (kind 443)

| Requirement                                                   |           Status | Evidence                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event kind 443                                                |     ✅ Compliant | [`KEY_PACKAGE_KIND`](src/core/protocol.ts:13), [`createKeyPackageEvent()`](src/core/key-package-event.ts:153)                                                                                                       |
| `mls_protocol_version` tag                                    |     ✅ Compliant | Added in [`createKeyPackageEvent()`](src/core/key-package-event.ts:153)                                                                                                                                             |
| `mls_ciphersuite` tag                                         |     ✅ Compliant | Added in [`createKeyPackageEvent()`](src/core/key-package-event.ts:153)                                                                                                                                             |
| `mls_extensions` includes `0xf2ee` and `0x000a`               |     ✅ Compliant | Capabilities ensured by [`ensureMarmotCapabilities()`](src/core/capabilities.ts:8); emitted by [`createKeyPackageEvent()`](src/core/key-package-event.ts:153)                                                       |
| Default MLS extensions not listed in capabilities             |     ✅ Compliant | Capabilities built using ts-mls defaults then amended; see [`defaultCapabilities()`](src/core/default-capabilities.ts:15) and tests in [`src/__tests__/capabilities.test.ts`](src/__tests__/capabilities.test.ts:1) |
| `encoding` MUST be base64 and hex MUST be rejected            | ✅ Compliant | Enforced in [`getKeyPackage()`](src/core/key-package-event.ts:65) |
| `i` tag (KeyPackageRef, hex) MUST be included                 | ✅ Compliant | Added in [`createKeyPackageEvent()`](src/core/key-package-event.ts:159) |
| NIP-70 protected tag `["]-"]` SHOULD be omitted unless needed |     ✅ Compliant | Opt-in `protected` flag in [`createKeyPackageEvent()`](src/core/key-package-event.ts:133)                                                                                                                           |

### KeyPackageRef computation

| Requirement                                          |       Status | Evidence                                                                                                    |
| ---------------------------------------------------- | -----------: | ----------------------------------------------------------------------------------------------------------- |
| KeyPackageRef hash uses the ciphersuite-defined hash | ✅ Compliant | [`calculateKeyPackageRef()`](src/core/key-package.ts:43) uses `cryptoProvider.getCiphersuiteImpl(...).hash` |

### KeyPackage lifecycle after join

| Requirement                                                                                                                             |                              Status | Evidence                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete consumed KeyPackage from local storage after successful join                                                                     |                        ✅ Compliant | [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348) removes via `keyPackageStore.remove(consumedKeyPackageRef)`                                                                           |
| Best-effort request to delete relay-published KeyPackage event                                                                          |                        ✅ Compliant | Emits `keyPackageRelayDeleteRequested` in [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348)                                                                                             |
| Secure deletion / zeroization of init_key bytes                                                                                         |       ⚠️ Not implemented explicitly | Persistent private material is removed via KeyPackageStore removal; “zeroize memory” semantics described in spec are not implemented (and are not generally enforceable in JS runtimes)                        |
| **Last resort KeyPackages**: init_key MUST be retained while the KeyPackage remains published; do **not** delete immediately after join |                        ✅ Compliant | Best-effort retention is implemented for out-of-band joins (no KeyPackage event id) in [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348)                                              |

---

## MIP-01: Group Construction & Marmot Group Data Extension (v2)

MIP-01 specifies `marmot_group_data` (extension type `0xF2EE`) with **version 2**, QUIC varint length prefixes for all variable-length vectors, and additional fields including `image_upload_key`: see [`marmot/01.md`](marmot/01.md:66).

### Extension identifier and version support

| Requirement                                                                                   |           Status | Evidence                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extension type `0xF2EE`                                                                       |     ✅ Compliant | [`MARMOT_GROUP_DATA_EXTENSION_TYPE`](src/core/protocol.ts:40)                                                                                                            |
| Current version is 2; implementation supports v2 and may decode v1 for backward compatibility | ✅ Compliant | [`MARMOT_GROUP_DATA_VERSION`](src/core/protocol.ts:44); v1/v2 decode in [`decodeMarmotGroupData()`](src/core/marmot-group-data.ts:392) |

### Serialization format (QUIC varint vectors)

| Requirement                                                                 |           Status | Evidence                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variable-length vectors use QUIC varint length prefixes                     |     ✅ Compliant | QUIC varint helpers in [`encodeVarint()`](src/core/marmot-group-data.ts:78) / [`decodeVarint()`](src/core/marmot-group-data.ts:108); used by v2 codec in [`encodeMarmotGroupData()`](src/core/marmot-group-data.ts:290) |
| `admin_pubkeys` are concatenated raw 32-byte x-only pubkeys (no separators) |     ✅ Compliant | v2 admin key encoding/decoding in [`encodeAdminPubkeysV2()`](src/core/marmot-group-data.ts:208) / [`decodeAdminPubkeysV2()`](src/core/marmot-group-data.ts:221) |
| `relays` are a vector of individually length-prefixed URLs                  |     ✅ Compliant | v2 relay vector encoding/decoding in [`encodeRelaysV2()`](src/core/marmot-group-data.ts:232) / [`decodeRelaysV2()`](src/core/marmot-group-data.ts:256) |
| Image fields are variable-length (0 or N) and include `image_upload_key`    |     ✅ Compliant | v2 variable-length image fields in [`encodeMarmotGroupData()`](src/core/marmot-group-data.ts:290) and v2 decode validation in [`decodeMarmotGroupData()`](src/core/marmot-group-data.ts:392) |

### Group ID privacy requirement

MIP-01 states MLS `group_id` is private and distinct from `nostr_group_id`: see [`marmot/01.md`](marmot/01.md:13).

| Requirement                                                          |                Status | Evidence                                                                                     |
| -------------------------------------------------------------------- | --------------------: | -------------------------------------------------------------------------------------------- |
| MLS `group_id` is distinct from `nostr_group_id` and never published | ✅ Compliant | Random MLS group_id in [`createGroup()`](src/core/group.ts:26) |

---

## MIP-02: Welcome Events

| Requirement                                                        |           Status | Evidence                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome kind 444                                                   |     ✅ Compliant | [`WELCOME_EVENT_KIND`](src/core/protocol.ts:84)                                                                                                    |
| Welcome rumors created unsigned                                    |     ✅ Compliant | No `sig` field in [`createWelcomeRumor()`](src/core/welcome.ts:27)                                                                                 |
| Commit MUST be relay-acked before Welcome is sent                  |     ✅ Compliant | [`MarmotGroup.commit()`](src/client/group/marmot-group.ts:443) publishes commit and checks ack before sending Welcomes                             |
| Welcome `encoding` MUST be base64; hex MUST be rejected            | ✅ Compliant | Enforced in [`getWelcome()`](src/core/welcome.ts:83) |
| Post-join self-update SHOULD for all joiners; MUST within 24 hours | ⚠️ Best-effort only | Best-effort immediate self-update in [`MarmotClient.joinGroupFromWelcome()`](src/client/marmot-client.ts:348) via [`MarmotGroup.selfUpdate()`](src/client/group/marmot-group.ts:244); no persistent 24h tracking |

**Clarification (last resort KeyPackages):** MIP-00’s `last_resort` affects **init_key retention and KeyPackage reuse**, not whether a joiner should self-update. The MIP-02 self-update guidance still applies; the “special case” is that clients MUST NOT treat a last-resort join as a reason to delete `init_key` material immediately (see [`marmot/00.md`](marmot/00.md:185)).

---

## MIP-03: Group Messages

### Encryption and event structure

| Requirement                                                 |                                       Status | Evidence                                                                                                                            |
| ----------------------------------------------------------- | -------------------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| Group event kind 445                                        |                                 ✅ Compliant | [`GROUP_EVENT_KIND`](src/core/protocol.ts:81)                                                                                       |
| `h` tag uses `nostr_group_id`                               | ✅ Compliant (depends on MIP-01 correctness) | Derived via [`getNostrGroupIdHex()`](src/core/client-state.ts:40) and used in [`createGroupEvent()`](src/core/group-message.ts:196) |
| NIP-44 encryption uses exporter_secret-derived key material |                                 ✅ Compliant | [`createEncryptedGroupEventContent()`](src/core/group-message.ts:93), [`decryptGroupMessageEvent()`](src/core/group-message.ts:54)  |
| Publishing uses per-event ephemeral signing keys            |                                 ✅ Compliant | [`createGroupEvent()`](src/core/group-message.ts:196) uses `generateSecretKey()`                                                    |

### Commit authorization and ordering

| Requirement                                                                               |           Status | Evidence                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | ---------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-self-update commits must be from admin                                                |     ✅ Compliant | Admin policy helper [`createAdminCommitPolicyCallback()`](src/client/group/marmot-group.ts:114) used in [`MarmotGroup.ingest()`](src/client/group/marmot-group.ts:738) |
| Competing commits resolution: earliest `created_at`, then lexicographically smallest `id` | ✅ Compliant | Implemented in [`sortGroupCommits()`](src/core/group-message.ts:277) |

---

## Consolidated Gap List (priority-ordered)

### Remaining gaps / deviations

1. **MIP-02 24-hour self-update requirement**: best-effort immediate self-update is implemented, but there is no persistent 24-hour tracking/enforcement.
2. **MIP-00 `relays` tag presence**: generation/decoding do not hard-enforce relays tag presence (warnings only).
