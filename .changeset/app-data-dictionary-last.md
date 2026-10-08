---
"@internet-privacy/marmot-ts": patch
---

Create groups with `app_data_dictionary` as the last GroupContext extension, after
`required_capabilities`, matching MDK. OpenMLS applies an AppDataUpdate by re-appending the
dictionary, while ts-mls replaces it in place, so when the dictionary was not last the two
computed different GroupContexts and MDK/White Noise rejected every AppDataUpdate commit from
marmot-ts (rename, admin, relay changes) with a confirmation tag mismatch, stranding those
members on the old epoch. Groups created by earlier versions keep the old order and stay
affected.
