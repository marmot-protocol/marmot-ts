---
"@internet-privacy/marmot-ts": patch
---

Authorize every proposal against its own sender, as MDK does (`authorize_proposal`). In v1 a
non-admin may only send SelfRemove, and an admin may not send SelfRemove until it has left the
admin set. Before this change marmot-ts staged any member's standalone Add, Remove, Update,
GroupContextExtensions or AppDataUpdate. A marmot-ts admin's next commit then bundled it by
reference, MDK/White Noise members rejected that commit, and the group split. Inbound standalone
proposals and every proposal a commit carries (by reference or inline) are now checked against
their sender, already-staged proposals that fail the check are dropped from local commits, and
`send({ kind: "proposal" })` throws the new `ProposalAuthorizationError` instead of publishing a
proposal every peer refuses. As a result `groups.leave()` by an active admin now throws before
publishing or deleting anything. Previously it published a SelfRemove that every peer rejected
and then destroyed the local group, so the admin stayed in the group for everyone else.
