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

See "Migrating to account identity proof v2 (0x8009)" in `docs/client/best-practices.md` for
the republish/purge path and the rest of the migration story.
