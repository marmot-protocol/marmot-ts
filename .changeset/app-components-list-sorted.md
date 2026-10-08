---
"@internet-privacy/marmot-ts": patch
---

Reject an `app_components` (`0x0001`) list whose ids are not in ascending order. MDK rejects such
lists, so accepting them let a GroupContext, LeafNode, or KeyPackage be valid here and invalid for
White Noise members.
