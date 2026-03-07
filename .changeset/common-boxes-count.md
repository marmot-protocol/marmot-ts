---
"@internet-privacy/marmot-ts": patch
---

`KeyPackageManager.track` and `purge` now handle both legacy kind 443 and new kind 30443 events; `createDeleteKeyPackageEvent` generates `a`+`e` deletion tags for addressable events; `inviteByKeyPackageEvent` accepts both kind 443 and kind 30443 key package events
