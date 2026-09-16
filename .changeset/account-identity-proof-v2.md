---
"@internet-privacy/marmot-ts": major
---

KeyPackages and member leaves now carry `marmot.member.account-identity-proof.v2` (app
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
