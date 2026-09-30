# @internet-privacy/marmot-ts

## 1.0.0

### Major Changes

- 32c6d22: KeyPackages and member leaves now carry `marmot.member.account-identity-proof.v2` (app
  component `0x8009`, a 104-byte `MarmotAuthorizationProof`) signed by the client's own signer
  through `signEvent`. The legacy `marmot.account-identity-proof.v2` custom LeafNode extension
  (`0xf2f1`) is neither emitted nor accepted anywhere in the library, and every new group
  requires `0x8009`.

  ## Breaking changes
  - The proof-signer option is removed from `MarmotClientOptions`, `GroupsManagerOptions`
    (and the corresponding `GroupsManager` public field), `GroupFactoryOptions`,
    `KeyPackageManagerOptions`, and `KeyPackagePublisherOptions` — the client's own signer is
    used to sign the `0x8009` proof, so there is no separate proof-signer option anywhere.
  - `generateKeyPackage` now requires a `signer` and accepts an optional `createdAt`.
  - `makeLeafAppComponentsExtension` now requires the encoded `0x8009` proof.
  - `ensureMarmotCapabilities` and `marmotRequiredCapabilitiesExtension` no longer
    advertise/require the legacy `0xf2f1` extension.
  - Joining a group that requires the legacy `0xf2f1` extension, or that does not require
    `0x8009`, throws `AccountIdentityProofError`.
  - Commits whose resulting epoch drops the `0x8009` requirement, or that add or re-sign a
    member leaf without a valid `0x8009` proof, are refused on every legality seam with the
    same structured verdict (`reason: "account-identity-proof"` plus `proofReason` /
    `leafIndex`): send throws `CommitLegalityError`; inbound ingest, fork-recovery pool replay,
    and the ingestion-pool sweep yield `rejected` with that reason; tree-fed convergence has no
    triggering envelope, so it never adopts such a commit: a branch containing one competes only
    as its legal prefix (the chain up to the last valid commit), matching pool replay and MDK,
    and is dropped only when its first commit is invalid.
  - `createAdminCommitPolicyCallback` now rejects an Add with no proof material. Standalone Add
    proposals are validated before they are staged: inbound yields `rejected` with
    `account-identity-proof`, and local `send({ kind: "proposal" })` throws
    `AccountIdentityProofError`. An admin-callback rejection caused by an invalid Add proof is
    reported as `account-identity-proof` instead of `admin-policy`.
  - `ForkRecovery.resolveFork` (`@internet-privacy/marmot-ts/engine`) takes
    `adminCallbackFor: (parent) => IncomingMessageCallback` instead of a single
    `adminCallback`. It is invoked for every explored parent state, so each fork candidate is
    authorized against its own parent rather than the current canonical tip. Inbound ingest
    likewise authorizes every message against the state it is processed on, so a commit from an
    admin demoted earlier in the same batch is rejected.
  - Admin-only-commit enforcement reads only the `admin_policy` component. A malformed optional
    component (avatar, media, retention, ...) no longer switches the admin gate to accept-all;
    a group with no `admin_policy` has an empty admin set; an undecodable `admin_policy` refuses
    every commit. Inbound AppDataUpdate proposals, standalone or carried by a commit, whose
    payload does not decode for a known component are `rejected` with `component-integrity`
    before they are staged or applied (`validatePreApplyProposals`, exported from
    `@internet-privacy/marmot-ts/engine`).
  - Widened unions — an exhaustive `switch` (for example one with a `never` default) must handle
    the new members:
    - `SkippedIngestResult.reason` gains `"unsupported-profile"`.
    - `RejectedIngestResult.reason` gains `"account-identity-proof"`.
    - The exported `CommitIntegrityViolationReason` gains `"account-identity-proof"`.
  - `ingest()` can now yield `kind: "rejected"` for a standalone proposal (an invalid Add, or
    an AppDataUpdate whose payload does not decode), not only for a commit. Do not assume a
    `rejected` result carries a commit; inspect `message` if the distinction matters.
  - Stored groups outside the current profile load but refuse all traffic (this supersedes the
    earlier "load untouched" behavior).
  - The following 15 legacy runtime exports are removed: `ACCOUNT_IDENTITY_PROOF_EVENT_KIND`,
    `ACCOUNT_IDENTITY_PROOF_EXTENSION_TYPE`, `accountIdentityProofEventId`,
    `accountIdentityProofEventJson`, `accountIdentityProofSignatureFromSignedEvent`,
    `accountIdentityProofSigningDigest`, `buildAccountIdentityProofEvent`,
    `buildAccountIdentityProofExtension`, `decodeAccountIdentityProof`,
    `encodeAccountIdentityProof`, `makeAccountIdentityProofExtension`, `mlsSignatureScheme`,
    `signAccountIdentityProof`, `verifyAllLeafAccountIdentityProofs`,
    `verifyLeafAccountIdentityProof`.

  ## Added
  - 13 new runtime exports for the `0x8009` proof class: `ACCOUNT_IDENTITY_PROOF_COMPONENT`,
    `ACCOUNT_IDENTITY_PROOF_COMPONENT_ID`, `AccountIdentityProofError`,
    `accountIdentityProofTemplate`, `assertCurrentGroupAccountIdentityProofProfile`,
    `assertNoAccountIdentityProofComponent`, `classifyGroupAccountIdentityProofProfile`,
    `hasAccountIdentityProofMaterial`, `mlsSignatureSchemeForCiphersuite`,
    `produceAccountIdentityProof`, `validateGroupMemberAccountIdentityProofs`,
    `validateKeyPackageAccountIdentityProof`, `validateLeafAccountIdentityProof`.
  - `ListedKeyPackage.nonCurrent` — set on any stored KeyPackage listing that lacks a valid
    current `0x8009` proof (for example one published by a pre-v2 release). The flag is
    informational: `KeyPackageManager.ensurePublished` skips such entries when deciding
    whether to publish a fresh KeyPackage, but they are never removed automatically, their
    kind-30443 events stay discoverable on relays (peers' invites that pick them fail), and
    `selectForWelcome` still offers them as Welcome candidates. Call `purge()` on them to
    publish the NIP-09 deletion.
  - `diffChangedLeaves`, `getGroupProfileSupport`, `validateAddProposalAccountIdentityProofs`,
    and `validateCommitAccountIdentityProofs` — the tree-diff and profile/proof primitives
    behind the legality-seam extension above.
  - The `GroupProfileSupport` type, and a `profileSupport` getter on `MarmotGroup`,
    `GroupSession`, and `MarmotGroupEngine` reporting `{ kind: "supported" }` or
    `{ kind: "unsupported", proofReason }` for a group's current GroupContext.
  - `UnsupportedGroupProfileError` (exported from `@internet-privacy/marmot-ts/engine`), thrown
    by every outbound send on a group outside the current profile.
  - Optional `proofReason` / `leafIndex` fields on `CommitIntegrityViolation` and
    `RejectedIngestResult`, populated for `reason: "account-identity-proof"`.
  - Optional `selectedTerminal` / `removedFromGroup` fields on
    `AppliedNotificationsIngestResult`, populated by the envelope-free rewind paths (pool
    replay and tree-fed re-convergence) so a direct `@internet-privacy/marmot-ts/engine`
    consumer can observe a disband selection or its own removal without re-reading engine
    state. A rewind that produced no notifications still yields no result at all, so a
    consumer that must not miss those facts should re-read `selectedDisbandEvidence` and
    `state.groupActiveState` after draining `ingest()`.
  - `validatePreApplyProposals` takes an optional third argument — the parent epoch's required
    app-component ids, via the new `requiredComponentIdsOf` — and now enforces the rest of
    MDK's AppDataUpdate batch rules: at most one operation per component id, `app_components`
    (`0x1`) is never removable, Remove legality is measured against the resulting required
    list, and any update to `0x2` (safe_aad) or `0x8009` (leaf-only account identity proof) is
    refused. `createAdminCommitPolicyCallback` takes a matching optional `requiredIds`. Both
    default to the previous behavior when omitted, and the same gate now also runs on the
    outbound commit and proposal seams, where `send()` throws `CommitLegalityError`.

  See "Migrating to account identity proof v2 (0x8009)" in `docs/client/best-practices.md` for
  the republish/purge path and the rest of the migration story, including how to find and
  `destroy()` a stored group outside the current profile.

### Minor Changes

- 668d53f: Add `GroupSession` as the protocol state owner for group send, ingest, and persistence effects.
- be60778: Add `GroupsManager` session and runtime helpers for effect-driven group workflows.
- cbf4438: Add opt-in Marmot forensic audit log recording support
- 6ab60af: Expose `MarmotGroup.session` and `MarmotGroup.runtime` for direct effect-driven group workflows.
- a746255: Extract MarmotGroupEngine from MarmotGroup as a transport-agnostic CGKA state machine with publish-before-apply lifecycle, exposed from the core package.
- 6c4583d: Add `GroupMediaService` for group encrypted media helpers and decrypted media caching.
- c9b157c: Add group runtime and Nostr Welcome delivery seams for publishing group session effects.

### Patch Changes

- 56cce59: The package now bundles the compiled forked ts-mls build under `dist/vendor/ts-mls`
  instead of depending on a `ts-mls` package. Import MLS primitives from
  `@internet-privacy/marmot-ts/mls`. The X448, ChaCha20-Poly1305, ML-KEM, X-Wing and
  ML-DSA backends are now optional peer dependencies, needed only for those ciphersuites.

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
