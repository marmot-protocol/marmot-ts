---
"@internet-privacy/marmot-ts": patch
---

Reject a kind-30443 KeyPackage event whose tags do not describe its KeyPackage before inviting from
it: the `i` tag must be the KeyPackageRef, and `mls_ciphersuite`, `mls_extensions`, `mls_proposals`
and `app_components` must each appear once and match the decoded LeafNode. MDK / White Noise
already rejects these events; marmot-ts used them. Adds `validateKeyPackageEventMetadata` and
`KeyPackageEventMetadataError`.
