# @internet-privacy/marmot-ts

## Unreleased

- Cancelling an image replacement or closing its image service now stops queued and preparing MLS image changes before publication, while ordinary group operations remain usable. Image changes already being published retain their publication outcome.

- Keep verified image bytes intact when a cache entry is replaced or evicted while a read is awaiting contact policy; cancelled and closed reads release their private plaintext.

- Group destruction now waits for admitted lifecycle storage writes and refuses stale disband, lifecycle enablement, leave, and publication work, preventing deleted groups from recreating local data or publishing a terminal commit after closure.

### Added

- Follow the dedicated [Group images guide](docs/client/group-images.md) for explicit Blossom configuration, verified reads, cancellation, replacement and snapshot-safe display.
- Clear encrypted Blossom image metadata while preserving URL avatars. Clear leaves remote blobs and previously shared upload credentials intact; remote deletion and credential revocation require application/service policy.
- Replace and clear encrypted group images through the normal MLS confirmation workflow, and retrieve verified image bytes through `MarmotGroup.image` using explicit application endpoints.
- Encode, encrypt and authenticate encrypted Blossom group-image metadata through pure core helpers, with independent image credentials and ciphertext integrity checks.
- Read a canonical group image source that preserves URL-avatar precedence and identifies complete Blossom metadata snapshots without downloading image bytes.
- Import `marmotAuthService` from the root or `/core` entrypoint for MLS basic-credential identity and curve validation. Account-proof binding and group authorization remain separate Marmot checks.
- Use `MarmotGroupEngine` from the engine entrypoint to manage group state without a Nostr transport, with changes applied after successful publication.
- Use `GroupSession`, `MarmotGroup.session`, and `MarmotGroup.runtime` for direct control over group send, receive, persistence, and publication. `GroupsManager` adds session and runtime helpers, including Welcome delivery.
- Encrypt and decrypt group media with `GroupMediaService`, including a cache for decrypted media.
- Enable optional forensic audit logging to investigate group activity.
- Check group compatibility through `profileSupport` and identify older KeyPackages through `ListedKeyPackage.nonCurrent`.
- Receive account identity proof rejection details and group removal or disband notifications during recovery.

### Changed

- Group image replacements and clears share a bounded FIFO queue tied to the loaded group instance. Unloading or destroying a group closes its image service and prevents queued changes from reaching a replacement instance.

- Encrypted group-image reads share work only across compatible caller profiles, keep cancellation independent, and cache verified plaintext in bounded memory. Cached and shared results recheck current policy and canonical image metadata before delivery.

- Encrypted group-image HTTP operations reject redirects and malformed upload descriptors, enforce streaming byte and time limits, and use narrowly scoped image credentials with explicit contact policy checks.

- New KeyPackages advertise encrypted group-image support. Recovery validates image metadata and parent-admin authority, and authorized commits can atomically unrequire and remove optional image metadata.

- Direct session/facade commits that change encrypted group images now require `expectedParent: group.session.parentToken`, captured before upload or other asynchronous preparation. Stale replacements are refused after convergence waits; ordinary commits keep the existing contract.

- Application messages include an exact NIP-40 expiration hint computed with checked bigint arithmetic from the inner timestamp and source epoch's retention policy. Missing or disabled retention, invalid timestamps and overflowing sums omit the hint; commits and proposals remain untagged. Retries preserve the original signed event even after policy changes.
- Fork invalidations include strict rumor and transport IDs plus the losing state's producing commit when known. Delivered evidence survives restarts when both ingestion-state and rewind stores are persisted; older messages without ledger evidence remain unattributable.
- `GroupsManager.connect()` and `connectAll()` fetch a group's kind 445 backlog in pages and, after a relay's first complete backfill, only from that relay's cursor (minus a slack window); the live subscription starts a slack window before the backfill. Cursors are stored in `ingestStateStore`, so pass a durable one to keep reconnects cheap across restarts. A relay that fails or stays incomplete re-reads its own window on the next connect without holding back the others, and a backfill that hits the page cap resumes below the range already read. A cursor does not advance past events the group still holds only in memory (unless they are dated more than seven days before the newest event), or when a relay answers outside the requested window or may have truncated a one-second page. Tune with the new `backfillSlackSeconds`, `backfillPageSize`, and `backfillMaxPages` connect options. The network adapter's `request` must reject when a relay fails or times out.
- Bundle the forked MLS implementation with the library. Import MLS primitives from `@internet-privacy/marmot-ts/mls`; additional cryptographic backends are optional dependencies needed only for their ciphersuites.
- Sign account identity proofs with the client's own signer using the current `0x8009` member proof format.

