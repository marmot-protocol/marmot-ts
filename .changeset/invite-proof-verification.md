---
"@internet-privacy/marmot-ts": minor
---

The invite proposal now verifies an invitee's marmot.account-identity-proof.v1 LeafNode extension when present, rejecting forged proofs before the member is added (leaves without the proof remain allowed for backwards compatibility).
