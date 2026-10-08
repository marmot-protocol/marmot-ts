---
"@internet-privacy/marmot-ts": minor
---

KeyPackage events no longer carry a `relays` tag. The spec says KeyPackage events do not repeat
the publishing relays (`transports/nostr.md`, KeyPackage publication), since peers find them
through the author's kind 10002 list. `KeyPackageManager` now records the publish relays in its
local store (`relays` on stored and listed key packages), and `rotate()` and `purge()` use that
record. They fall back to the `relays` tag of events published by older versions. `purge()`
accepts `{ relays }` for key packages tracked from another device. The `relays` option of
`createKeyPackageEvent` is deprecated and ignored.
