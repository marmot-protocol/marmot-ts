# @internet-privacy/marmot-ts

## Unreleased

### Added

- Use `MarmotGroupEngine` from the engine entrypoint to manage group state without a Nostr transport, with changes applied after successful publication.
- Use `GroupSession`, `MarmotGroup.session`, and `MarmotGroup.runtime` for direct control over group send, receive, persistence, and publication. `GroupsManager` adds session and runtime helpers, including Welcome delivery.
- Encrypt and decrypt group media with `GroupMediaService`, including a cache for decrypted media.
- Enable optional forensic audit logging to investigate group activity.
- Check group compatibility through `profileSupport` and identify older KeyPackages through `ListedKeyPackage.nonCurrent`.
- Receive account identity proof rejection details and group removal or disband notifications during recovery.

### Changed

- Bundle the forked MLS implementation with the library. Import MLS primitives from `@internet-privacy/marmot-ts/mls`; additional cryptographic backends are optional dependencies needed only for their ciphersuites.
- Sign account identity proofs with the client's own signer using the current `0x8009` member proof format.

### Fixed

- Publish KeyPackage proposal tags that match the advertised proposals, including GREASE values, so MDK accepts them. Reject missing, malformed, or mismatched proposal tags when selecting invite candidates; matching older tags without GREASE remain supported.
- Validate member identity proofs during sends, ingestion, and fork recovery, preventing invalid membership changes from being accepted.
- Authorize commits against their parent state, including during fork recovery and when an admin is demoted earlier in an ingestion batch.
- Keep admin restrictions enforced when optional group metadata is malformed, and reject invalid group component updates before applying them.
- Mark last-resort KeyPackages with the empty `last_resort_key_package` component (`0x0004`) in the KeyPackage-level `app_data_dictionary`, as the spec requires and as MDK / White Noise (OpenMLS `mark_as_last_resort`) emit, instead of the legacy `last_resort` extension (`0x000a`); the legacy extension type is no longer advertised in LeafNode capabilities or the `mls_extensions` tag. Adds `isLastResortKeyPackage` (recognizes both encodings) and `LAST_RESORT_KEY_PACKAGE_COMPONENT_ID`.

### Breaking changes

- Legacy account identity proofs (`0xf2f1`) and their helper exports are removed. New groups require `0x8009`; incompatible groups cannot be joined, and stored incompatible groups refuse traffic. Republish current KeyPackages and explicitly purge obsolete ones. See the [account identity proof migration guide](docs/client/best-practices.md#migrating-to-account-identity-proof-v2-0x8009).
- Separate proof-signer options are removed. `generateKeyPackage` requires a `signer`, and `makeLeafAppComponentsExtension` requires an encoded current proof.
- `ForkRecovery.resolveFork` now takes an `adminCallbackFor` function instead of a single `adminCallback`.
- Ingest results add `unsupported-profile` and `account-identity-proof` reasons. A `rejected` result can now describe a standalone proposal as well as a commit; update exhaustive result handlers accordingly.

## 0.5.1

### Patch Changes

- 9f41ce8: Fix key package event tracking by storing slot identifiers under `identifier`, deduplicating replaceable published events, and yielding fresh watcher arrays.

## 0.5.0

### Minor Changes

- c9dd6c1: Update `KeyPackageManager` to handle both legacy kind 443 and new kind 30443 events
- b9781eb: Remove `KeyPackageStore` class and update `KeyPackageManger` to accept key value store directly
- 1ec7962: Remove group state storage classes and update `MarmotGroup` to accept a `GenericKeyValueStore<SerializedClientState>` directly.
- da44f58: Add `InviteManager` to `MarmotClient` class as `MarmotClient.invites`
- 92d7c41: Move group management out into `GroupManager` class on `MarmotClient.groups`

### Patch Changes

- 689c7f1: refactor: bump ts-mls to 2.0.0-rc.10 version and adapt code
- bbe16b5: Fix leave proposal state handling to persist only after relay acknowledgement

## 0.4.0

### Minor Changes

- 5bb2e75: Add `subscribe` method to `GroupRumorHistory` class for live subscriptions
- 5bb2e75: Update `GroupRumorHistoryBackend` to accept multiple filters on `queryRumors`
- b7ab86f: Add `MarmotClient.leaveGroup()` method and `groupLeft` event for group departure via `MarmotGroup.leave()`
- b7ab86f: Add `MarmotGroup.leave()` method to publish a self-remove proposal and purge local group state
- 87e4522: Remove unused `MarmotGroup.publish` method

### Patch Changes

- c00262f: Fix hex string validation and add deduplication for concurrent media decryption
- 87e4522: Fix: save state after sending proposal

## 0.3.0

### Minor Changes

- 74f4d9e: Add MIP-01 group image and MIP-04 chat media encryption helpers
- b58eaac: Update kind 445 group message encryption to the new MIP-03 format and keep legacy decryption fallback with a deprecation warning
- 5454332: Add parseMediaImetaTag, getMediaAttachments, and getMediaAttachmentFromFileEvent helpers for parsing MIP-04 v2 attachments from imeta tags and kind 1063 events

### Patch Changes

- f668978: Fix MIP-04 key derivation to use MLS-Exporter("marmot", "encrypted-media", 32) per updated spec
- 5b70f08: Remove "nostr-tools" direct dependency

## 0.2.0

### Minor Changes

- e1f19d5: Add `MarmotClient.readInviteGroupInfo` method for easily reading welcome messages
- 488dc69: Add sendChatMessage() convenience method to MarmotGroup for sending kind 9 chat messages
- af15232: Add `getWelcomeKeyPackageRefs` method for reading key package refs from a welcome message
- af15232: Add `readWelcomeGroupInfo` and `readWelcomeMarmotGroupData` to read group metadata from a Welcome message without joining the group
- 8647071: Add `KeyPackageManager` class to manage key packages.
- d7a2e95: Update `MarmotGroup.ingest` to yield a processed Nostr event
- 10f2fa0: Rename `readGroupMessage` to `decryptGroupMessage`
- 2abce4b: Change `IngestResult` to a discriminated union; `ingest()` now yields skipped, rejected, and unreadable events in addition to processed ones
- 10f2fa0: Add `used` flag to stored key packages and `markUsed()` method on `KeyPackageManager` for tracking consumed key packages
- 10f2fa0: Rename `readGroupMessage` to `decryptGroupMessages`
- 10f2fa0: Remove `consumedKeyPackageRef` from `joinGroupFromWelcome()` return value; the consumed key package is now automatically marked as used instead of being rotated
- 18e80fd: Replace console logging with debug package; enable logging via DEBUG=marmot-ts:\*
- 10c7702: Add `isLastResort` option to `generateKeyPackage()` for controlling last_resort extension, clean up relay handling, and code
- 9a2b6f9: Removed `MarmotClient.rotateKeyPackage()`, use `MarmotClient.keyPackages.rotate()` instead
- 10f2fa0: Rename `LAST_RESORT_KEY_PACKAGE_EXTENSION_TYPE` to `LAST_RESORT_EXTENSION_TYPE`
- 9a2b6f9: Remove `MarmotClient.watchKeyPackages()` method, use `MarmotClient.keyPackages.watch()` instead

### Patch Changes

- 12d0605: Fix welcome event content missing outer MLSMessage object
- 9334865: Fix joinGroupFromWelcome() to not automatically send a self-update commit, which was causing the joining member to fork if there are pending commits

## 0.1.0

### Minor Changes

- fe652b3: Initial release

### Patch Changes

- 3cb464f: Add Bun and Deno runtime support to package.json engines field