### Fixed

- Reject malformed encrypted group-image metadata in Welcome invitations before saving a group or consuming its single-use KeyPackage, including optional image components. Valid present and cleared images remain supported.

- Closing a group-image service also cancels active uploads and queued image changes, wipes owned plaintext buffers, and prevents late callbacks from delivering an image after closure.
- Unloaded sessions refuse delayed storage writes and notifications; publication results refuse late Welcome completion after the owning group closes.

- Image changes recheck current admin membership, profile, canonical parent and lifecycle after uploads and during MLS preparation. Closed groups abort image uploads and refuse late publication or persistence completion.

- Refuse encrypted group-image proposals, clears and removals from non-admin members, prevent an admin commit from accepting a referenced image proposal authored by a non-admin, and reject malformed image metadata carried forward by a commit.

- Destroying or successfully leaving a group deletes its plaintext delivery ledger and pending retractions, and fences delayed saves so cleanup cannot recreate them.
- Keep canonical history rumors visible when another transport delivery of the same rumor loses convergence, including restored pending retractions.
- Preserve every losing-branch history retraction across interrupted multi-message rewinds and retry outstanding removals after restart.
- Preserve write-ahead terminal convergence evidence before saving rewind history, so interrupted history writes remain recoverable after restart.
- Losing-branch rumors are durably retracted from supported history and live timelines refresh from filtered snapshots, including limited-page refill.
- Group watches accept an `AbortSignal`, finish promptly when cancelled or returned while idle or loading, and retain updates racing with snapshots.
- Serialize connected group ingestion across backfill and live subscriptions, drain admitted work after disconnect, and forward live and timer-driven convergence results through `groups.on("ingestResult", ...)`. Connection options now accept an `AbortSignal` to cancel pending backfill.
- Accept proposal builders returning one or several proposals for ordinary commits and founding Adds, preserving their order and rejecting invalid results before publication.
- Authenticate the real Welcome author and require active admin membership in a fully validated group before saving it. Rejected and duplicate invitations preserve existing group state and KeyPackage material.
- Retire single-use KeyPackage private material after validated durable group adoption, retaining public metadata for rotation and purge. Receipts finish interrupted cleanup after restart or `keyPackages.finalizeConsumptions()`; reusable packages retain their keys for later joins and use the canonical empty-data component marker.
- Publish KeyPackage proposal tags that match the advertised proposals, including GREASE values, so MDK accepts them. Reject missing, malformed, or mismatched proposal tags when selecting invite candidates; matching older tags without GREASE remain supported.
- Validate member identity proofs during sends, ingestion, and fork recovery, preventing invalid membership changes from being accepted.
- Authorize commits against their parent state, including during fork recovery and when an admin is demoted earlier in an ingestion batch.
- Keep admin restrictions enforced when optional group metadata is malformed, and reject invalid group component updates before applying them.

### Breaking changes

- Reusable KeyPackages require the canonical empty-data `0x0004` component in the KeyPackage dictionary; legacy-only `0x000a` markers are deliberately rejected. Generate and republish current packages. Publications omit relay tags; destinations are retained locally across restarts for rotation and purge. Older route-less records need explicit rotation routes or locally supplied tracking routes for cleanup.
- Publication identifiers (`clientId`, `identifier`, and rotation `d`) must be exactly 64 lowercase hex characters and invalid values reject before side effects. Generate 32 random bytes once, encode as lowercase hex and persist that slot instead of a device label. Publish under the new slot, then delete the old publication through known routes: a different `d` does not replace the old address. See the [publication slot migration](docs/core/key-packages.md#publication-slot-migration) for the create/purge and rotation paths.
- Custom `GroupSessionHistory`/`BaseGroupHistory` implementations must implement idempotent `removeMessage(rumorId)`; custom `GroupRumorHistoryBackend` implementations must implement durable `removeRumor(rumorId)`. Remove by the canonical inner ID and resolve only after persistence succeeds.
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
