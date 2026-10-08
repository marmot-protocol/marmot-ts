---
"@internet-privacy/marmot-ts": patch
---

Groups created with `app_data_dictionary` before `required_capabilities` (every group made by
marmot-ts so far) can now be renamed and have their admins, relays or other components
changed without breaking MDK/White Noise members. ts-mls applies an AppDataUpdate in place
while OpenMLS re-appends the dictionary, so the two computed different GroupContexts and MDK
rejected the commit with a confirmation tag mismatch. When an admin commits an AppDataUpdate
in such a group, the commit now also carries a GroupContextExtensions proposal that moves the
dictionary last. MDK, current marmot-ts and older marmot-ts all read that commit the same
way, and later AppDataUpdates need no repair. Groups that already split on an earlier
AppDataUpdate are not recovered by this change.
