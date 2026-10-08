---
"@internet-privacy/marmot-ts": patch
---

An application message read after a commit that removed its sender is now delivered instead of
being dropped as `invalid-app-payload`. The sender's account identity was looked up in the
current ratchet tree, where the removed member's leaf is blank; it now comes from the tree of
the epoch the message was sent in, as MDK does. This mattered most for a member's last message
before leaving or being removed, which often arrives in the same batch as the removal commit.
`isAuthenticApplicationMessage` takes an optional `messageEpoch` argument.
