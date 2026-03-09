# @internet-privacy/marmot-ts

## 0.4.1

### Patch Changes

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
