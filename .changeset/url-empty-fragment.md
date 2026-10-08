---
"@internet-privacy/marmot-ts": patch
---

Reject URLs with an empty fragment (a trailing `#`) in avatar URLs, encrypted-media endpoints, and
Nostr routing relays. `URL.hash` is empty for them, so the old check let them through, but MDK
rejects them; a group created with such an avatar could not be joined by White Noise users.
